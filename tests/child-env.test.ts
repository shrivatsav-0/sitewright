/**
 * Nested Next-process environment tests.
 *
 * The panel runs inside `next dev`, and a spawned `next build` / `next start`
 * that inherits the dev server's process env misroutes its own internals.
 * This was a real production failure, not a hypothetical: the generated
 * site's build died during prerendering of the pages-router `/404` with
 * `<Html> should not be imported outside of pages/_document.` every time it
 * was spawned from the panel, while the identical files built cleanly from a
 * fresh shell. `childEnv` exists so the nested process is a separate
 * compilation with a deterministic environment, and these tests pin exactly
 * what it strips and what it keeps.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { childEnv } from "../src/lib/child-env";

const HOSTING = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/shiro",
  LANG: "C.UTF-8",
  TMPDIR: "/tmp",
  NODE_ENV: "development",
  CI: "0",

  // Every variable the hosting `next dev` process carries that must NOT reach
  // the child (this is the exact set observed in the panel server's environ).
  NEXT_RUNTIME: "nodejs",
  NEXT_PRIVATE_WORKER: "1",
  NEXT_PRIVATE_TRACE_ID: "736cb3cb898504ad",
  NODE_CHANNEL_FD: "3",
  NODE_CHANNEL_SERIALIZATION_MODE: "json",
  NODE_OPTIONS: "--max-old-space-size=7697 --enable-source-maps",
} as NodeJS.ProcessEnv;

describe("childEnv", () => {
  test("strips every Next-internal variable", () => {
    const out = childEnv(HOSTING);
    for (const key of ["NEXT_RUNTIME", "NEXT_PRIVATE_WORKER", "NEXT_PRIVATE_TRACE_ID"]) {
      assert.ok(!(key in out), `${key} leaked into the nested build`);
    }
  });

  test("strips inherited IPC channel handles and dev heap flags", () => {
    const out = childEnv(HOSTING);
    assert.ok(!("NODE_CHANNEL_FD" in out), "IPC channel fd leaked");
    assert.ok(!("NODE_CHANNEL_SERIALIZATION_MODE" in out), "IPC serialization leaked");
    assert.ok(!("NODE_OPTIONS" in out), "dev-tuned NODE_OPTIONS leaked");
  });

  test("forces the constants a standalone build needs", () => {
    const out = childEnv(HOSTING);
    assert.equal(out.NODE_ENV, "production");
    assert.equal(out.CI, "1");
    assert.equal(out.NEXT_TELEMETRY_DISABLED, "1");
  });

  test("keeps ordinary, unrelated variables", () => {
    const out = childEnv(HOSTING);
    assert.equal(out.PATH, "/usr/bin:/bin");
    assert.equal(out.HOME, "/home/shiro");
    assert.equal(out.LANG, "C.UTF-8");
    assert.equal(out.TMPDIR, "/tmp");
  });

  test("does not share state with the input", () => {
    const out = childEnv(HOSTING);
    out.PATH = "/mutated";
    assert.equal((HOSTING as Record<string, string>).PATH, "/usr/bin:/bin", "mutating the child env changed the source");
  });
});