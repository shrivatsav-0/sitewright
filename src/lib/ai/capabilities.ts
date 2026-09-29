/**
 * Text-generation capability filter.
 *
 * A provider's model list is not a list of chat models. It also contains
 * embedding, image, audio, video, music and research models that will happily
 * accept a prompt and return something that is not text — or fail with a
 * confusing upstream error. Selecting one of those poisons the run, so the
 * filter lives in its own module with its own tests.
 *
 * Everything here is pattern-based and deliberately conservative: when a model
 * id is unfamiliar we assume it *is* a text model, because dropping a usable
 * model is worse than trying one and rotating away from it.
 */

interface Rule {
  re: RegExp;
  reason: string;
}

const NON_TEXT: Rule[] = [
  { re: /embed|embedding|bge-|gte-|e5-|minilm|whisper/i, reason: "embedding model" },
  { re: /imagen|flux|sdxl|stable-diffusion|dall-?e|image-gen|gpt-image|gemini-.*-image/i, reason: "image generation" },
  { re: /tts|text-to-speech|speech-to-text/i, reason: "speech model" },
  { re: /lyria|audiogen|music|jukebox|audio/i, reason: "audio/music generation" },
  { re: /veo|sora|luma|video-gen|kling|runway/i, reason: "video generation" },
  { re: /clip|vision-?only|ocr/i, reason: "vision-only / retrieval model" },
  { re: /live-translate|translate/i, reason: "translation model" },
  { re: /computer-use|deep-research|research-preview/i, reason: "agentic research/computer-use model" },
  { re: /\bmodifiers?\b/i, reason: "adapter, not a base model" },
  { re: /rerank|moderation|guard|classifier/i, reason: "non-generative model" },
  { re: /(?:^|[-_/])nano(?:[-_/]|$)/i, reason: "router/nano dispatch model" },
];

/** Substrings that mark a model as a chat/text completion model. */
const TEXT_HINTS = [
  "instruct", "chat", "gpt", "claude", "gemini", "llama", "mistral", "mixtral", "qwen",
  "deepseek", "grok", "kimi", "glm", "minimax", "gpt-4", "gpt-5", "gpt-6", "sonnet",
  "opus", "haiku", "flash", "pro", "turbo", "mini", "small", "medium", "large", "ultra",
  "nemotron", "granite", "exaone", "command", "hermes", "phi", "orca", "cerebras",
  "space-bunny", "big-pickle", "spark", "lightning", "longcat", "mimo", "ling", "step",
];

export interface CapabilityVerdict {
  usable: boolean;
  reason?: string;
  /** True when the id matched a known text-model hint. */
  positive: boolean;
}

/**
 * @param modelId  Bare model id, e.g. `space-bunny-free`.
 * @param provider Optional provider id, used for provider-level hints.
 */
export function classifyModel(modelId: string, provider?: string): CapabilityVerdict {
  const id = (modelId ?? "").toLowerCase();
  if (!id) return { usable: false, reason: "empty model id", positive: false };

  for (const rule of NON_TEXT) {
    if (rule.re.test(id)) {
      return { usable: false, reason: rule.reason, positive: false };
    }
  }

  const positive = TEXT_HINTS.some((hint) => id.includes(hint));
  // Unfamiliar ids are optimistically treated as text models; the completion
  // layer still treats a non-text reply as a structured-output failure and
  // rotates to the next candidate.
  void provider;
  return { usable: true, positive };
}

/** Preferred modality set for a model, used to rank vision-capable models up. */
export function modalityScore(m: { supportsImages?: boolean }): number {
  return m.supportsImages ? 1 : 0;
}
