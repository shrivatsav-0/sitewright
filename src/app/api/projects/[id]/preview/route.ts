/**
 * Preview server lifecycle for one project.
 *
 * The generated site is served by its own `next start` on a port from the
 * configured range, which is what makes the preview an honest demonstration:
 * it is the real build output, running as a standalone app, not a re-render
 * inside the control panel.
 */

import { NextResponse } from "next/server";
import { projectDir, readRecord, safeProjectId, updateRecord } from "@/lib/store/projects";
import { invalidatePreview, isRunning, startPreview, stopPreview } from "@/lib/preview/server";

export const runtime = "nodejs";
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const safe = safeProjectId(id);
  if (!safe) return NextResponse.json({ error: "Invalid project id." }, { status: 400 });
  const handle = isRunning(safe);
  return NextResponse.json({ running: !!handle, port: handle?.port ?? null });
}

export async function POST(_request: Request, { params }: Params) {
  const { id } = await params;
  const safe = safeProjectId(id);
  if (!safe) return NextResponse.json({ error: "Invalid project id." }, { status: 400 });

  const record = await readRecord(safe);
  if (!record) return NextResponse.json({ error: "No such project." }, { status: 404 });

  try {
    const handle = await startPreview(safe, projectDir(safe));
    await updateRecord(safe, (rec) => {
      rec.previewPort = handle.port;
      return rec;
    });
    return NextResponse.json({ running: true, port: handle.port });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not start the preview." },
      { status: 409 },
    );
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  const safe = safeProjectId(id);
  if (!safe) return NextResponse.json({ error: "Invalid project id." }, { status: 400 });

  stopPreview(safe);
  // A rebuilt project has new output; the next preview must serve the new build
  // rather than a process still holding the old one open.
  invalidatePreview(safe);
  await updateRecord(safe, (rec) => {
    rec.previewPort = undefined;
    return rec;
  });
  return NextResponse.json({ running: false });
}
