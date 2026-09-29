/** One-off diagnostic: how many blocks does the extractor find, and what are they? */
import { Crawler } from "../src/lib/crawler/browser";
import { normaliseInput } from "../src/lib/security";
import { buildDigest, buildTheme } from "../src/lib/analyzer/normalize";
import fsp from "node:fs/promises";

async function main(): Promise<void> {
  const url = process.argv[2] ?? "https://example.com";
  const target = normaliseInput(url);
  const outDir = "/tmp/opencode/probe-shots";
  await fsp.mkdir(outDir, { recursive: true });
  const crawler = await Crawler.launch();
  try {
    const a = await crawler.analyse(target, outDir);
    const theme = buildTheme(a.page);
    const digest = buildDigest(a.page, theme);
    process.stdout.write(`\nURL         ${a.finalUrl}\n`);
    process.stdout.write(`scrollHeight ${a.page.viewport.scrollHeight}\n`);
    process.stdout.write(`counts      ${JSON.stringify(a.page.counts)}\n`);
    process.stdout.write(`digested blocks ${digest.sections.length}\n\n`);
    for (const s of digest.sections) {
      process.stdout.write(
        `${String(s.index).padStart(2)} ${String(s.height).padStart(5)}px ${String(s.tag).padEnd(8)} ${String(s.bg).padEnd(24)} items=${String(s.itemCount).padStart(2)} img=${s.imageCount} "${
          s.heading?.text ?? ""
        }"\n`,
      );
    }
    process.stdout.write(`\nmeasured raw sections: ${a.page.sections.length}\n`);
    for (const r of a.page.sections as any[]) {
      process.stdout.write(`  ${String(r.index).padStart(2)} h=${String(Math.round(r.height)).padStart(5)} ${r.selector} :: ${(r.textPreview ?? "").slice(0, 60).replace(/\n/g, " ")}\n`);
    }
  } finally {
    await crawler.close();
  }
}

main().catch((e) => {
  process.stderr.write(`${String(e)}\n`);
  process.exit(1);
});
