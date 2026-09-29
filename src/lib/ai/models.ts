/**
 * Model discovery, selection and rotation.
 *
 * Requirements this file exists to satisfy:
 *   1. Never hardcode a list of free models. Ask the provider what is
 *      available at the moment of use.
 *   2. Honour an explicitly configured primary model.
 *   3. When a transient provider/model error occurs, automatically move on to
 *      another *currently available* free model instead of failing the run.
 *   4. Log which model actually served each operation.
 *
 * Pricing is not taken on faith: we read cost data from the live model
 * catalogue (models.dev) and only treat a model as "free" when its reported
 * input and output cost are both zero. When pricing cannot be verified we do
 * not silently assume free — we mark it unknown and let the configured
 * preference order decide.
 */

import { createLogger } from "../logger";
import { config } from "../config";
import { classifyModel } from "./capabilities";
import { AIError, classifyProviderError, isRetryable } from "./errors";
import type {
  AIProvider,
  CompletionRequest,
  CompletionResult,
  DiscoveredModel,
} from "./provider";

const log = createLogger("ai/models");

/** Public, keyless model-pricing catalogue maintained by models.dev. */
const PRICING_URL = "https://models.dev/api.json";
const PRICING_TTL_MS = 6 * 60 * 60 * 1000;

type PricingIndex = Map<string, { costIn: number | null; costOut: number | null; limit?: any }>;

let pricingCache: { at: number; index: PricingIndex } | null = null;

async function loadPricing(): Promise<PricingIndex> {
  if (pricingCache && Date.now() - pricingCache.at < PRICING_TTL_MS) return pricingCache.index;
  const index: PricingIndex = new Map();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(PRICING_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = (await res.json()) as Record<string, { models?: Record<string, any> }>;
    for (const [providerId, provider] of Object.entries(raw)) {
      for (const [modelId, model] of Object.entries(provider.models ?? {})) {
        // Key by both the bare id and the provider-qualified id so lookups work
        // regardless of which form the provider hands us.
        for (const key of [modelId, `${providerId}/${modelId}`]) {
          index.set(key, {
            costIn: numberOrNull(model?.cost?.input),
            costOut: numberOrNull(model?.cost?.output),
            limit: model?.limit,
          });
        }
      }
    }
    pricingCache = { at: Date.now(), index };
    log.debug("pricing catalogue loaded", { models: index.size });
  } catch (err) {
    log.warn("pricing catalogue unavailable; falling back to configured order", {
      error: (err as Error).message,
    });
  }
  return index;
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export interface Selection {
  /** The model to try first, or undefined when nothing is available. */
  primary?: DiscoveredModel;
  /** Ordered candidate list including `primary`. */
  candidates: DiscoveredModel[];
  /** Models we could not confirm as free (pricing unknown or non-zero). */
  unverifiedFree: DiscoveredModel[];
  discoveredAt: string;
  /** Models reported available by the provider but rejected by our filter. */
  rejected: { id: string; reason: string }[];
  source: "config" | "discovery" | "none";
}

interface Snapshot {
  at: number;
  available: DiscoveredModel[];
}

const snapshots = new Map<string, Snapshot>();

async function discoverWithCache(
  provider: AIProvider,
  force = false,
): Promise<DiscoveredModel[]> {
  const key = provider.name;
  const cached = snapshots.get(key);
  if (!force && cached && Date.now() - cached.at < config().ai.modelCacheTtlMs) {
    return cached.available;
  }
  const models = await provider.discoverModels();
  snapshots.set(key, { at: Date.now(), available: models });
  return models;
}

export function invalidateModelCache(providerName?: string): void {
  if (providerName) snapshots.delete(providerName);
  else snapshots.clear();
}

function normaliseId(raw: string, providerName: string): { provider: string; model: string } {
  const id = raw.trim();
  const slash = id.indexOf("/");
  if (slash > 0) {
    return { provider: id.slice(0, slash), model: id.slice(slash + 1) };
  }
  return { provider: providerName, model: id };
}

function attachPricing(model: DiscoveredModel, pricing: PricingIndex): DiscoveredModel & {
  pricingVerified: boolean;
} {
  const hit = pricing.get(`${model.provider}/${model.model}`) ?? pricing.get(model.model);
  if (!hit) {
    return { ...model, costIn: null, costOut: null, isFree: false, pricingVerified: false };
  }
  const free = hit.costIn === 0 && hit.costOut === 0;
  return {
    ...model,
    costIn: hit.costIn,
    costOut: hit.costOut,
    isFree: free,
    contextWindow: hit.limit?.context ?? model.contextWindow,
    maxOutput: hit.limit?.output ?? model.maxOutput,
    pricingVerified: true,
  };
}

export interface SelectOptions {
  /** Configured model for this specific operation. */
  preferred?: string;
  operation: string;
  /** Force a fresh discovery round-trip. */
  refresh?: boolean;
}

/**
 * Drop every model that is not verifiably free ($0 input AND $0 output),
 * recording why each was removed. Used by `selectModels` when `AI_FREE_ONLY`
 * is set. Kept as a pure function so the guarantee is unit-testable.
 */
export function applyFreeOnlyGate(
  usable: (DiscoveredModel & { pricingVerified?: boolean })[],
  rejected: { id: string; reason: string }[],
): (DiscoveredModel & { pricingVerified?: boolean })[] {
  const kept: (DiscoveredModel & { pricingVerified?: boolean })[] = [];
  for (const m of usable) {
    if (m.isFree) {
      kept.push(m);
    } else {
      rejected.push({ id: m.id, reason: "not free (AI_FREE_ONLY=1)" });
    }
  }
  return kept;
}

/**
 * Rank a model for the candidate list.
 *
 * Higher is better. The ordering encodes what actually makes a model usable
 * for this job, in this order:
 *
 *   1. Free. A run that costs money is a failed run for this project, and the
 *      free tier is the primary supported path.
 *   2. Served by the provider's own namespace (`opencode/...`). Those are the
 *      models the provider guarantees to serve, and they are the ones that
 *      stay available when a user's other credentials are not.
 *   3. Unfamiliar id. A model whose name we cannot recognise is more likely to
 *      be a new text model than a niche one, so we try it before stale names
 *      that may have been retired.
 *   4. Vision-capable, so the screenshot can be attached when enabled.
 *   5. A large context window, which matters for the section-plan prompt.
 */
function scoreModel(m: DiscoveredModel & { pricingVerified?: boolean }): number {
  let score = 0;
  if (m.isFree) score += 1000;
  else if (!m.pricingVerified) score += 300; // unknown: plausible but not confirmed
  if (m.provider === "opencode") score += 400;
  else if (m.provider === "openai-compatible") score += 200;
  const cap = classifyModel(m.model, m.provider);
  if (cap.positive) score += 60;
  if (m.supportsImages) score += 30;
  if (typeof m.contextWindow === "number") {
    score += Math.min(40, Math.log10(Math.max(1024, m.contextWindow)) * 10);
  }
  // Nudge away from a name that merely contains "free" so that a genuine
  // verifiably-free model is preferred over one that is only free by label.
  if (!m.isFree && /free/i.test(m.model)) score -= 120;
  return score;
}

/**
 * Decide what to actually call, right now.
 *
 * Order of preference:
 *   1. The configured model for this operation, if the provider currently
 *      offers it and it can do text.
 *   2. `AI_FALLBACK_MODELS`, in the order the operator wrote them.
 *   3. Everything else the provider reports right now, ranked by the scoring
 *      function above — verifiably free first.
 *
 * No model list is baked in anywhere: the candidate set is whatever the
 * provider answers at call time.
 */
export async function selectModels(
  provider: AIProvider,
  opts: SelectOptions,
): Promise<Selection> {
  const cfg = config().ai;
  const rejected: { id: string; reason: string }[] = [];
  let available: DiscoveredModel[] = [];
  try {
    available = await discoverWithCache(provider, opts.refresh);
  } catch (err) {
    log.warn("model discovery failed; will try configured model directly", {
      error: (err as Error).message,
    });
  }

  const pricing = await loadPricing();
  const priced = available.map((m) => attachPricing(m, pricing));

  // Drop everything that cannot complete text, before any ordering happens.
  const usable: (DiscoveredModel & { pricingVerified?: boolean })[] = [];
  for (const m of priced) {
    const cap = classifyModel(m.model, m.provider);
    if (!cap.usable) {
      rejected.push({ id: m.id, reason: cap.reason ?? "not a text model" });
      continue;
    }
    usable.push(m);
  }

  // Hard free-only gate. When enabled, a model that is not verifiably free is
  // removed entirely - not just ranked lower - so a pay-per-token call can
  // never happen. The configured primary and fallbacks are resolved against
  // this filtered set, so a paid AI_MODEL is rejected here too.
  if (config().ai.freeOnly) {
    const kept = applyFreeOnlyGate(usable, rejected);
    usable.splice(0, usable.length, ...kept);
  }

  const resolveConfigured = (raw: string | undefined): (DiscoveredModel & { pricingVerified?: boolean }) | undefined => {
    if (!raw) return undefined;
    const { provider: p, model } = normaliseId(raw, provider.name);
    // The OpenCode provider fronts several upstream providers, so a configured
    // `google/...` id is legitimate here.
    const byModel = usable.find((m) => m.model === model && (p === provider.name || p === m.provider));
    if (byModel) return byModel;
    const byId = usable.find((m) => m.id === raw);
    if (byId) return byId;
    rejected.push({ id: raw, reason: "not in the provider's current model list" });
    return undefined;
  };

  const preferred =
    resolveConfigured(opts.preferred) ??
    resolveConfigured(cfg.model) ??
    resolveConfigured(cfg.fallbacks[0]);

  const ordered: (DiscoveredModel & { pricingVerified?: boolean })[] = [];
  const push = (m: (DiscoveredModel & { pricingVerified?: boolean }) | undefined) => {
    if (m && !ordered.some((x) => x.id === m.id)) ordered.push(m);
  };

  push(preferred);
  for (const fb of cfg.fallbacks) push(resolveConfigured(fb));
  for (const m of [...usable].sort((a, b) => scoreModel(b) - scoreModel(a))) push(m);

  const unverifiedFree = ordered.filter((m) => !m.isFree);

  const selection: Selection = {
    primary: ordered[0],
    candidates: ordered,
    unverifiedFree,
    discoveredAt: new Date().toISOString(),
    rejected,
    source: preferred ? "config" : ordered.length ? "discovery" : "none",
  };

  log.info("model selection", {
    operation: opts.operation,
    primary: selection.primary?.id ?? null,
    candidates: ordered.slice(0, cfg.maxModelAttempts).map((m) => m.id),
    discovered: priced.length,
    textCapable: usable.length,
    verifiablyFree: usable.filter((m) => m.isFree).length,
    filteredOut: rejected.length,
    source: selection.source,
  });

  return selection;
}

/**
 * Decide which candidates may be called when a request carries images.
 *
 * The number of images decides the shape of the call, so it must never be
 * sent to a model that cannot accept them: OpenRouter answers any
 * image-bearing request to a text-only route with a 404 "No endpoints found
 * that support image input", and rotating through more text-only routes
 * cannot fix that (it just burns the whole attempt budget). When no
 * vision-capable candidate exists at all, the caller should drop the images
 * and run the step on text. Kept as a pure function so the decision is
 * testable in isolation.
 */
export function resolveVisionPlan(
  candidates: (DiscoveredModel & { supportsImages?: boolean })[],
  wantsImages: boolean,
): { candidates: (DiscoveredModel & { supportsImages?: boolean })[]; dropImages: boolean } {
  if (!wantsImages) return { candidates, dropImages: false };
  const vision = candidates.filter((m) => m.supportsImages);
  if (vision.length === 0) return { candidates, dropImages: true };
  return { candidates: vision, dropImages: false };
}

/**
 * Run a completion, rotating through the candidate models when a transient
 * provider error occurs. This is the only place the pipeline calls a model.
 *
 * When the request carries images, only models that report image support are
 * tried, so a text-only endpoint never receives image content. If the whole
 * pool turns out to be unusable with images (the provider's own catalogue can
 * over-claim a free endpoint's modalities), the images are dropped once and
 * the step is retried on text rather than failing the run.
 */
export async function completeWithFallback(
  provider: AIProvider,
  req: CompletionRequest,
  operation: string,
): Promise<CompletionResult> {
  const cfg = config().ai;
  const selection = await selectModels(provider, { preferred: req.model, operation });

  if (selection.candidates.length === 0) {
    throw new AIError("unavailable", `No models available from provider "${provider.name}".`, {
      provider: provider.name,
      detail: selection.rejected,
    });
  }

  const imagesWanted = (req.images?.length ?? 0) > 0;
  const plan = resolveVisionPlan(selection.candidates, imagesWanted);
  let request = req;
  if (plan.dropImages) {
    log.warn("no vision-capable model in the current pool; the step will run without attached images", {
      operation,
      candidates: selection.candidates.slice(0, cfg.maxModelAttempts).map((m) => m.id),
    });
    if (imagesWanted) request = { ...req, images: undefined };
  } else if (imagesWanted && selection.primary && !selection.primary.supportsImages) {
    log.warn("the configured primary cannot accept images; leading with vision-capable models", {
      operation,
      primary: selection.primary.id,
      candidates: plan.candidates.slice(0, cfg.maxModelAttempts).map((m) => m.id),
    });
  }

  const modelTrail: CompletionResult["modelTrail"] = [];
  let attempts = 0;

  const attemptBatch = async (
    candidates: (DiscoveredModel & { pricingVerified?: boolean })[],
    reqForCall: CompletionRequest,
  ): Promise<CompletionResult> => {
    const maxModels = Math.min(cfg.maxModelAttempts, candidates.length);
    const started = Date.now();
    let lastError: unknown;
    // A credential problem usually affects every model behind the same provider
    // account, so after a couple of consecutive auth failures we stop rather
    // than spending the whole budget re-confirming the same 401.
    let consecutiveAuthFailures = 0;

    for (let m = 0; m < maxModels; m++) {
      const model = candidates[m];
      for (let r = 0; r <= cfg.retriesPerModel; r++) {
        attempts++;
        const t0 = Date.now();
        try {
          const result = await provider.complete({ ...reqForCall, model: model.id });
          modelTrail.push({ model: model.id, ok: true, ms: Date.now() - t0 });
          log.info("completion", {
            operation,
            model: model.id,
            provider: provider.name,
            attempt: attempts,
            modelIndex: m,
            retry: r,
            durationMs: Date.now() - t0,
            outputChars: result.text.length,
            usage: result.usage,
          });
          return {
            ...result,
            model: model.id,
            provider: provider.name,
            durationMs: Date.now() - started,
            attempts,
            modelTrail,
          };
        } catch (err) {
          const ms = Date.now() - t0;
          lastError = err;
          const retryable = isRetryable(err);
          const kind = err instanceof AIError ? err.kind : "unknown";
          modelTrail.push({
            model: model.id,
            ok: false,
            ms,
            error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
          });
          log.warn("completion attempt failed", {
            operation,
            model: model.id,
            attempt: attempts,
            retryable,
            kind,
            error: err instanceof Error ? err.message.slice(0, 240) : String(err),
          });
          if (kind === "auth") {
            consecutiveAuthFailures++;
            if (consecutiveAuthFailures >= 2) {
              log.error("stopping model rotation: provider credentials appear invalid", {
                operation,
                provider: provider.name,
                modelsTried: m + 1,
              });
              throw new AIError(
                "auth",
                `The AI provider rejected its credentials: ${
                  err instanceof Error ? err.message : String(err)
                }`,
                { provider: provider.name, cause: err, detail: modelTrail },
              );
            }
          } else {
            consecutiveAuthFailures = 0;
          }
          // Auth problems will not fix themselves by retrying the same model.
          if (err instanceof AIError && err.kind === "auth") break;
          if (!retryable) break;
          if (r < cfg.retriesPerModel) {
            await sleep(cfg.retryBaseDelayMs * 2 ** r, reqForCall.signal);
          }
        }
      }
    }

    throw new AIError(
      lastError instanceof AIError ? lastError.kind : classifyProviderError(String(lastError)),
      `All ${maxModels} candidate model(s) failed for "${operation}": ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
      { provider: provider.name, cause: lastError, detail: modelTrail },
    );
  };

  try {
    return await attemptBatch(plan.candidates, request);
  } catch (err) {
    // The catalogue can over-claim a free endpoint's modalities. Rather than
    // fail the run because OpenRouter found no image-capable route, retry the
    // step once on text with the full candidate list.
    if (imagesWanted && request.images?.length) {
      const text = err instanceof AIError ? err.message : String(err);
      if (/no endpoints found that support image input|does not support image|support image input/i.test(text)) {
        log.warn("models that claimed image support cannot serve them right now; retrying without images", {
          operation,
          error: text.slice(0, 200),
        });
        request = { ...request, images: undefined };
        return attemptBatch(selection.candidates, request);
      }
    }
    throw err;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AIError("aborted", "Aborted", { provider: "n/a" }));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AIError("aborted", "Aborted", { provider: "n/a" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ------------------------------------------------------------------ doctor

export interface ModelCatalogue {
  /** Every model the provider currently reports, before filtering. */
  all: (DiscoveredModel & { pricingVerified: boolean; verifiablyFree: boolean })[];
  /** The subset whose published input and output cost are both zero. */
  free: (DiscoveredModel & { pricingVerified: boolean; verifiablyFree: boolean })[];
  /** Models dropped because they cannot do text. */
  rejected: { id: string; reason: string }[];
  total: number;
  /** What the pipeline would pick for a generic operation right now. */
  primary?: string;
  discoveredAt: string;
  /** True when the pricing catalogue could be read. */
  pricingAvailable: boolean;
}

/**
 * A read-only view of what is available right now, for the doctor command and
 * the control panel. Performs discovery and pricing lookup but makes no
 * completion call, so it is safe to run repeatedly.
 */
export async function listFreeModels(
  provider: AIProvider,
  opts: { refresh?: boolean } = {},
): Promise<ModelCatalogue> {
  const available = await discoverWithCache(provider, opts.refresh);
  const pricing = await loadPricing();
  const usable: (DiscoveredModel & { pricingVerified: boolean; verifiablyFree: boolean })[] = [];
  const rejected: { id: string; reason: string }[] = [];

  for (const m of available) {
    const cap = classifyModel(m.model, m.provider);
    if (!cap.usable) {
      rejected.push({ id: m.id, reason: cap.reason ?? "not a text model" });
      continue;
    }
    const priced = attachPricing(m, pricing);
    usable.push({ ...priced, verifiablyFree: priced.isFree });
  }

  const selection = await selectModels(provider, { operation: "doctor", refresh: opts.refresh });
  const free = usable.filter((m) => m.verifiablyFree).sort((a, b) => scoreModel(b) - scoreModel(a));

  return {
    all: usable.sort((a, b) => scoreModel(b) - scoreModel(a)),
    free,
    rejected,
    total: available.length,
    primary: selection.primary?.id,
    discoveredAt: new Date().toISOString(),
    pricingAvailable: pricing.size > 0,
  };
}

export interface HealthReport {
  ok: boolean;
  detail: string;
  modelCount: number;
  /** A tiny completion, used to prove the pipeline can actually answer. */
  probe?: { model: string; ms: number; ok: boolean; note: string };
}

/**
 * Provider health check.
 *
 * Two stages on purpose. Discovery alone is not enough: a provider can list
 * models and still fail every completion (expired credential, disabled free
 * tier). The probe makes one minimal, cheap call so the doctor reports what will
 * actually happen, not what should.
 */
export async function checkHealth(
  provider: AIProvider,
  opts: { probe?: boolean } = {},
): Promise<HealthReport> {
  let available: DiscoveredModel[] = [];
  try {
    available = await discoverWithCache(provider, true);
  } catch (err) {
    return {
      ok: false,
      detail: `Could not list models: ${(err as Error).message}`,
      modelCount: 0,
    };
  }
  if (!available.length) {
    return { ok: false, detail: "The provider reported no models.", modelCount: 0 };
  }

  if (opts.probe === false) {
    return {
      ok: true,
      detail: `${available.length} model(s) currently available through the ${provider.name} provider`,
      modelCount: available.length,
    };
  }

  const t0 = Date.now();
  try {
    const result = await completeWithFallback(
      provider,
      {
        system: "Reply with the single word: ok",
        user: "ping",
        // Generous budget on purpose: several free models are reasoning models
        // that emit a long `reasoning` field before any `content`. A tiny
        // ceiling (16) made them return content:null with finish "length",
        // which falsely reported a healthy provider as down.
        maxOutputTokens: 512,
        temperature: 0,
        model: config().ai.model || undefined,
      },
      "doctor-probe",
    );
    return {
      ok: true,
      detail: `${available.length} model(s) available; probe answered in ${Date.now() - t0}ms`,
      modelCount: available.length,
      probe: {
        model: result.model,
        ms: Date.now() - t0,
        ok: true,
        note: result.text.slice(0, 40),
      },
    };
  } catch (err) {
    return {
      ok: false,
      detail: `Models listed, but the probe failed: ${(err as Error).message}`,
      modelCount: available.length,
    };
  }
}
