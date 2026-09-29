/**
 * One-off diagnostic: why is a repeated group not being detected as items?
 *
 *   npx tsx scripts/probe-items.ts <url>
 *
 * Re-implements the extractor's candidate filter in the page and reports, for
 * every element with 2+ visible children, which check rejected it.
 */

import { chromium } from "playwright";
import { normaliseInput } from "../src/lib/security";

const SOURCE = `(() => {
  const out = [];
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const isChrome = (el) =>
    !!el.closest("nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo]");

  for (const el of Array.from(document.querySelectorAll("*")).filter(visible)) {
    const kids = Array.from(el.children).filter(visible);
    if (kids.length < 2) continue;
    const s = getComputedStyle(el);
    const rects = kids.map((k) => k.getBoundingClientRect());
    const hs = rects.map((r) => r.height).sort((a, b) => a - b);
    const medianH = hs[Math.floor(hs.length / 2)] || 0;
    const ws = rects.map((r) => r.width);
    const tags = [...new Set(kids.map((k) => k.tagName))].join(",");
    const line =
      el.tagName.toLowerCase() +
      (typeof el.className === "string" && el.className ? "." + el.className.split(/\\s+/)[0] : "") +
      " display=" + s.display +
      " kids=" + kids.length +
      " tags=" + tags.slice(0, 20) +
      " medianH=" + Math.round(medianH) +
      " w=" + Math.round(ws[0]) +
      " chrome=" + isChrome(el);
    out.push(line);
  }
  return out;
})()`;

async function main(): Promise<void> {
  const url = process.argv[2] ?? "https://example.com";
  const target = normaliseInput(url);
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2000);
    const rows = (await page.evaluate(SOURCE)) as string[];
    process.stderr.write(`title=${await page.title()} rows=${rows.length}\n`);
    // Only the interesting shapes: three or more children.
    process.stdout.write(`${rows.filter((r) => Number(/kids=(\d+)/.exec(r)?.[1] ?? 0) >= 2).slice(0, 40).join("\n")}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  process.stderr.write(`${String(e)}\n`);
  process.exit(1);
});
