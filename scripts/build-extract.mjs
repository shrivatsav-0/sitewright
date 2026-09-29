/**
 * Regenerate the in-page extraction script.
 *
 *   npm run build:extract
 *
 * `src/lib/crawler/extract-script.ts` is the source of truth, but the function
 * has to be *serialised* into the browser, and a bundler transform breaks that:
 * esbuild's `keepNames` helper (`__name(...)`) does not exist in the page, so a
 * transformed function throws `ReferenceError: __name is not defined` on its
 * first line. This script compiles the TypeScript to a self-contained IIFE with
 * name-keeping off and writes the result to `extract-page.js`, which the crawler
 * reads as plain text at runtime.
 *
 * The generated file is committed, so a normal `npm install && npm run dev` does
 * not need this step. `tests/unit/extract-script.test.ts` regenerates and
 * compares, so drift fails the build rather than the browser.
 */

import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Compile the in-page extractor to plain JavaScript.
 *
 * Synchronous on purpose. This module is loaded both by the build script and by
 * the drift test, and the test runs under tsx with CommonJS output - where an
 * async export is fine but a top-level `await` in the CLI guard is a hard
 * transform error. esbuild's sync API makes both callers simple.
 *
 * @returns {string} the generated in-page source
 */
export function buildExtractScript() {
  const src = path.join(here, "..", "src", "lib", "crawler", "extract-script.ts");
  const input = fs.readFileSync(src, "utf8");
  const { code } = esbuild.transformSync(input, {
    loader: "ts",
    format: "iife",
    target: "es2020",
    keepNames: false,
    legalComments: "none",
  });
  // The IIFE body is everything between the outermost braces.
  const open = code.indexOf("{");
  const close = code.lastIndexOf("}");
  if (open < 0 || close < 0) throw new Error("could not locate the generated IIFE body");
  const body = code.slice(open + 1, close);
  if (body.includes("__name")) {
    throw new Error("the transform still emits __name(); the in-page script would throw at runtime");
  }
  return `// GENERATED FILE — do not edit. Run \`npm run build:extract\` after changing
// src/lib/crawler/extract-script.ts
(function () {
${body}
  return extractPage();
})()
`;
}

function main() {
  const code = buildExtractScript();
  const dest = path.join(here, "..", "src", "lib", "crawler", "extract-page.js");
  fs.writeFileSync(dest, code, "utf8");
  process.stdout.write(`wrote ${path.relative(process.cwd(), dest)} (${code.length} bytes)\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
