/** `npm run doctor` — environment + provider check, then exit. */
import { config, redactSecret } from "../src/lib/config";
import { attachProjectLog, createLogger } from "../src/lib/logger";
import { checkHealth, listFreeModels } from "../src/lib/ai/models";
import { getProvider } from "../src/lib/ai/index";
import fsp from "node:fs/promises";
import path from "node:path";

async function main(): Promise<void> {
  const log = createLogger("doctor");
  attachProjectLog(path.join(config().dataDir, "sitewright.log"));
  const c = config();

  log.info("environment", {
    repoRoot: c.repoRoot,
    provider: c.ai.provider,
    configuredModel: c.ai.model || "(discover at runtime)",
    mode: c.ai.mode,
    openaiKey: redactSecret(c.ai.openaiCompatible.apiKey),
    logLevel: c.logLevel,
  });

  for (const [label, p] of [
    ["next binary", fsp.stat(path.join(c.repoRoot, "node_modules", ".bin", "next"))],
    ["@tailwindcss/postcss", fsp.stat(path.join(c.repoRoot, "node_modules", "@tailwindcss", "postcss"))],
    ["chromium", fsp.stat(path.join(process.env.HOME ?? "/root", ".cache", "ms-playwright"))],
  ] as [string, Promise<unknown>][]) {
    await p.then(
      () => log.info("found", { what: label }),
      (e) => log.warn("missing", { what: label, error: (e as Error).message }),
    );
  }

  try {
    const health = await checkHealth(getProvider());
    log.info("provider health", { ok: health.ok, detail: health.detail, probe: health.probe?.model });
    if (health.ok) {
      const cat = await listFreeModels(getProvider());
      log.info("model catalogue", {
        listed: cat.total,
        textCapable: cat.all.length,
        verifiablyFree: cat.free.length,
        primary: cat.primary,
        freeModels: cat.free.slice(0, 10).map((m) => m.id),
      });
    }
  } catch (e) {
    log.error("provider check failed", { error: (e as Error).message });
    process.exitCode = 1;
  }
}

main();
