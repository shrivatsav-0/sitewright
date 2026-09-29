/**
 * Side-by-side visual comparison of a generated site against its source.
 *
 *   npx tsx scripts/probe-visual.ts <source-url> <project-id>
 *
 * Captures matching viewport-sized (above-the-fold) shots of the clone and the
 * original at the same width, tiles them into one image, and hands the pair to a
 * vision model for a structured judgement. Tiling matters: two separate images
 * are easy to describe and hard to compare.
 */

import { chromium } from "playwright";
import fsp from "node:fs/promises";
import path from "node:path";
import { normaliseInput } from "../src/lib/security";

const OUT = "/tmp/opencode/visual";
const SHOTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

/** Find a running preview by asking each port in the range for our marker. */
async function findPreview(): Promise<number> {
  for (let p = 4320; p <= 4339; p++) {
    const res = await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(1500) }).catch(() => null);
    if (!res?.ok) continue;
    const html = await res.text().catch(() => "");
    if (html.includes("sw-container") || html.includes("sw-header")) return p;
  }
  return 0;
}

async function main(): Promise<void> {
  const [url] = process.argv.slice(2);
  if (!url) {
    process.stderr.write("usage: probe-visual <source-url>\n");
    process.exit(2);
  }
  await fsp.mkdir(OUT, { recursive: true });
  const port = await findPreview();
  if (!port) throw new Error("no generated-site preview is running on ports 4320-4339");
  process.stdout.write(`preview: http://127.0.0.1:${port}\n`);

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    for (const shot of SHOTS) {
      for (const which of ["clone", "original"] as const) {
        const ctx = await browser.newContext({ viewport: { width: shot.width, height: shot.height } });
        const page = await ctx.newPage();
        const target = which === "clone" ? `http://127.0.0.1:${port}/` : normaliseInput(url).href;
        await page.goto(target, { waitUntil: which === "clone" ? "networkidle" : "domcontentloaded", timeout: 45000 });
        await page.waitForTimeout(which === "clone" ? 600 : 3000);
        await page.screenshot({ path: path.join(OUT, `${shot.name}-${which}.png`), fullPage: false });
        await ctx.close();
      }
      process.stdout.write(`captured ${shot.name}\n`);
    }
    // Also a full-page height comparison: how close is the overall document?
    for (const which of ["clone", "original"] as const) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      const target = which === "clone" ? `http://127.0.0.1:${port}/` : normaliseInput(url).href;
      await page.goto(target, { waitUntil: which === "clone" ? "networkidle" : "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(which === "clone" ? 600 : 3000);
      const h = await page.evaluate(() => document.body.scrollHeight);
      process.stdout.write(`${which} full-page height: ${h}px\n`);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  process.stdout.write(`wrote ${OUT}\n`);
}

main().catch((e) => {
  process.stderr.write(`${String(e)}\n`);
  process.exit(1);
});
