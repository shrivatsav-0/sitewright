/**
 * One-off diagnostic: dump the geometry of a page's element tree.
 *
 *   npx tsx scripts/probe-tree.ts <url>
 *
 * The in-page code is passed as a *string* for the same reason the real
 * extraction script is: a bundler transform would inject `__name(...)` helpers
 * that do not exist in the browser.
 */

import { chromium } from "playwright";
import { normaliseInput } from "../src/lib/security";

const TREE_SOURCE = `(() => {
  const out = [];
  const H = Math.max(document.body.scrollHeight, window.innerHeight);
  const walk = (el, depth) => {
    if (depth > 6) return;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    const kids = Array.from(el.children);
    const cls = typeof el.className === "string" ? "." + el.className.split(/\\s+/).slice(0, 2).join(".") : "";
    out.push(
      "  ".repeat(depth) + el.tagName.toLowerCase() + cls +
      " h=" + Math.round(r.height) + " w=" + Math.round(r.width) +
      " y=" + Math.round(r.top + window.scrollY) +
      " bg=" + s.backgroundColor + " kids=" + kids.length + " display=" + s.display,
    );
    for (const k of kids) {
      const kr = k.getBoundingClientRect();
      if (kr.height > 80) walk(k, depth + 1);
    }
  };
  out.push("pageHeight=" + H);
  for (const c of Array.from(document.body.children)) walk(c, 0);
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
    await page.waitForTimeout(2500);
    const tree = (await page.evaluate(TREE_SOURCE)) as string[];
    process.stdout.write(`${tree.join("\n")}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  process.stderr.write(`${String(e)}\n`);
  process.exit(1);
});
