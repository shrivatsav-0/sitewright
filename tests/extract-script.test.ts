/**
 * The in-page extractor is a build artefact, and this is the test that keeps it
 * honest.
 *
 * `extract-script.ts` is TypeScript written to run *inside the page*, so it has
 * to be compiled to plain JavaScript before `page.evaluate` will accept it. The
 * compiled file is committed, because it is read as text at runtime and a build
 * step that silently did not run would be a far worse failure than a stale file
 * is.
 *
 * The two failure modes this guards against are both silent:
 *
 *  1. Drift. Someone edits the TypeScript, forgets to recompile, and the clone
 *     is built by a version of the extractor that no longer exists. The site
 *     still works; it is just quietly the wrong one.
 *  2. The esbuild `__name` helper. esbuild's `keepNames` option injects a
 *     `__name(...)` call around every function declaration to preserve
 *     `.name`. Inside `page.evaluate` that helper does not exist, so the whole
 *     script throws a ReferenceError on the first line of real work - and the
 *     extraction returns an empty page rather than an error, because the page
 *     itself is still fine.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";

import { buildExtractScript } from "../scripts/build-extract.mjs";
import { extractScriptPath } from "../src/lib/crawler/script";

const COMPILED = path.join(process.cwd(), "src/lib/crawler/extract-page.js");

describe("in-page extraction script", () => {
  test("the committed bundle matches a fresh build", async () => {
    const [committed, fresh] = await Promise.all([
      fsp.readFile(COMPILED, "utf8"),
      buildExtractScript(),
    ]);
    if (committed.trim() !== fresh.trim()) {
      // Named explicitly, because "run node scripts/build-extract.mjs" is the
      // only useful thing to say about a failure here.
      assert.fail(
        "src/lib/crawler/extract-page.js is out of date with extract-script.ts.\n" +
          "Run: node scripts/build-extract.mjs",
      );
    }
  });

  test("contains no esbuild name-preservation helper", async () => {
    const source = await fsp.readFile(COMPILED, "utf8");
    assert.ok(!/\b__name\b/.test(source), "bundle contains __name; esbuild keepNames must be false");
  });

  test("is a self-invoking function with no module syntax", async () => {
    const source = await fsp.readFile(COMPILED, "utf8");
    // `page.evaluate(string)` evaluates the text as an expression, so it must be
    // an expression - not a module with imports, and not a bare statement list.
    // The generated header comment sits above the IIFE, so match on the code.
    assert.match(source, /\(function \(\)\s*\{/, "bundle is not an IIFE");
    assert.ok(!/\bimport\s|\bexport\s|require\(/.test(source), "bundle has module syntax");
    // And it must actually parse, rather than merely look right. This is the
    // check that catches a malformed transform before it reaches the page.
    new Function(source);
  });

  test("returns its result rather than assigning to a global", async () => {
    const source = await fsp.readFile(COMPILED, "utf8");
    // A script that leaves its result on `window` would have to be read back out
    // of the page, which races with navigation. Returning it is the contract.
    assert.match(source, /return\s+\{/, "bundle does not return a result object");
  });

  test("has no source maps or debug leftovers", async () => {
    const source = await fsp.readFile(COMPILED, "utf8");
    assert.ok(!source.includes("//# sourceMappingURL"), "bundle references a source map");
    assert.ok(!/\bconsole\.(log|debug)\(/.test(source), "bundle logs to the page console");
  });
});

describe("in-page script path resolution", () => {
  const REPO = path.join(process.cwd(), "src/lib/crawler/extract-page.js");

  test("resolves next to the module in the source tree", () => {
    // The tsx / CLI context: __dirname is src/lib/crawler/.
    const dir = path.join(process.cwd(), "src/lib/crawler");
    assert.equal(extractScriptPath(dir), REPO);
  });

  test("walks up from a bundled location instead of failing", () => {
    // The regression: inside the Next.js server bundle __dirname is
    // .next/server/app/api/projects/[id]/events - a directory the file never
    // lands in - and the loader used to throw with exactly that path. It must
    // walk up to the repo-relative location instead.
    const bundled = path.join(
      process.cwd(),
      ".next/server/app/api/projects/[id]/events",
    );
    assert.equal(extractScriptPath(bundled), REPO);
    // Even deeper chunk paths (shared chunks land in .next/server/chunks).
    const deepChunk = path.join(process.cwd(), ".next/server/chunks/4bd1b696-c023c6e3521b1417");
    assert.equal(extractScriptPath(deepChunk), REPO);
  });
});
