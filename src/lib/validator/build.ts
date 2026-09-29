/**
 * Deterministic build validation, then bounded AI repair.
 *
 * The order matters: nothing calls a model until `next build` has actually
 * failed. That is what keeps the common path free, and it means the repair
 * prompt can contain a real compiler diagnostic instead of a guess.
 *
 * The loop is hard-bounded at `MAX_REPAIR_ATTEMPTS` (default 2) and every
 * attempt is a no-op if the build already passes. There is no path in this file
 * that can loop indefinitely.
 */

import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { createLogger } from "../logger";
import { extractFencedCode, text } from "../ai/index";
import { repairSystem, repairUser } from "../prompts";
import { childEnv } from "../child-env";
import { SECTIONS_TSX } from "../generator/sections";
import { CHROME_TSX } from "../generator/chrome";

const log = createLogger("validator");

export interface BuildResult {
  ok: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** Diagnostics extracted from the build output, deduped and capped. */
  errors: string[];
  /** True when the failure looks like a missing dependency rather than code. */
  environmentFailure: boolean;
  timedOut: boolean;
}

export interface ValidateOptions {
  projectDir: string;
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
}

/** Files the repair loop is allowed to rewrite. */
const REPAIRABLE = new Set(["app/page.tsx", "app/globals.css", "app/layout.tsx"]);

export async function runBuild(opts: ValidateOptions): Promise<BuildResult> {
  const t0 = Date.now();
  const nextBin = path.join(config().repoRoot, "node_modules", ".bin", "next");
  const result = await execFile(nextBin, ["build"], {
    cwd: opts.projectDir,
    timeoutMs: config().validation.buildTimeoutMs,
    signal: opts.signal,
    // A clean environment, never the hosting Next process's own. See
    // childEnv's comment for the failure this prevents: the panel runs inside
    // `next dev`, and a nested build that inherits the dev server's NEXT_* /
    // NODE_CHANNEL_* state can pull pages-router 404 rendering into the
    // generated app and die with "<Html> should not be imported outside of
    // pages/_document." - on files that build fine from a clean shell.
    env: childEnv(),
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  const errors = extractDiagnostics(combined);
  const out: BuildResult = {
    ok: result.code === 0 && !result.timedOut,
    durationMs: Date.now() - t0,
    stdout: result.stdout.slice(-20_000),
    stderr: result.stderr.slice(-20_000),
    errors,
    environmentFailure: looksLikeEnvironmentFailure(combined, result.code),
    timedOut: result.timedOut,
  };
  log.info("build", {
    ok: out.ok,
    ms: out.durationMs,
    errors: out.errors.length,
    environmentFailure: out.environmentFailure,
    timedOut: out.timedOut,
  });
  return out;
}

/**
 * Build, and if it fails, let the model try to fix it — a bounded number of
 * times. Returns the final build result plus a record of what was attempted.
 */
export interface ValidateAndRepairResult {
  build: BuildResult;
  attempts: number;
  repairs: { file: string; model: string; ok: boolean; error?: string }[];
  /** Set when the model could not fix it and we fell back. */
  fellBack: boolean;
}

export async function validateProject(opts: ValidateOptions & {
  /** Called with the deterministic page source when a fallback is needed. */
  fallbackPage?: () => Promise<void>;
}): Promise<ValidateAndRepairResult> {
  const maxAttempts = config().validation.maxRepairAttempts;
  const repairs: ValidateAndRepairResult["repairs"] = [];
  let build = await runBuild(opts);
  let attempts = 0;
  let fellBack = false;

  while (!build.ok && attempts < maxAttempts) {
    if (build.environmentFailure || build.timedOut) {
      log.warn("not attempting repair", {
        environmentFailure: build.environmentFailure,
        timedOut: build.timedOut,
      });
      break;
    }
    attempts++;
    const target = pickRepairTarget(build.errors);
    if (!target) {
      log.warn("build failed but no repairable file was implicated", {
        errors: build.errors.slice(0, 3),
      });
      break;
    }
    opts.onProgress?.(`Repairing ${target} (attempt ${attempts}/${maxAttempts})`);

    const abs = path.join(opts.projectDir, target);
    let current = "";
    try {
      current = await fsp.readFile(abs, "utf8");
    } catch {
      break;
    }

    const isCss = target.endsWith(".css");
    let repaired: string | null = null;
    let model = "";
    try {
      const res = await text({
        operation: "repair",
        label: `repair:${target}`,
        system: repairSystem(isCss ? "css" : "ts"),
        user: repairUser({
          language: isCss ? "css" : "ts",
          filename: target,
          source: current,
          errors: build.errors.slice(0, 8),
          availableImports: isCss ? undefined : availableImports(),
        }),
        maxOutputTokens: isCss ? 3000 : 2500,
        temperature: 0.05,
        signal: opts.signal,
      });
      model = res.model;
      repaired = isCss ? res.text : extractFencedCode(res.text) || res.text;
    } catch (err) {
      repairs.push({
        file: target,
        model,
        ok: false,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
      log.warn("repair completion failed", { file: target, error: (err as Error).message });
      break;
    }

    if (!repaired?.trim()) {
      repairs.push({ file: target, model, ok: false, error: "empty response" });
      break;
    }

    // Never let a repair widen the attack surface: only the same file, and only
    // relative imports for TypeScript.
    if (!isCss && hasForbiddenImport(repaired)) {
      repairs.push({ file: target, model, ok: false, error: "imported a non-relative module" });
      log.warn("rejected a repair that imported a non-relative module", { file: target });
      break;
    }

    const before = current;
    await fsp.writeFile(abs, repaired, "utf8");
    const next = await runBuild(opts);
    if (next.ok) {
      repairs.push({ file: target, model, ok: true });
      log.info("repair succeeded", { file: target, model, attempts });
      build = next;
      break;
    }
    // The repair made things no better. Put it back so the fallback has a known
    // state, and stop rather than let the model thrash the file.
    if (next.errors.length >= build.errors.length) {
      await fsp.writeFile(abs, before, "utf8");
      repairs.push({ file: target, model, ok: false, error: "no improvement" });
      log.warn("repair did not reduce the error count; reverting", { file: target, model });
      break;
    }
    repairs.push({ file: target, model, ok: false, error: `${before.length}→${next.errors.length} errors` });
    build = next;
  }

  if (!build.ok && opts.fallbackPage && !build.environmentFailure) {
    log.info("falling back to the deterministic page");
    await opts.fallbackPage();
    const after = await runBuild(opts);
    if (after.ok) {
      fellBack = true;
      build = after;
    }
  }

  return { build, attempts, repairs, fellBack };
}

// ------------------------------------------------------------------ helpers

/** The import list a page module is allowed to use, restated for the repairer. */
function availableImports(): string[] {
  return [
    "import { renderSection, SECTION_COMPONENTS } from \"../components/sections\";",
    "import { SiteHeader, SiteFooter, Brand } from \"../components/chrome\";",
    "import { siteSpec } from \"../lib/site-spec\";",
    "import type { SectionSpec, CompositionEntry, Item, Link, AssetRef, WebsiteSpec } from \"../lib/types\";",
  ];
}

function hasForbiddenImport(source: string): boolean {
  for (const m of source.matchAll(/^\s*import\s+.*?from\s+["']([^"']+)["']/gm)) {
    const spec = m[1];
    if (!spec.startsWith(".") && !spec.startsWith("@/")) return true;
  }
  for (const m of source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']/g)) {
    const spec = m[1];
    if (!spec.startsWith(".")) return true;
  }
  return /\b(dangerouslySetInnerHTML|eval|new\s+Function|child_process|process\.env)/.test(source);
}

/**
 * Choose the file to repair.
 *
 * The generated component library and the spec module are *not* repairable: if
 * they need fixing, the bug is ours, and letting the model rewrite them would
 * hide it. Only the page, the layout, and the stylesheet are in scope.
 */
export function pickRepairTarget(errors: string[]): string | null {
  const joined = errors.join("\n");
  const rank = (file: string, patterns: RegExp[]) =>
    patterns.some((p) => p.test(joined)) && joined.includes(file) && REPAIRABLE.has(file) ? file : null;

  const page = rank("app/page.tsx", [/app\/page\.tsx/, /\bpage\.tsx\b/]);
  if (page) return page;
  const layout = rank("app/layout.tsx", [/app\/layout\.tsx/]);
  if (layout) return layout;
  const css = rank("app/globals.css", [/app\/globals\.css/, /\.css:\d+:\d+/]);
  if (css) return css;
  return null;
}

/**
 * Pull human-usable diagnostics out of Next.js output.
 *
 * Next prints errors in several shapes depending on whether they come from
 * SWC, TypeScript, or the CSS pipeline. We keep the lines that name a file or
 * carry an error tag, dedupe them, and cap the list so the repair prompt stays
 * small.
 */
export function extractDiagnostics(output: string): string[] {
  const lines = output.split("\n");
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    const clean = s.replace(/\s+$/, "").trim();
    if (!clean) return;
    const key = clean.toLowerCase().replace(/\d+/g, "#");
    if (seen.has(key)) return;
    seen.add(key);
    out.push(clean);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // TypeScript: "app/page.tsx(12,5): error TS2304: Cannot find name 'x'."
    const ts = line.match(/^(\S+\.(?:tsx|ts|css|jsx|js))\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+|.*)$/);
    if (ts) {
      push(`${ts[1]}:${ts[2]}:${ts[3]} ${ts[4]} ${ts[5]}`.trim());
      continue;
    }
    // SWC / bundler: "  × You passed an invalid prop..."
    if (/^\s*[×✕]\s+\S/.test(line)) {
      const detail = [line.trim().replace(/^[×✕]\s*/, "")];
      // Include the location line that usually follows.
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        if (/\.(tsx|ts|css)\s*$|^\s*at\s/.test(lines[j])) detail.push(lines[j].trim());
      }
      push(detail.join(" "));
      continue;
    }
    // CSS: "  >  3 |  .foo {"
    if (/\.(css|scss)\s*$/.test(line) && /^\s*[>│|]/.test(line)) {
      push(line.trim().replace(/^[>│|]\s*/, ""));
      continue;
    }
    if (/^\s*(Type error|Error|Failed to compile|Module not found|Cannot find module)/i.test(line)) {
      push(line.trim());
      const next = lines[i + 1]?.trim();
      if (next && next.length < 200) push(next);
    }
  }
  return out.slice(0, 20);
}

function looksLikeEnvironmentFailure(output: string, code: number | null): boolean {
  if (code === 127) return true;
  return /(Cannot find module '(\.\/)?node_modules|ENOENT|command not found|ELIFECYCLE|spawn (ENOENT|EACCES)|Failed to load|Segmentation fault|libEGL|shared library)/i.test(
    output,
  );
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

function execFile(
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("build aborted")));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("error", (err) =>
      finish(() =>
        reject(
          new Error(
            `Could not run \`${file}\`. ${(err as NodeJS.ErrnoException).code === "ENOENT" ? "Is the repository's node_modules present?" : (err as Error).message}`,
          ),
        ),
      ),
    );
    child.on("close", (code) => finish(() => resolve({ stdout, stderr, code, timedOut })));
  });
}

export { SECTIONS_TSX, CHROME_TSX };
