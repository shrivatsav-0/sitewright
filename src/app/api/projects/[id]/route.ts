/**
 * A single project: its run record, its spec, or its deletion.
 *
 * The spec is served alongside the record because the panel renders both from
 * one response, and the spec is the thing being demonstrated - the generated
 * project is on disk, but the spec is what explains how the clone was decided.
 */

import { NextResponse } from "next/server";
import { deleteProject, readRecord, readSpec, safeProjectId } from "@/lib/store/projects";
import { isRunning } from "@/lib/preview/server";
import { stopPreview } from "@/lib/preview/server";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  // The id reaches the filesystem, so it is validated before any path is built
  // from it rather than after.
  const safe = safeProjectId(id);
  if (!safe) return NextResponse.json({ error: "Invalid project id." }, { status: 400 });

  const record = await readRecord(safe);
  if (!record) return NextResponse.json({ error: "No such project." }, { status: 404 });

  const preview = isRunning(safe);
  let spec: unknown = null;
  if (record.status === "ready" || record.specPath) {
    spec = await readSpec(safe).catch(() => null);
  }
  return NextResponse.json({ project: { ...record, previewPort: preview?.port ?? record.previewPort }, spec });
}

export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  const safe = safeProjectId(id);
  if (!safe) return NextResponse.json({ error: "Invalid project id." }, { status: 400 });

  stopPreview(safe);
  await deleteProject(safe);
  return NextResponse.json({ ok: true });
}
