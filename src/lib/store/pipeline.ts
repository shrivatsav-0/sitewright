/**
 * The pipeline.
 *
 * One function, `runPipeline`, owns a whole generation: crawl → interpret →
 * spec → compose → generate → build → (repair) → ready. It emits progress
 * events and never blocks; the caller awaits the returned promise.
 *
 * Guarantees this file is responsible for
 * ---------------------------------------
 *  - Bounded. Every loop is capped: structured-output attempts, model rotation,
 *    build repair attempts. There is no unbounded retry anywhere on this path.
 *  - Fallible-but-progressing. A failure at any step is recorded on the project
 *    record with the reason, not thrown away.
 *  - Cheap where it can be. Composition and generation are deterministic; the
 *    model is consulted for the parts that genuinely need judgement.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { createLogger } from "../logger";
import { normaliseInput, type NormalisedUrl } from "../security";
import { Crawler, screenshotsDir } from "../crawler/browser";
import { composePage, synthesizeSpec } from "../analyzer/synthesize";
import { authorPage } from "../generator/compose";
import { generateProject, type GenerationMode } from "../generator";
import { validateProject } from "../validator/build";
import { modifySite, summariseModification, type ModificationResult } from "../modifier";
import {
  makeProjectId,
  newRecord,
  projectDir,
  readSpec,
  updateRecord,
  writeRecord,
  writeSpec,
  type ProjectRecord,
  type RunEvent,
  type RunStatus,
} from "./projects";
import { invalidatePreview } from "../preview/server";
import type { WebsiteSpec } from "../spec/schema";

const log = createLogger("pipeline");

export type ProgressListener = (event: RunEvent) => void;

export interface PipelineResult {
  record: ProjectRecord;
  spec: WebsiteSpec;
}

/** Fan progress out to the project record and to any live SSE listener. */
class Emitter {
  private readonly events: RunEvent[] = [];
  readonly listeners = new Set<ProgressListener>();
  constructor(readonly id: string) {}

  async emit(status: RunStatus, message: string, extra?: Partial<RunEvent>): Promise<void> {
    const event: RunEvent = { at: new Date().toISOString(), status, message, ...extra };
    this.events.push(event);
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        /* a dead SSE connection must not break the run */
      }
    }
    await updateRecord(this.id, (rec) => {
      rec.status = status;
      if (extra?.model && !rec.modelTrail.includes(extra.model)) rec.modelTrail.push(extra.model);
      if (extra?.data?.aiCalls) rec.aiCalls += Number(extra.data.aiCalls);
      if (extra?.data?.inputTokens) rec.inputTokens += Number(extra.data.inputTokens);
      if (extra?.data?.outputTokens) rec.outputTokens += Number(extra.data.outputTokens);
      rec.error = status === "failed" ? message : undefined;
      return rec;
    }).catch(() => undefined);
    log.info(message, { status, ...(extra?.data ?? {}) });
  }

  history(): RunEvent[] {
    return [...this.events];
  }
}

/** Per-project emitter registry, so an API route can subscribe to a live run. */
const emitters = new Map<string, Emitter>();

export function subscribe(id: string, listener: ProgressListener): () => void {
  const em = emitterFor(id);
  em.listeners.add(listener);
  return () => {
    em?.listeners.delete(listener);
  };
}

export function history(id: string): RunEvent[] {
  return emitters.get(id)?.history() ?? [];
}

function emitterFor(id: string): Emitter {
  let em = emitters.get(id);
  if (!em) {
    em = new Emitter(id);
    emitters.set(id, em);
  }
  return em;
}

// ---------------------------------------------------------------- generation

export interface GenerateOptions {
  url: string;
  /** Reuse an existing project instead of creating one. */
  projectId?: string;
  /** Force a specific generation mode for this run. */
  mode?: GenerationMode;
  signal?: AbortSignal;
}

export async function runPipeline(opts: GenerateOptions): Promise<PipelineResult> {
  const { url, signal } = opts;

  let target: NormalisedUrl;
  try {
    target = normaliseInput(url);
  } catch (err) {
    // A bad URL never creates a project; surface it to the caller directly.
    throw err instanceof Error ? err : new Error(String(err));
  }

  const id = opts.projectId ?? makeProjectId(target.href);
  const dir = projectDir(id);
  await fsp.mkdir(dir, { recursive: true });

  const em = emitterFor(id);
  if (opts.projectId) {
    // Re-generation: keep the existing record so history is not lost.
    const existing = await updateRecord(id, (rec) => {
      rec.status = "queued";
      rec.error = undefined;
      return rec;
    });
    existing.sourceUrl = target.href;
  } else {
    await writeRecord(newRecord(id, target.href));
  }

  const t0 = Date.now();

  try {
    // ---------------------------------------------------------- 1. crawl
    // Screenshots and section crops go in their own directory so the generated
    // project root stays exactly the set of files a real project would have.
    const shotDir = screenshotsDir(dir);
    await fsp.mkdir(shotDir, { recursive: true });
    await em.emit("analyzing", `Opening ${target.href}`);
    const crawler = await Crawler.launch();
    let analysis;
    try {
      analysis = await crawler.analyse(target, shotDir);
    } finally {
      await crawler.close().catch(() => undefined);
    }

    const title = analysis.page.title || target.hostname;
    await updateRecord(id, (rec) => {
      rec.finalUrl = analysis.finalUrl;
      rec.title = title;
      rec.screenshots = [
        ...analysis.screenshots
          .filter((s) => s.file)
          .map((s) => ({
            name: s.viewport,
            viewport: s.viewport,
            path: path.join(analysis.screenshotsDir, s.file),
          })),
        // The per-section crops are the photos the vision model sees. Record
        // them alongside the viewport captures so a run keeps its evidence.
        ...analysis.sectionShots.map((shot) => ({
          name: `section-${String(shot.index).padStart(2, "0")}`,
          viewport: "section",
          path: path.join(analysis.screenshotsDir, shot.file),
        })),
      ];
      return rec;
    });

    if (signal?.aborted) throw new Error("Cancelled.");
    await em.emit(
      "analyzing",
      `Measured ${analysis.page.sections.length} blocks, ${analysis.sectionShots.length} section photos, ${analysis.timings.totalMs}ms`,
    );

    // --------------------------------------------------- 2. spec synthesis
    await em.emit("spec", "Interpreting the page and writing the site specification");
    const publicDir = path.join(dir, "public");
    await fsp.mkdir(publicDir, { recursive: true });
    const synth = await synthesizeSpec({
      analysis,
      publicDir,
      signal,
      onProgress: (msg, detail) => {
        void em.emit("spec", msg, detail?.model ? { model: String(detail.model), data: detail } : { data: detail });
      },
    });
    const spec = synth.spec;
    await writeSpec(id, spec);
    await updateRecord(id, (rec) => {
      rec.specPath = path.join(dir, "site.spec.json");
      rec.sectionCount = spec.sections.length;
      rec.sectionKinds = spec.sections.map((s) => s.kind);
      rec.assets = {
        downloaded: synth.assetStats.downloaded,
        missing: synth.assetStats.missing,
        total: synth.assetStats.unique,
      };
      for (const m of synth.modelTrail) if (!rec.modelTrail.includes(m)) rec.modelTrail.push(m);
      return rec;
    });
    await em.emit("spec", `Specification ready: ${spec.sections.length} sections, model ${synth.model}`, {
      model: synth.model,
    });

    // ------------------------------------------------------ 3. composition
    await em.emit("generating", "Composing the page layout");
    const composition = await composePage({ spec, model: synth.model, signal });

    // ---------------------------------------- 4. optional code authoring
    let authoredPage: string | undefined;
    const mode: GenerationMode = opts.mode ?? (config().ai.mode as GenerationMode);
    if (mode === "ai-page") {
      await em.emit("generating", "Asking the model to author the page component");
      const authored = await authorPage({ spec, composition: composition.sections, signal });
      if (authored.source) {
        authoredPage = authored.source;
        await em.emit("generating", "Model authored app/page.tsx", { model: authored.model });
      } else {
        await em.emit("generating", `Using the deterministic page (${authored.skipped})`);
      }
    }

    // ----------------------------------------------------- 5. generation
    await em.emit("generating", "Writing the project files");
    const gen = await generateProject({
      spec,
      projectDir: dir,
      slug: id,
      composition: composition.sections,
      authoredPage,
      mode,
    });
    log.info("generated", { files: gen.files.length, pageSource: gen.pageSource });

    // ------------------------------------------- 6. build (+ bounded repair)
    await em.emit("building", "Building the generated site");
    const validation = await validateProject({
      projectDir: dir,
      signal,
      onProgress: (msg) => {
        void em.emit("building", msg);
      },
      fallbackPage: async () => {
        // Deterministic page: guaranteed-valid fallback.
        await generateProject({ spec, projectDir: dir, slug: id, composition: composition.sections, mode: "spec" });
      },
    });

    if (!validation.build.ok) {
      throw new Error(
        `The generated site did not build after ${validation.attempts} repair attempt(s): ${
          validation.build.errors[0] ?? "unknown build error"
        }`,
      );
    }

    await updateRecord(id, (rec) => {
      rec.build = {
        at: new Date().toISOString(),
        ok: true,
        durationMs: validation.build.durationMs,
        attempts: validation.attempts,
        errors: [],
        pageSource: gen.pageSource,
        mode,
      };
      rec.status = "ready";
      return rec;
    });
    for (const r of validation.repairs) if (r.model) await em.emit("building", `Repair ${r.file}: ${r.ok ? "ok" : "failed"}`, { model: r.model });

    // A rebuild invalidates a running preview; the next request restarts it.
    invalidatePreview(id);

    await em.emit("ready", `Ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`, {
      data: { buildMs: validation.build.durationMs },
    });

    const record = await updateRecord(id, (r) => r);
    return { record, spec };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("pipeline failed", { id, error: message });
    await em.emit("failed", message);
    throw err;
  } finally {
    // Give the emitter a moment to settle so late listeners see the final state.
    if (emitters.get(id) && history(id).length > 0) {
      // history is retained intentionally; the map entry is small (400 events max).
    }
  }
}

// -------------------------------------------------------------- modification

export interface ModifyOptions {
  id: string;
  request: string;
  /** Regenerate after a successful patch. Default true. */
  rebuild?: boolean;
  signal?: AbortSignal;
}

export interface ModifyOutcome {
  record: ProjectRecord;
  spec: WebsiteSpec;
  result: ModificationResult;
  build?: { ok: boolean; durationMs: number; errors: string[]; attempts: number };
  error?: string;
}

/**
 * Apply a natural-language change: patch the spec, regenerate, rebuild.
 *
 * Regeneration after a patch is cheap because it is the deterministic half of
 * the pipeline — no crawl, no model, no asset download. The only model call is
 * the one that reads the request.
 */
export async function runModification(opts: ModifyOptions): Promise<ModifyOutcome> {
  const { id, request } = opts;
  const em = emitterFor(id);
  const t0 = Date.now();

  await updateRecord(id, (rec) => {
    rec.status = "modifying";
    rec.error = undefined;
    return rec;
  });

  const previous = await readSpec(id);
  await em.emit("modifying", `Interpreting: "${request.slice(0, 120)}"`);

  const result = await modifySite({ spec: previous, request, signal: opts.signal });
  if (result.error) {
    await em.emit("failed", result.error, { model: result.model });
    const record = await updateRecord(id, (rec) => {
      rec.status = previous.sections.length ? "ready" : "failed";
      rec.modifications = [
        ...rec.modifications,
        {
          id: modId(),
          request,
          at: new Date().toISOString(),
          model: result.model,
          summary: summariseModification(result),
          changeSummary: "",
          applied: false,
          error: result.error,
        },
      ];
      return rec;
    });
    return { record, spec: previous, result, error: result.error };
  }

  await writeSpec(id, result.spec);
  await updateRecord(id, (rec) => {
    rec.sectionCount = result.spec.sections.length;
    rec.sectionKinds = result.spec.sections.map((s) => s.kind);
    return rec;
  });
  const summary = summariseModification(result);
  await em.emit("modifying", summary, { model: result.model });

  // Cheap re-generation: deterministic projection, no model call.
  const dir = projectDir(id);
  const composition = result.spec.sections.map((s) => ({ kind: s.kind, id: s.id, props: {} }));
  const gen = await generateProject({
    spec: result.spec,
    projectDir: dir,
    slug: id,
    composition,
    mode: "spec",
  });

  let build: ModifyOutcome["build"];
  if (opts.rebuild !== false) {
    await em.emit("building", "Rebuilding the modified site");
    const validation = await validateProject({
      projectDir: dir,
      signal: opts.signal,
      onProgress: (msg) => {
        void em.emit("building", msg);
      },
    });
    build = {
      ok: validation.build.ok,
      durationMs: validation.build.durationMs,
      errors: validation.build.errors.slice(0, 8),
      attempts: validation.attempts,
    };
    if (validation.build.ok) invalidatePreview(id);
  }

  const record = await updateRecord(id, (rec) => {
    rec.modifications = [
      ...rec.modifications,
      {
        id: modId(),
        request,
        at: new Date().toISOString(),
        model: result.model,
        summary,
        changeSummary: result.note,
        applied: !!build?.ok,
        ...(build && !build.ok ? { error: build.errors[0] ?? "build failed" } : {}),
      },
    ];
    if (build) {
      rec.build = {
        at: new Date().toISOString(),
        ok: build.ok,
        durationMs: build.durationMs,
        attempts: build.attempts,
        errors: build.errors,
        pageSource: gen.pageSource,
        mode: "spec",
      };
    }
    rec.status = build && !build.ok ? "failed" : "ready";
    if (result.model && !rec.modelTrail.includes(result.model)) rec.modelTrail.push(result.model);
    return rec;
  });

  if (build && !build.ok) {
    // Roll the spec back so the stored project always matches a working build.
    await writeSpec(id, previous);
    await generateProject({ spec: previous, projectDir: dir, slug: id, composition: composition, mode: "spec" });
    await validateProject({ projectDir: dir, signal: opts.signal });
    await em.emit("failed", `The change broke the build and was rolled back: ${build.errors[0] ?? "unknown error"}`);
    return { record, spec: previous, result, build, error: build.errors[0] ?? "build failed" };
  }

  await em.emit("ready", `Modification applied in ${((Date.now() - t0) / 1000).toFixed(1)}s`, {
    model: result.model,
  });
  return { record, spec: result.spec, result, build };
}

function modId(): string {
  return Math.random().toString(36).slice(2, 10);
}
