/**
 * CLI: the same pipeline the control panel drives, without a browser in the loop.
 *
 *   npm run cli -- doctor
 *   npm run cli -- generate <url> [--mode spec|ai-page]
 *   npm run cli -- modify <project-id> "<request>"
 *   npm run cli -- preview <project-id>
 *   npm run cli -- list
 *   npm run cli -- show <project-id>
 *
 * Output is human-readable by default and `--json` for scripts. Nothing here
 * prints a secret: the doctor reports whether a credential is *set*, never its
 * value.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { config, redactSecret } from "./config";
import { attachProjectLog, createLogger } from "./logger";
import { getProvider, refreshModels } from "./ai/index";
import { checkHealth, invalidateModelCache, listFreeModels } from "./ai/models";
import { listProjects, projectDir, readRecord, readSpec } from "./store/projects";
import { runModification, runPipeline } from "./store/pipeline";
import { invalidatePreview, startPreview, stopAll, stopPreview } from "./preview/server";
import { normaliseInput } from "./security";
import type { GenerationMode } from "./generator";

const log = createLogger("cli");

interface Flags {
  json: boolean;
  mode?: GenerationMode;
  open: boolean;
  keep: boolean;
}

function parseArgs(argv: string[]): { cmd: string[]; flags: Flags } {
  const flags: Flags = { json: false, open: false, keep: false };
  const cmd: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") flags.json = true;
    else if (a === "--open") flags.open = true;
    else if (a === "--keep") flags.keep = true;
    else if (a === "--mode") flags.mode = argv[++i] as GenerationMode;
    else if (a?.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    else cmd.push(a);
  }
  return { cmd, flags };
}

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};
const err = (s: string): void => {
  process.stderr.write(`${s}\n`);
};

function table(rows: string[][]): string {
  if (!rows.length) return "";
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows
    .map((r) => r.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ").trimEnd())
    .join("\n");
}

async function doctor(): Promise<number> {
  const c = config();
  out("Sitewright doctor");
  out("=".repeat(60));
  out(`repo root        ${c.repoRoot}`);
  out(`data dir         ${c.dataDir}`);
  out(`generated dir    ${c.generatedDir}`);
  out(`provider         ${c.ai.provider}`);
  out(`configured model ${c.ai.model || "(discover at runtime)"}`);
  out(`generation mode  ${c.ai.mode}`);
  out(`opencode bin     ${c.ai.opencode.bin}`);
  out(`workspace        ${c.ai.opencode.workspaceDir}`);
  out(`openai base url  ${c.ai.openaiCompatible.baseUrl}`);
  out(`openai key       ${redactSecret(c.ai.openaiCompatible.apiKey)}`);
  out(`preview ports    ${c.previewPortStart}-${c.previewPortEnd}`);
  out(`max repairs      ${c.validation.maxRepairAttempts}`);

  out("");
  out("Filesystem");
  const nextBin = path.join(c.repoRoot, "node_modules", ".bin", "next");
  const checks: [string, Promise<unknown>][] = [
    ["next binary", fsp.stat(nextBin)],
    ["tailwind postcss", fsp.stat(path.join(c.repoRoot, "node_modules", "@tailwindcss", "postcss"))],
    ["generated dir", fsp.mkdir(c.generatedDir, { recursive: true })],
  ];
  for (const [label, p] of checks) {
    try {
      await p;
      out(`  ok    ${label}`);
    } catch (e) {
      out(`  FAIL  ${label}: ${(e as Error).message}`);
    }
  }

  out("");
  out("AI provider");
  try {
    const health = await checkHealth(getProvider());
    out(`  reachable        ${health.ok ? "yes" : "no"}`);
    out(`  detail           ${health.detail}`);
    if (health.probe) {
      out(`  probe model      ${health.probe.model} (${health.probe.ms}ms)`);
    }
    if (health.ok) {
      const cat = await listFreeModels(getProvider());
      out(`  models listed    ${cat.total}`);
      out(`  text-capable     ${cat.all.length}  (${cat.rejected.length} filtered out)`);
      out(`  verifiably free  ${cat.free.length}`);
      out(`  pricing source   ${cat.pricingAvailable ? "models.dev (verified)" : "unavailable"}`);
      out(`  top free models  ${cat.free.slice(0, 6).map((m) => m.id).join(", ") || "(none found)"}`);
      if (cat.primary) out(`  primary          ${cat.primary}`);
    }
  } catch (e) {
    out(`  FAIL  ${(e as Error).message}`);
    return 1;
  }
  return 0;
}

async function generate(url: string, flags: Flags): Promise<number> {
  const target = normaliseInput(url);
  const result = await runPipeline({ url: target.href, mode: flags.mode });
  const rec = result.record;

  if (flags.json) {
    out(JSON.stringify({ id: rec.id, status: rec.status, spec: result.spec }, null, 2));
    return 0;
  }

  out("");
  out(`Project   ${rec.id}`);
  out(`Source    ${rec.finalUrl}`);
  out(`Directory ${projectDir(rec.id)}`);
  out(`Sections  ${result.spec.sections.map((s) => s.kind).join(", ")}`);
  out(`Models    ${rec.modelTrail.join(" → ") || "(none)"}`);
  out(`Assets    ${rec.assets.downloaded} downloaded, ${rec.assets.missing} missing`);
  out(`Build     ${rec.build?.ok ? "ok" : "failed"} in ${((rec.build?.durationMs ?? 0) / 1000).toFixed(1)}s`);

  if (flags.open) {
    const preview = await startPreview(rec.id, projectDir(rec.id));
    out(`Preview   ${preview.url}`);
  }
  return 0;
}

async function modify(id: string, request: string, flags: Flags): Promise<number> {
  const outcome = await runModification({ id, request });
  if (flags.json) {
    out(JSON.stringify(outcome.result, null, 2));
    return outcome.error ? 1 : 0;
  }
  out("");
  if (outcome.error) {
    err(`Not applied: ${outcome.error}`);
    return 1;
  }
  out(`Applied   ${outcome.result.changed} operation(s) via ${outcome.result.model}`);
  for (const a of outcome.result.applied) {
    out(`  ${a.applied ? "✓" : "✗"} ${a.description}${a.reason ? `  (${a.reason})` : ""}`);
  }
  if (outcome.build) out(`Build     ${outcome.build.ok ? "ok" : "failed"} in ${(outcome.build.durationMs / 1000).toFixed(1)}s`);
  if (flags.open) {
    invalidatePreview(id);
    const preview = await startPreview(id, projectDir(id));
    out(`Preview   ${preview.url}`);
  }
  return 0;
}

async function preview(id: string, flags: Flags): Promise<number> {
  const handle = await startPreview(id, projectDir(id));
  if (flags.json) {
    out(JSON.stringify(handle, null, 2));
    return 0;
  }
  out(`${handle.url}  (pid ${handle.pid})`);
  out("Press Ctrl+C to stop.");
  // Hold the process open so the server keeps serving.
  await new Promise(() => {});
  return 0;
}

async function list(): Promise<number> {
  const projects = await listProjects();
  if (!projects.length) {
    out("No projects yet. Try: npm run cli -- generate https://example.com");
    return 0;
  }
  out(
    table([
      ["ID", "STATUS", "SECTIONS", "ASSETS", "MODELS", "TITLE"],
      ...projects.map((p) => [
        p.id,
        p.status,
        String(p.sectionCount || 0),
        `${p.assets.downloaded}/${p.assets.total}`,
        p.modelTrail.join(","),
        (p.title || p.sourceUrl).slice(0, 48),
      ]),
    ]),
  );
  return 0;
}

async function show(id: string): Promise<number> {
  const rec = await readRecord(id);
  if (!rec) {
    err(`No project with id "${id}".`);
    return 1;
  }
  out(JSON.stringify(rec, null, 2));
  const spec = await readSpec(id).catch(() => null);
  if (spec) {
    out("");
    out("Sections");
    for (const s of spec.sections) {
      out(`  ${String(s.order).padStart(2)} ${s.kind.padEnd(13)} ${s.name}`);
    }
    out("");
    out("Theme");
    out(`  mode ${spec.theme.mode}  primary ${spec.theme.tokens.primary}  bg ${spec.theme.tokens.background}`);
    out(`  heading ${spec.theme.fonts.heading.family.slice(0, 60)}`);
  }
  if (rec.modifications.length) {
    out("");
    out("Modifications");
    for (const m of rec.modifications) {
      out(`  ${m.applied ? "✓" : "✗"} ${m.request}`);
      out(`    ${m.summary}`);
    }
  }
  return 0;
}

async function remove(id: string): Promise<number> {
  stopPreview(id);
  const { deleteProject } = await import("./store/projects");
  await deleteProject(id);
  out(`Deleted ${id}`);
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let parsed: { cmd: string[]; flags: Flags };
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    err((e as Error).message);
    return 2;
  }
  const [command, ...rest] = parsed.cmd;
  const flags = parsed.flags;

  // Per-run log file, so a failed run can be diagnosed after the fact.
  const dataDir = config().dataDir;
  await fsp.mkdir(dataDir, { recursive: true });
  attachProjectLog(path.join(dataDir, "sitewright.log"));
  log.debug("cli start", { command, config: { provider: config().ai.provider, mode: config().ai.mode } });

  try {
    switch (command) {
      case "doctor":
        return await doctor();
      case "generate":
      case "g": {
        const url = rest[0];
        if (!url) {
          err("Usage: npm run cli -- generate <url>");
          return 2;
        }
        return await generate(url, flags);
      }
      case "modify":
      case "m": {
        const [id, ...words] = rest;
        if (!id || !words.length) {
          err('Usage: npm run cli -- modify <project-id> "make the hero taller"');
          return 2;
        }
        return await modify(id, words.join(" "), flags);
      }
      case "preview":
      case "p": {
        const id = rest[0];
        if (!id) {
          err("Usage: npm run cli -- preview <project-id>");
          return 2;
        }
        return await preview(id, flags);
      }
      case "list":
      case "ls":
        return await list();
      case "show": {
        const id = rest[0];
        if (!id) {
          err("Usage: npm run cli -- show <project-id>");
          return 2;
        }
        return await show(id);
      }
      case "rm":
      case "delete": {
        const id = rest[0];
        if (!id) {
          err("Usage: npm run cli -- rm <project-id>");
          return 2;
        }
        return await remove(id);
      }
      case "models": {
        refreshModels();
        invalidateModelCache();
        const cat = await listFreeModels(getProvider(), { refresh: true });
        out(
          table([
            ["MODEL", "CONTEXT", "TOK IN", "TOK OUT", "FREE"],
            ...cat.all.slice(0, 60).map((m) => [
              m.id,
              m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k` : "-",
              m.costIn === null ? "?" : String(m.costIn),
              m.costOut === null ? "?" : String(m.costOut),
              m.verifiablyFree ? "yes" : m.pricingVerified ? "no" : "unknown",
            ]),
          ]),
        );
        out("");
        out(`Listed by provider: ${cat.total}   text-capable: ${cat.all.length}   verifiably free: ${cat.free.length}`);
        out(`Primary for this run: ${cat.primary ?? "(none)"}`);
        if (cat.rejected.length) {
          out("");
          out("Filtered out as non-text:");
          for (const r of cat.rejected.slice(0, 12)) out(`  ${r.id}  (${r.reason})`);
        }
        return 0;
      }
      default:
        err(`Unknown command: ${command ?? "(none)"}`);
        err("");
        err("Commands:");
        err("  doctor                     check the environment and the AI provider");
        err("  models                     list models the provider currently exposes");
        err("  generate <url>             analyse, generate, build");
        err("  modify <id> <request...>   apply a natural-language change");
        err("  preview <id>               serve the generated site");
        err("  list                       recent projects");
        err("  show <id>                  one project in detail");
        err("  rm <id>                    delete a project");
        err("");
        err("Flags: --json --mode spec|ai-page --open --keep");
        return 2;
    }
  } catch (e) {
    err(`${(e as Error).name}: ${(e as Error).message}`);
    log.error("cli failed", { command, error: (e as Error).message });
    return 1;
  }
}

main()
  .then((code) => {
    if (code === 0) process.exit(0);
    // `preview` blocks forever; anything else exits here.
    process.exitCode = code;
  })
  .catch((e) => {
    err(String(e));
    process.exit(1);
  });

export { stopAll };
