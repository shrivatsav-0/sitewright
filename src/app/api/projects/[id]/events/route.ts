/**
 * Live progress for one run, as Server-Sent Events.
 *
 * SSE rather than a websocket because the traffic is one-directional and the
 * panel must survive the tab being closed and reopened mid-run: the emitter
 * keeps the full event history, and every new connection is replayed from the
 * start of the run, so a reconnecting client is never left with a partial log.
 */

import { safeProjectId, readRecord, type RunStatus } from "@/lib/store/projects";
import { history, subscribe } from "@/lib/store/pipeline";

export const runtime = "nodejs";
/** A generate run can take several minutes; this must not be cut short. */
export const maxDuration = 300;

const TERMINAL = new Set(["ready", "failed", "cancelled"]);

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const safe = safeProjectId(id);
  if (!safe) return new Response("Invalid project id.", { status: 400 });

  /**
   * Decide, before the stream exists, whether there is anything to wait for.
   *
   * `history` is in-memory only: after a server restart no emitter survives,
   * and a client that keeps streaming against a ghost id would otherwise hang
   * on comment frames forever, leaking one connection per ghost. The disk
   * record - which every emit also writes - settles the three cases:
   *
   *   - history is empty and no record exists: the run never started. Send a
   *     terminal notfound frame and close, so the panel can stop immediately.
   *   - history is empty but a record exists: the process that ran it is gone.
   *     A queued/running record cannot finish itself, so report the
   *     interruption honestly instead of streaming forever.
   *   - history is non-empty: a live run, replayed and subscribed as before.
   */
  const replayed = history(safe);
  const record = replayed.length === 0 ? await readRecord(safe) : null;
  const offline: RunStatus | "notfound" =
    !record ? "notfound"
    : !TERMINAL.has(record.status) ? "failed"
    : record.status;

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let keepAlive: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode("data: " + JSON.stringify(event) + "\n\n"));
        } catch {
          closed = true;
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        unsubscribe = null;
        if (keepAlive) clearInterval(keepAlive);
        keepAlive = null;
        try {
          controller.close();
        } catch {
          /* the client went away first */
        }
      };

      // Offline cases close immediately with one terminal frame.
      if (replayed.length === 0) {
        send({
          at: record?.updatedAt ?? new Date().toISOString(),
          status: offline,
          message:
            !record
              ? "No project with this id was ever started."
              : offline === "failed"
                ? "The run was interrupted before it finished (its process is gone)."
                : record?.error ?? "The run has finished.",
        });
        cleanup();
        return;
      }

      // Replay first, so a client that connects late still sees the whole run.
      for (const event of replayed) send(event);

      unsubscribe = subscribe(safe, (event) => {
        send(event);
        // A finished run has nothing left to say, so the stream is closed. The
        // client reads the terminal status off the last frame and stops
        // reconnecting; until it does, EventSource redials and receives the
        // replayed history, which is idempotent.
        if (TERMINAL.has(event.status)) cleanup();
      });

      // Proxies and load balancers drop idle connections, and a run can sit
      // quiet for a while mid-crawl. A comment frame every 20s keeps the pipe
      // open without looking like an event to the client.
      keepAlive = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          closed = true;
        }
      }, 20_000);

      request.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      unsubscribe?.();
      if (keepAlive) clearInterval(keepAlive);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Nginx buffers SSE by default, which turns live progress into a single
      // dump delivered at the end.
      "x-accel-buffering": "no",
    },
  });
}
