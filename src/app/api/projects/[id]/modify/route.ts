/**
 * Natural-language modification of an existing project.
 *
 * This is the targeted path, not a regeneration: the request is turned into a
 * patch against the spec, applied with per-operation rollback, and only the
 * affected files are re-emitted. A full re-clone would re-crawl the site, re-pay
 * for the model calls and re-download every asset to change one heading.
 *
 * The run is detached like generation, because rebuilding after a patch takes
 * as long as a build.
 */

import { NextResponse } from "next/server";
import { safeProjectId } from "@/lib/store/projects";
import { runModification } from "@/lib/store/pipeline";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const safe = safeProjectId(id);
  if (!safe) return NextResponse.json({ error: "Invalid project id." }, { status: 400 });

  let text = "";
  try {
    const body = (await request.json()) as { request?: unknown };
    text = typeof body.request === "string" ? body.request.trim() : "";
  } catch {
    return NextResponse.json({ error: "Expected a JSON body with a `request` field." }, { status: 400 });
  }

  // Bounded before it reaches the model, so an accidental paste of a whole page
  // cannot turn into a 200k-token call.
  if (!text) return NextResponse.json({ error: "Describe the change you want." }, { status: 400 });
  if (text.length > 2000) {
    return NextResponse.json({ error: "Keep the request under 2000 characters." }, { status: 400 });
  }

  runModification({ id: safe, request: text, rebuild: true }).catch(() => undefined);
  return NextResponse.json({ accepted: true }, { status: 202 });
}
