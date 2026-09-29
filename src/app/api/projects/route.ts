/**
 * Project collection: list runs, and start a new one.
 *
 * A generate run takes 60-200s - crawl, five model calls, asset downloads, and
 * a full Next build. It is therefore started here and left running; progress is
 * read from the per-project SSE stream rather than by holding this request
 * open, so a closed browser tab never aborts a run.
 */

import { NextResponse } from "next/server";
import { InvalidUrlError, normaliseInput } from "@/lib/security";
import { listProjects, makeProjectId } from "@/lib/store/projects";
import { runPipeline } from "@/lib/store/pipeline";

export const runtime = "nodejs";
/** Generation outlives any single request; the browser polls the event stream. */
export const maxDuration = 60;

export async function GET() {
  const projects = await listProjects();
  return NextResponse.json({ projects });
}

export async function POST(request: Request) {
  let raw = "";
  try {
    const body = (await request.json()) as { url?: unknown };
    raw = typeof body.url === "string" ? body.url : "";
  } catch {
    return NextResponse.json({ error: "Expected a JSON body with a `url` field." }, { status: 400 });
  }

  // Validated here as well as in the crawler so a bad URL is a 400 the UI can
  // show immediately, rather than a failure three stages into a two-minute run.
  let target: ReturnType<typeof normaliseInput>;
  try {
    target = normaliseInput(raw);
  } catch (error) {
    const message = error instanceof InvalidUrlError ? error.message : "That URL cannot be used.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const id = makeProjectId(target.href);
  // Detached on purpose: the run's own progress is streamed over SSE, and an
  // unhandled rejection would otherwise take the dev server down. Failures are
  // recorded on the project record by the pipeline itself.
  runPipeline({ url: target.href, projectId: id }).catch(() => undefined);

  return NextResponse.json({ id, sourceUrl: target.href }, { status: 202 });
}
