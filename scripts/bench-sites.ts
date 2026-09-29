/**
 * End-to-end check across three structurally different sites.
 *
 * The point is not that the pipeline runs - it is that nothing in it is
 * specialised for a particular site. Each of these three presents a different
 * structural problem, so a run that passes on all three is evidence the
 * extraction generalises rather than fits:
 *
 *   news.ycombinator.com   almost no visual design and no sections at all: one
 *                          flat list of 30 tiny rows. Proves the item detector
 *                          works on a table-like run and that a page with no
 *                          real "sections" still produces a coherent site.
 *   developer.mozilla.org  long, dense, content-first documentation portal with
 *                          deep link trees. Proves the chrome and footer
 *                          synthesis cope with hundreds of links.
 *   www.nasa.gov           image-heavy marketing homepage with alternating
 *                          band backgrounds. Proves the geometric band
 *                          splitter, the theme measurement and asset handling.
 *
 * Usage: npx tsx scripts/bench-sites.ts [url ...]
 */

import { runPipeline } from "../src/lib/store/pipeline";
import { config } from "../src/lib/config";

const DEFAULT_SITES = [
  "https://news.ycombinator.com",
  "https://developer.mozilla.org",
  "https://www.nasa.gov",
];

async function main(): Promise<void> {
  const sites = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const urls = sites.length ? sites : DEFAULT_SITES;
  const results: {
    url: string;
    status: string;
    seconds: number;
    sections: number;
    kinds: string;
    assets: string;
    build: string;
    model: string;
    error?: string;
  }[] = [];

  for (const url of urls) {
    process.stdout.write(`\n=== ${url} ${"=".repeat(Math.max(0, 60 - url.length))}\n`);
    const started = Date.now();
    try {
      // A fresh process per site would be the strict test, but model discovery
      // and the pricing lookup are cached for the process lifetime, which is
      // exactly how a long-lived control panel behaves. Running them in one
      // process is therefore the realistic configuration.
      const { record } = await runPipeline({ url });
      const seconds = (Date.now() - started) / 1000;
      results.push({
        url,
        status: record.status,
        seconds,
        sections: record.sectionCount,
        kinds: record.sectionKinds.join(", "),
        assets: `${record.assets.downloaded}/${record.assets.total} (${record.assets.missing} missing)`,
        build: record.build
          ? `${record.build.ok ? "ok" : "failed"} in ${(record.build.durationMs / 1000).toFixed(1)}s${
              record.build.attempts > 1 ? ` after ${record.build.attempts} attempts` : ""
            }`
          : "not run",
        model: record.modelTrail.join(" -> ") || "-",
      });
      process.stdout.write(
        `   ${record.status}  ${seconds.toFixed(1)}s  ${record.sectionCount} sections  ` +
          `${record.assets.downloaded} assets  build ${record.build?.ok ? "ok" : "failed"}\n`,
      );
    } catch (error) {
      const seconds = (Date.now() - started) / 1000;
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        url,
        status: "failed",
        seconds,
        sections: 0,
        kinds: "",
        assets: "",
        build: "",
        model: "",
        error: message,
      });
      process.stdout.write(`   FAILED after ${seconds.toFixed(1)}s: ${message}\n`);
    }
  }

  process.stdout.write(`\n${"=".repeat(72)}\nSUMMARY\n${"=".repeat(72)}\n`);
  for (const r of results) {
    process.stdout.write(
      `${r.status === "ready" ? "pass" : "FAIL"}  ${r.url}\n` +
        `      ${r.seconds.toFixed(1)}s  ${r.sections} sections: ${r.kinds}\n` +
        `      assets ${r.assets}  build ${r.build}  model ${r.model}\n` +
        (r.error ? `      error: ${r.error}\n` : ""),
    );
  }
  const passed = results.filter((r) => r.status === "ready").length;
  process.stdout.write(`\n${passed}/${results.length} produced a buildable site\n`);
  process.stdout.write(`projects in ${config().generatedDir}\n`);
  if (passed < results.length) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
