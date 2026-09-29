/**
 * Provider for any OpenAI-compatible `/chat/completions` endpoint.
 *
 * This exists to satisfy the "switch providers through configuration"
 * requirement: point `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` at
 * OpenRouter, Ollama, LM Studio, vLLM, or a paid OpenAI key and the whole
 * pipeline switches over with no code change. The same live-discovery and
 * model-rotation machinery in `models.ts` applies.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { createLogger } from "../logger";
import { AIError, classifyProviderError } from "./errors";
import type {
  AIProvider,
  CompletionRequest,
  CompletionResult,
  DiscoveredModel,
  ImageMime,
  ProviderHealth,
} from "./provider";

const log = createLogger("ai/openai-compatible");

export class OpenAICompatibleProvider implements AIProvider {
  readonly name = "openai-compatible";

  private get baseUrl(): string {
    return config().ai.openaiCompatible.baseUrl.replace(/\/+$/, "");
  }

  private get apiKey(): string {
    return config().ai.openaiCompatible.apiKey;
  }

  private async post(route: string, body: unknown, signal?: AbortSignal): Promise<any> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${route}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      const e = err as Error;
      throw new AIError(
        e.name === "AbortError" ? "timeout" : classifyProviderError(e.message),
        e.message,
        { provider: this.name, cause: e },
      );
    }
    const text = await res.text();
    if (!res.ok) {
      throw new AIError(classifyProviderError(text, res.status), `HTTP ${res.status}: ${text.slice(0, 400)}`, {
        provider: this.name,
        detail: text,
      });
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new AIError("unknown", `Non-JSON response: ${text.slice(0, 200)}`, { provider: this.name });
    }
  }

  async discoverModels(signal?: AbortSignal): Promise<DiscoveredModel[]> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/models`, { headers, signal });
    } catch (err) {
      throw new AIError(classifyProviderError((err as Error).message), (err as Error).message, {
        provider: this.name,
      });
    }
    if (!res.ok) {
      throw new AIError("unavailable", `Model listing failed: HTTP ${res.status}`, { provider: this.name });
    }
    const json = (await res.json()) as { data?: any[] };
    return (json.data ?? []).map((m) => ({
      id: `openai-compatible/${m.id}`,
      provider: this.name,
      model: m.id,
      name: m.name ?? m.id,
      costIn: numberOrNull(m?.pricing?.prompt),
      costOut: numberOrNull(m?.pricing?.completion),
      isFree: m?.pricing?.prompt === "0" && m?.pricing?.completion === "0",
      contextWindow: m?.context_length,
      maxOutput: m?.top_provider?.max_completion_tokens,
      supportsImages: m?.architecture?.input_modalities?.includes("image") ?? false,
      supportsTools: true,
    }));
  }

  async health(signal?: AbortSignal): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const models = await this.discoverModels(signal);
      return {
        ok: models.length > 0,
        provider: this.name,
        detail: `${models.length} model(s) listed by ${this.baseUrl}`,
        availableModels: models,
        checkedAt,
      };
    } catch (err) {
      return {
        ok: false,
        provider: this.name,
        detail: err instanceof Error ? err.message : String(err),
        availableModels: [],
        checkedAt,
      };
    }
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const model = req.model ?? config().ai.openaiCompatible.model;
    if (!model) {
      throw new AIError("unavailable", "Set OPENAI_MODEL or pass model explicitly", { provider: this.name });
    }
    const t0 = Date.now();
    const ref = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;

    const content: any[] = [{ type: "text", text: req.user }];
    for (const img of req.images ?? []) {
      content.push(...(await toImageParts(img)));
    }

    const json = await this.post(
      "/chat/completions",
      {
        model: ref,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content },
        ],
        max_tokens: req.maxOutputTokens,
        temperature: req.temperature ?? 0.2,
        ...(req.expectJson ? { response_format: { type: "json_object" } } : {}),
      },
      req.signal,
    );

    const text = json?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      throw new AIError("structure", "Provider returned no message content", { provider: this.name, detail: json });
    }
    return {
      text,
      model,
      provider: this.name,
      durationMs: Date.now() - t0,
      usage: {
        input: json?.usage?.prompt_tokens,
        output: json?.usage?.completion_tokens,
        reasoning: json?.usage?.completion_tokens_details?.reasoning_tokens,
      },
      costUsd: estimateCost(json, ref),
      attempts: 1,
      modelTrail: [],
    };
  }
}

async function toImageParts(img: { path: string; mime: ImageMime; label: string }): Promise<any[]> {
  try {
    const buf = await fsp.readFile(img.path);
    return [
      { type: "text", text: `[image: ${img.label}]` },
      { type: "image_url", image_url: { url: `data:${img.mime};base64,${buf.toString("base64")}` } },
    ];
  } catch {
    log.warn("could not attach image; continuing without it", { path: img.path });
    return [];
  }
}

function estimateCost(json: any, _model: string): number | undefined {
  const p = json?.usage?.prompt_tokens;
  const c = json?.usage?.completion_tokens;
  if (typeof p !== "number" || typeof c !== "number") return undefined;
  // Pricing varies per provider; the UI treats this as an estimate only.
  return undefined;
}

function numberOrNull(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

void fs;
void path;
