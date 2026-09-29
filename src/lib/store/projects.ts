/**
 * Project persistence.
 *
 * A "project" is one generated site. Its on-disk layout:
 *
 *   generated/<id>/
 *     sitewright.json    the record below, plus per-run history
 *     site.spec.json     the validated WebsiteSpec, verbatim
 *     app/ components/ lib/ public/   the site itself
 *
 * The store is a plain JSON file per project rather than a database, because a
 * generated site is already a directory of plain files and the record should be
 * inspectable with `cat` when something goes wrong. Writes are atomic
 * (write-temp-then-rename) so a crash mid-run cannot leave a half-written
 * record, and concurrent runs on the same project are serialised by an
 * in-process per-id mutex.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config";
import { createLogger } from "../logger";
import { safeFileSegment } from "../security";
import type { WebsiteSpec } from "../spec/schema";
import { WebsiteSpecSchema } from "../spec/schema";

const log = createLogger("store");

export type RunStatus =
  | "queued"
  | "analyzing"
  | "spec"
  | "generating"
  | "building"
  | "ready"
  | "modifying"
  | "failed"
  | "cancelled";

export interface RunEvent {
  at: string;
  status: RunStatus;
  message: string;
  /** Which model handled the step, when one was involved. */
  model?: string;
  data?: Record<string, unknown>;
}

export interface Modification {
  id: string;
  request: string;
  at: string;
  model: string;
  summary: string;
  /** What the model actually changed, in its own words. */
  changeSummary: string;
  applied: boolean;
  error?: string;
}

export interface BuildRecord {
  at: string;
  ok: boolean;
  durationMs: number;
  attempts: number;
  errors: string[];
  pageSource: "ai" | "spec";
  mode: string;
}

export interface ProjectRecord {
  id: string;
  /** The URL the user typed. */
  sourceUrl: string;
  /** Where the browser actually ended up. */
  finalUrl: string;
  title: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  /** Cost-relevant telemetry: which model did what, how many times. */
  modelTrail: string[];
  aiCalls: number;
  inputTokens: number;
  outputTokens: number;
  build?: BuildRecord;
  specPath?: string;
  /** Sections in the current spec. */
  sectionCount: number;
  /** The section kinds present, for the project list. */
  sectionKinds: string[];
  screenshots: { name: string; viewport: string; path: string }[];
  assets: { downloaded: number; missing: number; total: number };
  modifications: Modification[];
  error?: string;
  /** Preview server port, once one is running. */
  previewPort?: number;
}

const RECORD = "sitewright.json";
const SPEC = "site.spec.json";
const locks = new Map<string, Promise<unknown>>();

/** Serialise work per project id. Prevents two runs interleaving file writes. */
export function withProjectLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    id,
    next.catch(() => undefined),
  );
  void next.finally(() => {
    // Drop the entry once this is the tail, so the map does not grow forever.
    if (locks.get(id) === next) locks.delete(id);
  });
  return next;
}

export function projectDir(id: string): string {
  return path.join(config().generatedDir, safeFileSegment(id, "project"));
}

export function specPath(id: string): string {
  return path.join(projectDir(id), SPEC);
}

export function recordPath(id: string): string {
  return path.join(projectDir(id), RECORD);
}

/** Newest first. */
export async function listProjects(): Promise<ProjectRecord[]> {
  const root = config().generatedDir;
  let entries: string[];
  try {
    entries = await fsp.readdir(root);
  } catch {
    return [];
  }
  const out: ProjectRecord[] = [];
  for (const name of entries) {
    if (name.startsWith("_") || name.startsWith(".")) continue;
    const rec = await readRecord(name).catch(() => null);
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function readRecord(id: string): Promise<ProjectRecord | null> {
  try {
    const raw = await fsp.readFile(recordPath(id), "utf8");
    return JSON.parse(raw) as ProjectRecord;
  } catch {
    return null;
  }
}

async function writeAtomic(file: string, data: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, data, "utf8");
  await fsp.rename(tmp, file);
}

export async function writeRecord(rec: ProjectRecord): Promise<ProjectRecord> {
  rec.updatedAt = new Date().toISOString();
  await writeAtomic(recordPath(rec.id), `${JSON.stringify(rec, null, 2)}\n`);
  return rec;
}

/** Read-modify-write under the project lock. */
export async function updateRecord(
  id: string,
  patch: (rec: ProjectRecord) => ProjectRecord | void,
): Promise<ProjectRecord> {
  return withProjectLock(id, async () => {
    const existing = (await readRecord(id)) ?? newRecord(id, "about:blank");
    const next = patch(existing) ?? existing;
    next.id = id;
    return writeRecord(next);
  });
}

export function newRecord(id: string, sourceUrl: string): ProjectRecord {
  const now = new Date().toISOString();
  return {
    id,
    sourceUrl,
    finalUrl: sourceUrl,
    title: "",
    status: "queued",
    createdAt: now,
    updatedAt: now,
    modelTrail: [],
    aiCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    sectionCount: 0,
    sectionKinds: [],
    screenshots: [],
    assets: { downloaded: 0, missing: 0, total: 0 },
    modifications: [],
  };
}

/**
 * Validate a project id arriving from the network.
 *
 * Ids become directory names, so anything that is not already in the shape this
 * module mints is rejected outright. Sanitising instead of validating would be
 * the wrong trade here: a request for `../../etc` would then address a real
 * directory that simply happens not to contain a project, and the 404 becomes
 * indistinguishable from a typo.
 */
export function safeProjectId(id: string | null | undefined): string | null {
  if (typeof id !== "string" || !id) return null;
  if (id.length > 80) return null;
  // The mint is `<host>-<yyyymmddhhmmss>-<4 hex>`, and the host keeps its dots
  // because a hostname is the most useful thing to read in a project list. A
  // stricter pattern here rejected every real id the store had ever produced,
  // which is why this is tested against a generated id rather than a
  // hand-written one.
  if (!/^[a-z0-9][a-z0-9.-]{0,79}$/.test(id)) return null;
  // Rejected separately: the pattern above permits dots anywhere, so ".." and
  // "." have to be excluded explicitly or they address the parent directory.
  if (id.includes("..")) return null;
  return id;
}

/** Short, sortable, filesystem-safe id derived from the host plus time. */
export function makeProjectId(sourceUrl: string): string {
  let host = "site";
  try {
    host = new URL(sourceUrl).hostname.replace(/^www\./, "");
  } catch {
    /* keep the default */
  }
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${safeFileSegment(host, "site").slice(0, 28)}-${stamp}-${randomUUID().slice(0, 4)}`;
}

// ------------------------------------------------------------------ the spec

export async function readSpec(id: string): Promise<WebsiteSpec> {
  const raw = await fsp.readFile(specPath(id), "utf8");
  const parsed = WebsiteSpecSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `Stored spec for ${id} is invalid: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

export async function writeSpec(id: string, spec: WebsiteSpec): Promise<string> {
  const file = specPath(id);
  await writeAtomic(file, `${JSON.stringify(spec, null, 2)}\n`);
  return file;
}

/** Read-modify-write the spec under the project lock. */
export async function updateSpec<T>(
  id: string,
  patch: (spec: WebsiteSpec) => { spec: WebsiteSpec; result: T } | Promise<{ spec: WebsiteSpec; result: T }>,
): Promise<T> {
  return withProjectLock(id, async () => {
    const current = await readSpec(id);
    const { spec, result } = await patch(current);
    await writeSpec(id, spec);
    return result;
  });
}

export async function deleteProject(id: string): Promise<void> {
  await withProjectLock(id, async () => {
    await fsp.rm(projectDir(id), { recursive: true, force: true });
    log.info("project deleted", { id });
  });
}

/** Bytes on disk, for the project list. Cheap enough for a directory listing. */
export async function projectSize(id: string): Promise<number> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else {
        const st = await fsp.stat(abs).catch(() => null);
        if (st) total += st.size;
      }
    }
  };
  await walk(projectDir(id));
  return total;
}
