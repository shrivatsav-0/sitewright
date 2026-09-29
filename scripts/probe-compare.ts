/**
 * Structural diff between a generated site and its source.
 *
 *   npx tsx scripts/probe-compare.ts <source-url>
 *
 * Measures both pages with one instrument — the same in-page function against
 * the original and against the running clone preview — and prints the two sets
 * of numbers side by side.
 *
 * This is the check that actually matters. A screenshot comparison needs a human
 * or a vision model; a structural diff is exact, runs in a second, and catches
 * the failures that are easy to miss by eye (a missing section, a font that
 * never got applied, a colour that fell back to the default).
 */

import { chromium } from "playwright";
import { normaliseInput } from "../src/lib/security";

/** Runs in the page. Kept as a string for the same reason the extractor is. */
const MEASURE = `(() => {
  const cs = (el) => getComputedStyle(el);
  const visible = (el) => {
    const s = cs(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const text = (el, n) => (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, n);
  /**
   * Visible text only.
   *
   * body.textContent also returns the contents of every script element, so
   * on a Next.js page it includes the whole serialised RSC payload, about
   * double the real copy, and nothing to do with the reconstruction. Clone
   * nodes are removed before counting.
   */
  const visibleText = () => {
    const c = document.body.cloneNode(true);
    c.querySelectorAll("script,style,noscript,template,svg").forEach((n) => n.remove());
    return (c.textContent || "").replace(/\\s+/g, " ").trim();
  };
  const topOf = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => k + " x" + v);

  const colors = new Map();
  const bgs = new Map();
  const fonts = new Map();
  const fontSizes = new Map();
  for (const el of Array.from(document.body.querySelectorAll("*")).filter(visible).slice(0, 4000)) {
    const s = cs(el);
    colors.set(s.color, (colors.get(s.color) || 0) + 1);
    if (s.backgroundColor !== "rgba(0, 0, 0, 0)") bgs.set(s.backgroundColor, (bgs.get(s.backgroundColor) || 0) + 1);
    fonts.set(s.fontFamily.split(",")[0].replace(/["']/g, ""), (fonts.get(s.fontFamily.split(",")[0].replace(/["']/g, "")) || 0) + 1);
    if (el.childElementCount === 0 && text(el, 1)) {
      const fs = Math.round(parseFloat(s.fontSize));
      fontSizes.set(fs + "px", (fontSizes.get(fs + "px") || 0) + 1);
    }
  }

  const imgs = Array.from(document.images).filter(visible);
  const brokenImgs = imgs.filter((i) => i.complete && i.naturalWidth === 0);
  const h = (n) => document.querySelectorAll("h" + n).length;
  const landmarks = (sel) => document.querySelectorAll(sel).length;

  return {
    height: document.body.scrollHeight,
    title: document.title.slice(0, 60),
    headings: { h1: h(1), h2: h(2), h3: h(3), h4plus: h(4) + h(5) + h(6) },
    landmarks: {
      header: landmarks("header"),
      nav: landmarks("nav"),
      main: landmarks("main"),
      footer: landmarks("footer"),
      section: landmarks("section"),
      article: landmarks("article"),
    },
    textChars: visibleText().length,
    paragraphs: document.querySelectorAll("p").length,
    lists: document.querySelectorAll("ul,ol").length,
    listItems: document.querySelectorAll("li").length,
    links: document.querySelectorAll("a[href]").length,
    buttons: landmarks("button") + document.querySelectorAll("a[class*=btn],a[class*=button]").length,
    forms: document.querySelectorAll("form").length,
    images: { total: imgs.length, broken: brokenImgs.length, lazy: document.querySelectorAll("img[loading=lazy]").length },
    topColors: topOf(colors),
    topBackgrounds: topOf(bgs),
    topFonts: topOf(fonts),
    topFontSizes: topOf(fontSizes),
  };
})()`;

function fmt(value: unknown): string {
  if (value === undefined) return "-";
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function compare(a: Record<string, unknown>, b: Record<string, unknown>): string {
  const lines: string[] = [];
  const walk = (x: unknown, y: unknown, prefix: string) => {
    if (x && typeof x === "object" && y && typeof y === "object" && !Array.isArray(x)) {
      for (const k of Object.keys(x as object)) {
        walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k);
      }
      return;
    }
    const xs = fmt(x);
    const ys = fmt(y);
    if (xs === ys) return;
    const sameKind = typeof x === typeof y;
    lines.push(`${sameKind ? " " : "!"} ${prefix.padEnd(22)} clone=${trunc(xs, 58).padEnd(58)} source=${trunc(ys, 40)}`);
  };
  walk(a, b, "");
  return lines.join("\n");
}

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

async function measure(page: import("playwright").Page, url: string, waitUntil: "networkidle" | "domcontentloaded") {
  await page.goto(url, { waitUntil, timeout: 45000 });
  await page.waitForTimeout(waitUntil === "networkidle" ? 700 : 3000);
  return (await page.evaluate(MEASURE)) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) {
    process.stderr.write("usage: probe-compare <source-url>\n");
    process.exit(2);
  }
  let port = 0;
  for (let p = 4320; p <= 4339 && !port; p++) {
    const res = await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(1500) }).catch(() => null);
    if (res?.ok) {
      const html = await res.text().catch(() => "");
      if (html.includes("sw-container") || html.includes("sw-header")) port = p;
    }
  }
  if (!port) throw new Error("no generated-site preview is running on ports 4320-4339");

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const clone = await measure(page, `http://127.0.0.1:${port}/`, "networkidle");
    await ctx.close();
    const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page2 = await ctx2.newPage();
    const source = await measure(page2, normaliseInput(url).href, "domcontentloaded");
    await ctx2.close();

    process.stdout.write(`\nclone  http://127.0.0.1:${port}\nsource ${url}\n\n`);
    process.stdout.write(`${compare(clone, source)}\n\n`);
    process.stdout.write("legend: ' ' = equal, '!' = differs in type or shape\n");
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  process.stderr.write(`${String(e)}\n`);
  process.exit(1);
});
