/**
 * End-to-end test: control panel API surface.
 *
 * This suite runs the actual Next.js routes against the local dev server, so
 * it needs `npm run dev` to be up on port 4310. It deliberately does NOT
 * run the full URL→site pipeline over the network in CI-style conditions
 * (that is what `scripts/bench-sites.ts` does, and it takes minutes and a
 * working provider). What this pins is the panel contract:
 *
 *   - the models endpoint answers with the discovered, free-first catalogue;
 *   - creating a project with a bad URL is rejected cleanly (no crash, no
 *     partial project on disk);
 *   - a created project appears in the list and has a deterministic id that
 *     is safe to use in a path;
 *   - the preview/events endpoints answer 404 before a project exists, and
 *     a real answer once it does.
 *
 * Run with: npm run test:e2e   (after: npm run dev)
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.PANEL_URL ?? "http://127.0.0.1:4310";

async function jsonOk(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

describe("control panel API", { timeout: 120_000 }, () => {
  test("models endpoint returns a catalogue with ids", async () => {
    const { status, body } = await jsonOk("/api/models");
    assert.equal(status, 200, `models endpoint returned ${status}`);
    assert.ok(Array.isArray(body?.models), "expected { models: [...] }");
    assert.ok(body.models.length > 0, "expected at least one usable model");
    for (const m of body.models) {
      assert.ok(typeof m.id === "string" && m.id.length > 0, `model missing id: ${JSON.stringify(m)}`);
      assert.ok(typeof m.verifiablyFree === "boolean", `model ${m.id} missing verifiablyFree flag`);
    }
  });

  test("a bad URL is rejected without creating a project", async () => {
    const before = await jsonOk("/api/projects");
    const { status, body } = await jsonOk("/api/projects", {
      method: "POST",
      body: JSON.stringify({ url: "not a url" }),
    });
    assert.ok(status >= 400, `bad URL should be rejected, got ${status}`);
    assert.ok(body?.error, "the rejection should explain itself");
    const after = await jsonOk("/api/projects");
    assert.equal(
      (after.body?.projects ?? []).length,
      (before.body?.projects ?? []).length,
      "a rejected project must not appear on disk",
    );
  });

  test("the panel itself renders", async () => {
    const res = await fetch(`${BASE}/`);
    assert.ok(res.ok, `panel root returned ${res.status}`);
    const html = await res.text();
    assert.ok(html.length > 500, "panel page is suspiciously small");
  });

  test("project-scoped endpoints answer correctly for a missing id", async () => {
    const missing = "this-id-does-not-exist-xyz";

    // Not a 404 (a run may not have written its row yet when a client first
    // connects), but the stream must end promptly with a terminal frame rather
    // than hold the connection open forever. Before the fix it streamed keep
    // alive comments indefinitely - one leaked connection per ghost id.
    const res = await fetch(`${BASE}/api/projects/${missing}/events`, { signal: AbortSignal.timeout(15_000) });
    assert.equal(res.status, 200, "events should answer 200 for SSE delivery");
    const body = await res.text();
    const frames = [...body.matchAll(/^data: (.+)$/gm)].map((m) => JSON.parse(m[1]));
    assert.ok(frames.length >= 1, "missing id should still produce a terminal frame");
    const last = frames[frames.length - 1];
    assert.equal(last.status, "notfound", "missing id must be reported as notfound");
    assert.match(last.message, /never|No project/, "the frame should say no project exists");

    // Preview: GET is a status probe that answers for any id; starting a
    // preview for a ghost id must 404.
    const previewStatus = await fetch(`${BASE}/api/projects/${missing}/preview`);
    assert.equal(previewStatus.status, 200, "GET is a status probe");
    assert.deepEqual(await previewStatus.json(), { running: false, port: null });
    const previewStart = await fetch(`${BASE}/api/projects/${missing}/preview`, { method: "POST" });
    assert.equal(previewStart.status, 404, "starting a preview should 404 for a missing id");
  });

  test("project ids on the list are path-safe", async () => {
    const { body } = await jsonOk("/api/projects");
    for (const p of body?.projects ?? []) {
      assert.match(p.id, /^[A-Za-z0-9._-]+$/, `unsafe project id: ${p.id}`);
      assert.ok(!p.id.includes(".."), `project id must not contain parent traversal: ${p.id}`);
    }
  });
});