/**
 * Central, typed configuration for the whole agent.
 *
 * Everything that a user may reasonably want to switch (AI provider, model,
 * ports, timeouts, retry budgets) lives here and is overridable through the
 * environment. A `.env` file in the project root is loaded so that CLI
 * scripts, tests and the Next.js panel agree on the same configuration; real
 * environment variables always win over the file. No secret is hardcoded in
 * this module, so it stays import-safe from both Next.js server code and plain
 * `node --test` scripts.
 */

import fs from "node:fs";
import path from "node:path";

function env(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

const repoRoot = path.resolve(process.cwd());

/** Parse the repo's `.env` into the process environment when present. */
function loadDotEnv(root: string): void {
  const file = path.join(root, ".env");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return; // no .env file — everything from the real environment
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (!key) continue;
    // Strip optional surrounding quotes (single or double).
    if (value.length >= 2) {
      const first = value[0];
      if ((first === '"' || first === "'") && value.endsWith(first)) {
        value = value.slice(1, -1);
      }
    }
    // Only fill in variables that were not already provided by the real
    // environment: exported vars must always win over the file.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(repoRoot);

export type ProviderName = "opencode" | "openai-compatible";

export interface AIConfig {
  /** Which provider implementation backs the `AIProvider` interface. */
  provider: ProviderName;
  /**
   * Preferred model for the configured provider, in `provider/model` form.
   * Empty string means "discover the best currently-available free model".
   */
  model: string;
  /** Optional per-operation override, also `provider/model` or bare model id. */
  models: {
    analyze: string;
    generate: string;
    modify: string;
    repair: string;
  };
  /**
   * Fallback chain used when the preferred model errors transiently.
   * Empty means "derive from live discovery at call time".
   */
  fallbacks: string[];
  /** How many distinct models a single logical operation may try. */
  maxModelAttempts: number;
  /** Per-attempt timeout. */
  requestTimeoutMs: number;
  /** Retries per model before rotating. */
  retriesPerModel: number;
  retryBaseDelayMs: number;
  /** How long a discovered-model snapshot is reused before re-probing. */
  modelCacheTtlMs: number;
  /** Hard cap on structured-output attempts (parse + validate + repair). */
  maxStructureAttempts: number;
  /**
   * When true, never call a model whose published input/output cost is not
   * both zero. A pay-per-token call is a failed run.
   */
  freeOnly: boolean;
  /** Attach the reference screenshot to the analysis prompt (multimodal). */
  useVision: boolean;
  /** How many of the largest section screenshots to attach. */
  maxSectionImages: number;
  /**
   * How much code the model authors.
   *
   *   spec      the page is a deterministic projection of the spec. The model's
   *             influence is in the spec and in the composition order only.
   *   ai-page   the model additionally authors `app/page.tsx` as JSX over the
   *             generated components, with a build-time fallback to `spec`.
   */
  mode: "spec" | "ai-page";
  opencode: {
    /** Directory the OpenCode CLI is invoked from (a scratch project). */
    workspaceDir: string;
    bin: string;
  };
  openaiCompatible: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
}

export interface AppConfig {
  repoRoot: string;
  /** Where generated projects, artifacts and the store live. */
  dataDir: string;
  generatedDir: string;
  port: number;
  /** First port of the preview-server range. */
  previewPortStart: number;
  previewPortEnd: number;
  ai: AIConfig;
  crawl: {
    navigationTimeoutMs: number;
    perPageTimeoutMs: number;
    maxAssetBytes: number;
    maxAssets: number;
    userAgent: string;
    /** Stop the crawler from wandering into private/loopback address space. */
    allowPrivateHosts: boolean;
  };
  validation: {
    buildTimeoutMs: number;
    typecheckTimeoutMs: number;
    runtimeTimeoutMs: number;
    maxRepairAttempts: number;
  };
  logLevel: "debug" | "info" | "warn" | "error";
}

function buildConfig(): AppConfig {
  const dataDir = path.resolve(env("SITEWRIGHT_DATA_DIR") ?? path.join(repoRoot, "data"));
  const generatedDir = path.resolve(
    env("SITEWRIGHT_GENERATED_DIR") ?? path.join(repoRoot, "generated"),
  );
  const provider = (env("AI_PROVIDER") ?? "opencode").toLowerCase() as ProviderName;
  if (provider !== "opencode" && provider !== "openai-compatible") {
    throw new Error(`AI_PROVIDER must be "opencode" or "openai-compatible", got "${provider}"`);
  }
  return {
    repoRoot,
    dataDir,
    generatedDir,
    port: envInt("PORT", 4310),
    previewPortStart: envInt("PREVIEW_PORT_START", 4320),
    previewPortEnd: envInt("PREVIEW_PORT_END", 4339),
    logLevel: (env("LOG_LEVEL") as AppConfig["logLevel"]) ?? "info",
    ai: {
      provider,
      model: env("AI_MODEL") ?? "",
      models: {
        analyze: env("AI_MODEL_ANALYZE") ?? "",
        generate: env("AI_MODEL_GENERATE") ?? "",
        modify: env("AI_MODEL_MODIFY") ?? "",
        repair: env("AI_MODEL_REPAIR") ?? "",
      },
      fallbacks: (env("AI_FALLBACK_MODELS") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      maxModelAttempts: Math.max(1, envInt("AI_MAX_MODEL_ATTEMPTS", 4)),
      requestTimeoutMs: envInt("AI_REQUEST_TIMEOUT_MS", 300_000),
      retriesPerModel: Math.max(0, envInt("AI_RETRIES_PER_MODEL", 1)),
      retryBaseDelayMs: envInt("AI_RETRY_BASE_DELAY_MS", 2_500),
      modelCacheTtlMs: envInt("AI_MODEL_CACHE_TTL_MS", 5 * 60_000),
      maxStructureAttempts: Math.max(1, envInt("AI_MAX_STRUCTURE_ATTEMPTS", 3)),
      useVision: envBool("AI_USE_VISION", true),
      freeOnly: envBool("AI_FREE_ONLY", false),
      maxSectionImages: envInt("AI_MAX_SECTION_IMAGES", 2),
      mode: (env("GENERATION_MODE") as "spec" | "ai-page") ?? "spec",
      opencode: {
        workspaceDir: env("OPENCODE_WORKSPACE_DIR") ?? path.join(dataDir, "opencode-workspace"),
        bin: env("OPENCODE_BIN") ?? "opencode",
      },
      openaiCompatible: {
        baseUrl: env("OPENAI_BASE_URL") ?? "https://openrouter.ai/api/v1",
        apiKey: env("OPENAI_API_KEY") ?? "",
        model: env("OPENAI_MODEL") ?? "",
      },
    },
    crawl: {
      navigationTimeoutMs: envInt("CRAWL_NAV_TIMEOUT_MS", 45_000),
      perPageTimeoutMs: envInt("CRAWL_TIMEOUT_MS", 90_000),
      maxAssetBytes: envInt("CRAWL_MAX_ASSET_BYTES", 3 * 1024 * 1024),
      maxAssets: envInt("CRAWL_MAX_ASSETS", 60),
      userAgent:
        env("CRAWL_USER_AGENT") ??
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Sitewright/1.0",
      allowPrivateHosts: envBool("ALLOW_PRIVATE_HOSTS", false),
    },
    validation: {
      buildTimeoutMs: envInt("BUILD_TIMEOUT_MS", 300_000),
      typecheckTimeoutMs: envInt("TYPECHECK_TIMEOUT_MS", 180_000),
      runtimeTimeoutMs: envInt("RUNTIME_TIMEOUT_MS", 60_000),
      maxRepairAttempts: Math.max(0, envInt("MAX_REPAIR_ATTEMPTS", 2)),
    },
  };
}

let cached: AppConfig | undefined;

export function config(): AppConfig {
  if (!cached) cached = buildConfig();
  return cached;
}

/** Test seam: force a re-read of the environment. */
export function resetConfig(): void {
  cached = undefined;
}

/** Never log an API key. Only the shape, never the value. */
export function redactSecret(value: string | undefined): string {
  if (!value) return "<unset>";
  return `<set:${value.length} chars>`;
}
