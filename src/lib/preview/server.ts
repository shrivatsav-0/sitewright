/**
 * Preview servers.
 *
 * A generated project is a real Next.js app, so previewing it means really
 * serving it: `next build` once, then `next start` on a port from a small
 * reserved range. Nothing is proxied, stubbed, or rendered from a screenshot —
 * the preview is the generated code running.
 *
 * The server is owned by the store: one per project, started on demand, reused
 * across regenerations and modifications, and stopped when the process exits.
 * `next start` serves from `.next`, so a rebuild is picked up by a restart.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { config } from "../config";
import { createLogger } from "../logger";
import { childEnv } from "../child-env";

const log = createLogger("preview");

export interface PreviewHandle {
  id: string;
  port: number;
  url: string;
  pid: number;
  startedAt: number;
}

const running = new Map<string, PreviewHandle>();
const children = new Map<string, ChildProcess>();
/** Ports already claimed, so two projects never collide mid-run. */
const claimed = new Set<number>();

export function isRunning(id: string): PreviewHandle | null {
  const h = running.get(id);
  if (!h) return null;
  return h;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function pickPort(): Promise<number> {
  const { previewPortStart, previewPortEnd } = config();
  for (let p = previewPortStart; p <= previewPortEnd; p++) {
    if (claimed.has(p)) continue;
    if (await portFree(p)) {
      claimed.add(p);
      return p;
    }
  }
  throw new Error(
    `No free port in the preview range ${previewPortStart}-${previewPortEnd}. Stop an existing preview and try again.`,
  );
}

/**
 * Start (or reuse) the preview server for a project.
 *
 * The build output must already exist; this function does not build. A stale
 * `.next` from a failed build is detected and reported rather than served, so a
 * "preview" is never silently the previous version.
 */
export async function startPreview(id: string, projectDir: string): Promise<PreviewHandle> {
  const existing = running.get(id);
  if (existing && (await isAlive(existing.pid))) {
    log.debug("preview already running", { id, port: existing.port });
    return existing;
  }
  if (existing) {
    stopPreview(id);
  }

  const buildId = await fsp
    .readFile(path.join(projectDir, ".next", "BUILD_ID"), "utf8")
    .then((s) => s.trim())
    .catch(() => "");
  if (!buildId) {
    throw new Error("This project has no successful build yet, so there is nothing to preview.");
  }

  const nextBin = path.join(config().repoRoot, "node_modules", ".bin", "next");
  const port = await pickPort();

  const child = spawn(nextBin, ["start", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: projectDir,
    // Clean environment: this `next start` is a fresh server, and inheriting
    // the hosting process's IPC channels / Next-internal flags (see
    // src/lib/child-env.ts) can desync it from the process that spawned it.
    env: childEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  let log_ = "";
  child.stdout?.on("data", (c) => (log_ = (log_ + c.toString()).slice(-4000)));
  child.stderr?.on("data", (c) => (log_ = (log_ + c.toString()).slice(-4000)));

  const exited = new Promise<never>((_, reject) => {
    child.once("error", (err) => {
      claimed.delete(port);
      reject(new Error(`Could not start the preview server: ${err.message}`));
    });
    child.once("exit", (code) => {
      claimed.delete(port);
      running.delete(id);
      children.delete(id);
      reject(new Error(`Preview server exited (code ${code}). ${log_.slice(-500)}`));
    });
  });

  // Wait until the port answers, or give up. A bounded wait, never a hang.
  const ready = waitForHttp(`http://127.0.0.1:${port}/`, config().validation.runtimeTimeoutMs);
  await Promise.race([ready, exited]);

  const handle: PreviewHandle = {
    id,
    port,
    url: `http://127.0.0.1:${port}`,
    pid: child.pid ?? -1,
    startedAt: Date.now(),
  };
  running.set(id, handle);
  children.set(id, child);
  log.info("preview started", { id, port, buildId });
  return handle;
}

export function stopPreview(id: string): boolean {
  const child = children.get(id);
  const handle = running.get(id);
  if (handle) claimed.delete(handle.port);
  running.delete(id);
  children.delete(id);
  if (!child || child.killed) return false;
  child.kill("SIGTERM");
  // Escalate if it does not go quietly.
  setTimeout(() => {
    if (!child.killed) child.kill("SIGKILL");
  }, 3000).unref?.();
  log.info("preview stopped", { id });
  return true;
}

export function stopAll(): void {
  for (const id of Array.from(children.keys())) stopPreview(id);
}

export function listPreviews(): PreviewHandle[] {
  return Array.from(running.values());
}

/** Force the next startPreview to actually restart the server. */
export function invalidatePreview(id: string): void {
  stopPreview(id);
}

async function isAlive(pid: number): Promise<boolean> {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      // Any HTTP status means the server is listening.
      if (res.status > 0) {
        await res.arrayBuffer().catch(() => undefined);
        return;
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await sleep(250);
  }
  throw new Error(`Preview server did not become reachable within ${Math.round(timeoutMs / 1000)}s. ${lastErr}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// The control panel owns the lifetime of every preview server.
if (typeof process !== "undefined" && !process.env.SITEWRIGHT_NO_EXIT_HOOK) {
  const cleanup = () => stopAll();
  process.once("exit", cleanup);
  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
}
