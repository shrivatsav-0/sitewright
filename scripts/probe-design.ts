/**
 * One-off diagnostic: what does the extractor actually measure as the design?
 *
 *   npx tsx scripts/probe-design.ts <url>
 *
 * Prints the raw `design` observations and the derived theme side by side, so a
 * wrong token (a UA-default link blue becoming the brand colour, a 2.4
 * line-height, a flat radius scale) can be traced to the measurement that
 * produced it rather than guessed at from the rendered page.
 */

import { Crawler } from "../src/lib/crawler/browser";
import { normaliseInput } from "../src/lib/security";
import { buildTheme } from "../src/lib/analyzer/normalize";
import fsp from "node:fs/promises";

async function main(): Promise<void> {
  const url = process.argv[2] ?? "https://example.com";
  const target = normaliseInput(url);
  const outDir = "/tmp/opencode/probe-shots";
  await fsp.mkdir(outDir, { recursive: true });
  const crawler = await Crawler.launch();
  try {
    const a = await crawler.analyse(target, outDir);
    const d = a.page.design as Record<string, unknown>;
    process.stdout.write(`\nURL ${a.finalUrl}\n\n--- observed ---------------------------------------------\n`);
    for (const key of [
      "bodyBackground",
      "bodyColor",
      "bodyFont",
      "bodyFontSize",
      "colorCandidates",
      "backgroundCandidates",
      "fontCandidates",
      "sizeCandidates",
      "radiusCandidates",
      "shadowCandidates",
      "borderCandidates",
      "paddingCandidates",
      "containerWidth",
    ]) {
      process.stdout.write(`${key.padEnd(22)} ${JSON.stringify(d[key])}\n`);
    }
    process.stdout.write(`headings                ${JSON.stringify(d.headings, null, 1)}\n`);

    process.stdout.write(`\n--- derived theme ------------------------------------------\n`);
    process.stdout.write(`${JSON.stringify(buildTheme(a.page), null, 1)}\n`);
  } finally {
    await crawler.close();
  }
}

main().catch((e) => {
  process.stderr.write(`${String(e)}\n`);
  process.exit(1);
});
