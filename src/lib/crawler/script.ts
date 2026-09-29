/**
 * Loader for the in-page extraction script.
 *
 * The extraction function is written in TypeScript (`extract-script.ts`) and
 * compiled to a plain, self-contained IIFE (`extract-page.js`) by
 * `npm run build:extract`. It is read from disk as *text* and handed to
 * `page.evaluate` as a string.
 *
 * Why text and not a function reference
 * ------------------------------------
 * Passing a real function would let the bundler transform it, and esbuild's
 * name-keeping helper (`__name("fn", ...)`) does not exist inside the page. The
 * first line of the extracted function would throw
 * `ReferenceError: __name is not defined`. Reading committed plain JS sidesteps
 * the transform entirely.
 */

import fs from "node:fs";
import path from "node:path";
import { createLogger } from "../logger";
import type { ExtractedPage } from "./extract-script";

const log = createLogger("crawler/script");

let cached: string | null = null;

/**
 * Absolute path of the generated in-page script.
 *
 * Resolved instead of trusting a single anchor, because the same module runs
 * in two very different contexts:
 *
 *   - under tsx (CLI, tests) `__dirname` is `src/lib/crawler/` and the file
 *     sits right next to this module;
 *   - inside the Next.js server bundle (control panel API routes) `__dirname`
 *     points into `.next/server/...`, where the file has never been copied.
 *
 * So candidates are tried in order: next to the module, then walked up from the
 * module to the repo-relative location (which is where the bundle ends up, and
 * does not depend on the process cwd), then cwd-anchored as a last resort
 * (covering a production `next start` run from the repo root). The first
 * existing file wins; if none does, the next-to-module path is returned so the
 * caller's "missing file" error names the expected location.
 *
 * The anchor parameter is for tests that want to simulate a bundled build
 * without a real `.next` tree.
 */
export function extractScriptPath(anchor: string = __dirname): string {
  const repoRelative = path.join("src", "lib", "crawler", "extract-page.js");
  const nextToModule = path.join(anchor, "extract-page.js");
  if (fs.existsSync(nextToModule)) return nextToModule;

  let dir = anchor;
  for (let up = 0; up < 12; up++) {
    const candidate = path.join(dir, repoRelative);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const cwdAnchored = path.join(process.cwd(), repoRelative);
  if (fs.existsSync(cwdAnchored)) return cwdAnchored;

  return nextToModule;
}

export function extractScriptSource(): string {
  if (cached) return cached;
  const file = extractScriptPath();
  try {
    cached = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(
      `The in-page extraction script is missing (${file}). Run \`npm run build:extract\`. ${
        (err as Error).message
      }`,
    );
  }
  if (cached.includes("__name")) {
    throw new Error(
      `${file} contains an esbuild name-keeping helper. The generated file is stale; run \`npm run build:extract\`.`,
    );
  }
  log.debug("in-page script loaded", { bytes: cached.length });
  return cached;
}

/**
 * Run the extraction inside a page.
 *
 * Typed loosely on purpose: Playwright evaluates the string inside the page's
 * realm, so the return value crosses a serialisation boundary and the compiler
 * cannot verify it. The value is validated structurally on the way back in
 * `browser.ts` before anything trusts it.
 */
export function runExtract(evaluate: (source: string) => Promise<unknown>): Promise<ExtractedPage> {
  return evaluate(extractScriptSource()) as Promise<ExtractedPage>;
}
