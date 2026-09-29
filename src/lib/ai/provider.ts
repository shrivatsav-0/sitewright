/**
 * The single abstraction every AI stage in this system talks to.
 *
 * OpenCode is one implementation; an OpenAI-compatible endpoint (OpenRouter,
 * Ollama, LM Studio, vLLM, a paid OpenAI key, …) is another. Nothing in the
 * pipeline imports a vendor SDK, so switching is a config change, not a
 * refactor.
 */

export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

export interface ImageAttachment {
  /** Absolute path on disk. Transports read it lazily. */
  path: string;
  mime: ImageMime;
  /** Human label used in the prompt so the model can refer to it. */
  label: string;
}

export interface CompletionRequest {
  /** System prompt: role, output contract, constraints. */
  system: string;
  /** User prompt: the task-specific payload. */
  user: string;
  /** Optional reference images (screenshots) for multimodal models. */
  images?: ImageAttachment[];
  /** Rough token ceiling. Providers clamp this to their own limits. */
  maxOutputTokens?: number;
  temperature?: number;
  /** Model override in `provider/model` or bare id form. */
  model?: string;
  /** Abort signal plumbed from the pipeline. */
  signal?: AbortSignal;
  /**
   * When set, the provider should ask for JSON-ish output. This is advisory
   * only — every response still goes through parse + schema validation.
   */
  expectJson?: boolean;
}

export interface CompletionResult {
  text: string;
  model: string;
  provider: string;
  durationMs: number;
  /** Token accounting when the provider reports it. */
  usage?: { input?: number; output?: number; reasoning?: number };
  /** Monotonic estimate used for the cost dashboard. */
  costUsd?: number;
  attempts: number;
  /** Every model that was tried, in order, with the outcome. */
  modelTrail: { model: string; ok: boolean; ms: number; error?: string }[];
}

export interface ProviderHealth {
  ok: boolean;
  provider: string;
  detail: string;
  /** Currently usable models, newest-first from live discovery. */
  availableModels: DiscoveredModel[];
  defaultModel?: string;
  checkedAt: string;
}

export interface DiscoveredModel {
  /** Full `provider/model` identifier. */
  id: string;
  provider: string;
  model: string;
  name: string;
  /** 0 for free models. `null` when the source did not report pricing. */
  costIn: number | null;
  costOut: number | null;
  isFree: boolean;
  contextWindow?: number;
  maxOutput?: number;
  supportsImages: boolean;
  supportsTools: boolean;
}

export interface AIProvider {
  readonly name: string;
  /**
   * Query the live provider for models that are usable *right now*.
   * Implementations must never return a static, baked-in list.
   */
  discoverModels(signal?: AbortSignal): Promise<DiscoveredModel[]>;
  /** Cheap end-to-end round trip used by `/api/health` and the doctor script. */
  health(signal?: AbortSignal): Promise<ProviderHealth>;
  /** Single-shot completion. Throws `AIError` on failure. */
  complete(req: CompletionRequest): Promise<CompletionResult>;
}
