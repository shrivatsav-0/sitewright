/**
 * Environment for a spawned Next process (nested `next build` / `next start`).
 *
 * A spawned Next process must never inherit the environment of a running Next
 * process. The panel's dev server sets internal variables in its own process
 * env - `NEXT_RUNTIME`, `NEXT_PRIVATE_*`, `NODE_CHANNEL_*`,
 * `NODE_ENV=development`, and a dev-tuned `NODE_OPTIONS` heap - and a child
 * `next build` that inherits them can misroute its own internals. This bit in
 * production and was reproduced locally: the generated site's build died
 * during prerendering of the pages-router `/404` with
 * `<Html> should not be imported outside of pages/_document.` when the child
 * inherited the dev server's env, while the very same files built cleanly from
 * a fresh shell. The nested build is a separate compiler invocation with no
 * relationship to the parent; it gets a deterministic, clean environment.
 *
 * `next start` is sanitised for the same reason: its IPC channel handles and
 * runtime flags belong to the process that owns them, not to the server that
 * happens to spawn it.
 */

/**
 * Copy `env` (default: the current process environment) minus the state of the
 * hosting Next process, with the constants a correct standalone build needs.
 * Returned as a fresh object so callers can spread in extras.
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    // Next-internal state belongs to the parent process, not the child.
    if (/^NEXT_/i.test(key)) continue;
    // IPC channel file descriptors are not transferable to a child.
    if (/^NODE_CHANNEL/i.test(key)) continue;
    // Heap/loader flags were tuned for the server; let the child pick its own.
    if (/^NODE_OPTIONS$/i.test(key)) continue;
    out[key] = value;
  }
  return {
    ...out,
    // A nested build is a fresh production compiler, and `next start` is a
    // fresh production server - in neither case is it "development".
    NODE_ENV: "production",
    // Deterministic, quiet, profile-free builds.
    CI: "1",
    NEXT_TELEMETRY_DISABLED: "1",
  };
}