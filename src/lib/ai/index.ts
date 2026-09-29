/**
 * Factory + high-level helpers.
 *
 * `structured()` is the entry point every AI stage uses. It owns the
 * parse → validate → bounded-correction-retry loop so that malformed model
 * output can never leak into the generation pipeline.
 */

import { z } from "zod";
import { config } from "../config";
import { createLogger } from "../logger";
import { AIError } from "./errors";
import { completeWithFallback, invalidateModelCache } from "./models";
import { OpenAICompatibleProvider } from "./openai-compatible";
import { OpenCodeProvider } from "./opencode";
import type { AIProvider, CompletionRequest, CompletionResult, ImageAttachment } from "./provider";

const log = createLogger("ai");

let cachedProvider: AIProvider | null = null;
let cachedProviderName = "";

export function getProvider(): AIProvider {
  const name = config().ai.provider;
  if (cachedProvider && cachedProviderName === name) return cachedProvider;
  const provider: AIProvider =
    name === "openai-compatible" ? new OpenAICompatibleProvider() : new OpenCodeProvider();
  cachedProvider = provider;
  cachedProviderName = name;
  return provider;
}

/** Test seam. */
export function setProvider(p: AIProvider | null): void {
  cachedProvider = p;
  cachedProviderName = p?.name ?? "";
}

export function refreshModels(): void {
  invalidateModelCache();
}

export type Operation = "analyze" | "generate" | "modify" | "repair";

function modelFor(op: Operation): string {
  return config().ai.models[op] || config().ai.model;
}

export interface StructuredOptions<T extends z.ZodTypeAny> {
  operation: Operation;
  /** Name of the operation used in logs, e.g. "website-spec". */
  label: string;
  system: string;
  user: string;
  schema: T;
  images?: ImageAttachment[];
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Attempts beyond the first when the payload fails validation. */
  maxAttempts?: number;
  /** Extra guidance folded into each correction attempt. */
  correctionHints?: string[];
}

export interface StructuredResult<T> {
  data: T;
  completions: CompletionResult[];
  model: string;
  attempts: number;
  corrected: boolean;
}

/**
 * Ask a model for JSON that satisfies `schema`.
 *
 * On a parse or validation failure we do not simply resample: we feed the
 * specific Zod issues plus the offending (truncated) output back and ask for a
 * corrected document. Retries are bounded.
 */
export async function structured<S extends z.ZodTypeAny>(
  opts: StructuredOptions<S>,
): Promise<StructuredResult<z.infer<S>>> {
  const provider = getProvider();
  const maxAttempts = Math.min(opts.maxAttempts ?? config().ai.maxStructureAttempts, 8);
  const completions: CompletionResult[] = [];
  let lastIssues: string[] = [];
  let lastRaw = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const req: CompletionRequest = {
      system: opts.system,
      user:
        attempt === 1
          ? opts.user
          : buildCorrectionPrompt(opts.user, lastRaw, lastIssues, opts.correctionHints),
      images: opts.images,
      maxOutputTokens: opts.maxOutputTokens,
      temperature: opts.temperature ?? 0.15,
      model: modelFor(opts.operation),
      signal: opts.signal,
      expectJson: true,
    };

    const res = await completeWithFallback(provider, req, `${opts.label}#${attempt}`);
    completions.push(res);

    const raw = res.text;
    const parsed = extractJson(raw);
    if (!parsed.ok) {
      lastRaw = raw;
      lastIssues = [`The response was not valid JSON: ${parsed.error}`];
      log.warn("structured output was not JSON; requesting a correction", {
        label: opts.label,
        attempt,
        model: res.model,
        error: parsed.error,
      });
      continue;
    }

    const validation = opts.schema.safeParse(parsed.value);
    if (validation.success) {
      log.info("structured output validated", {
        label: opts.label,
        attempt,
        model: res.model,
        corrected: attempt > 1,
      });
      return {
        data: validation.data as z.infer<S>,
        completions,
        model: res.model,
        attempts: attempt,
        corrected: attempt > 1,
      };
    }

    lastRaw = raw;
    lastIssues = validation.error.issues
      .slice(0, 25)
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
    log.warn("structured output failed schema validation; requesting a correction", {
      label: opts.label,
      attempt,
      model: res.model,
      issues: lastIssues.slice(0, 8),
    });
  }

  throw new AIError(
    "structure",
    `Model failed to produce a valid document for "${opts.label}" after ${maxAttempts} attempt(s). Issues: ${lastIssues
      .slice(0, 6)
      .join("; ")}`,
    { provider: provider.name, detail: lastRaw.slice(0, 2000) },
  );
}

/** Plain text completion (used by the repair loop). */
export async function text(opts: {
  operation: Operation;
  label: string;
  system: string;
  user: string;
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}): Promise<CompletionResult> {
  return completeWithFallback(
    getProvider(),
    {
      system: opts.system,
      user: opts.user,
      maxOutputTokens: opts.maxOutputTokens,
      temperature: opts.temperature ?? 0.1,
      model: modelFor(opts.operation),
      signal: opts.signal,
    },
    opts.label,
  );
}

function buildCorrectionPrompt(
  original: string,
  raw: string,
  issues: string[],
  hints?: string[],
): string {
  const trimmed = raw.length > 2500 ? raw.slice(0, 2500) + "\n…(truncated)" : raw;
  return [
    original,
    "",
    "--- CORRECTION REQUIRED ---",
    "Your previous response was rejected. Problems found:",
    ...issues.map((i) => `  - ${i}`),
    ...(hints?.length ? ["", "Additional guidance:", ...hints.map((h) => `  - ${h}`)] : []),
    "",
    "Your previous response began:",
    "<<<",
    trimmed,
    ">>>",
    "",
    "Reply again with ONLY the corrected JSON document. No prose, no explanation, no markdown fences.",
  ].join("\n");
}

export interface JsonExtraction {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/**
 * Tolerant JSON extraction.
 *
 * Models wrap JSON in prose or fences often enough that a bare
 * `JSON.parse` is not viable. We try, in order: the whole string, every fenced
 * block, the outermost brace/bracket span, and brace-balanced prefixes.
 */
export function extractJson(text: string): JsonExtraction {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { ok: false, error: "empty response" };

  const direct = tryParse(trimmed);
  if (direct.ok) return direct;

  const fences = [...trimmed.matchAll(/```(?:json|jsonc|json5)?\s*([\s\S]*?)```/gi)];
  for (const m of fences) {
    const attempt = tryParse((m[1] ?? "").trim());
    if (attempt.ok) return attempt;
  }

  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const start = trimmed.indexOf(open);
    if (start === -1) continue;
    const end = trimmed.lastIndexOf(close);
    if (end > start) {
      const attempt = tryParse(trimmed.slice(start, end + 1));
      if (attempt.ok) return attempt;
    }
    // Balanced scan handles trailing text after the closing brace.
    const balanced = balancedSlice(trimmed, start, open, close);
    if (balanced) {
      const attempt = tryParse(balanced);
      if (attempt.ok) return attempt;
    }
  }

  return { ok: false, error: `no parseable JSON found (${trimmed.length} chars)` };
}

function tryParse(s: string): JsonExtraction {
  if (!s) return { ok: false, error: "empty" };
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 160) };
  }
}

function balancedSlice(text: string, start: number, open: string, close: string): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Pull a fenced code block of a given language out of a repair response. */
export function extractFencedCode(text: string, lang?: string): string | null {
  const re = lang
    ? new RegExp("```" + lang + "\\s*\\n([\\s\\S]*?)```", "i")
    : /```\w*\s*\n([\s\S]*?)```/;
  const m = (text ?? "").match(re);
  return m ? m[1] : null;
}
