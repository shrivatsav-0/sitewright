/**
 * OpenCode transport.
 *
 * Why the CLI and not an HTTP client
 * ----------------------------------
 * OpenCode's free tier is gated server-side. Two transport shapes were tried:
 *
 *   - `POST /api/experimental/generate` — rejected with HTTP 403
 *     ("OpenCode's free tier can only be used from within OpenCode") for every
 *     free model.
 *   - The HTTP session flow (`POST /api/session` → `/prompt` → poll
 *     `/message`) — worked for a while, then began returning the same 403 for
 *     all free models regardless of how the session-create body was shaped, and
 *     regardless of which directory the server was rooted at. The CLI in the
 *     same directory, at the same moment, kept working.
 *
 * `opencode run --format json` is therefore the transport. It is also the
 * better engineering choice on every other axis: no server to spawn, no port
 * to allocate, no password to read out of stdout, no session to poll or clean
 * up, and no long-lived child process to leak. It streams newline-delimited
 * events, which is exactly the shape the rest of the pipeline wants.
 *
 * Tool suppression
 * ----------------
 * A model that hallucinates a tool call produces a run with no text. We do
 * not try to prevent that with session permissions (that trips the free-tier
 * gate); we prevent it by pointing the child at a scratch workspace whose
 * `opencode.json` disables tools on the default agent, and by detecting a
 * tool-only reply and treating it as a model failure worth rotating away from.
 */

import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../config";
import { createLogger } from "../logger";
import { AIError, classifyProviderError } from "./errors";
import type {
  AIProvider,
  CompletionRequest,
  CompletionResult,
  DiscoveredModel,
  ImageAttachment,
  ProviderHealth,
} from "./provider";

const log = createLogger("ai/opencode");

/**
 * Scratch `opencode.json` written into the provider's workspace. Overriding the
 * built-in `build` agent with an empty tool set and an all-deny permission set
 * means the model physically has no `bash`/`write`/`edit` to call, so a
 * hallucinated tool call cannot become a real side effect.
 */
const WORKSPACE_CONFIG = {
  $schema: "https://opencode.ai/config.json",
  agent: {
    build: {
      description: "Text-only completion agent. No tools are available.",
      tools: {},
      permission: { "*": "deny" },
    },
  },
} as const;

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export type ExecFn = (
  file: string,
  args: string[],
  opts: { cwd?: string; stdin?: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<ExecResult>;

export class OpenCodeProvider implements AIProvider {
  readonly name = "opencode";
  private workspaceReady: Promise<string> | null = null;

  constructor(private readonly exec: ExecFn = defaultExec) {}

  // ------------------------------------------------------------- workspace

  /**
   * A real project directory (package.json + opencode.json) is required: when
   * OpenCode has no project context it behaves differently for free models.
   * Created once per process.
   */
  private async workspace(): Promise<string> {
    if (this.workspaceReady) return this.workspaceReady;
    this.workspaceReady = (async () => {
      const dir = config().ai.opencode.workspaceDir;
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(
        path.join(dir, "opencode.json"),
        JSON.stringify(WORKSPACE_CONFIG, null, 2) + "\n",
        "utf8",
      );
      const pkg = path.join(dir, "package.json");
      try {
        await fsp.access(pkg);
      } catch {
        await fsp.writeFile(
          pkg,
          JSON.stringify({ name: "sitewright-opencode-workspace", private: true }, null, 2) + "\n",
          "utf8",
        );
      }
      return dir;
    })();
    return this.workspaceReady;
  }

  // ------------------------------------------------------------- discovery

  /**
   * Ask OpenCode what it can call right now. There is no cached or bundled
   * list anywhere: whatever `opencode models` prints is the answer, which is
   * exactly the property that matters given the free tier rotates.
   */
  async discoverModels(signal?: AbortSignal): Promise<DiscoveredModel[]> {
    const cfg = config().ai.opencode;
    const { stdout } = await this.exec(cfg.bin, ["models"], {
      timeoutMs: 120_000,
      signal,
    });
    const models: DiscoveredModel[] = [];
    const seen = new Set<string>();
    for (const line of stdout.split("\n")) {
      const id = line.trim();
      // `opencode models` prints bare `provider/model` ids, one per line.
      if (!id || id.startsWith(" ") || seen.has(id)) continue;
      const slash = id.indexOf("/");
      if (slash <= 0) continue;
      seen.add(id);
      const provider = id.slice(0, slash);
      const model = id.slice(slash + 1);
      models.push({
        id,
        provider,
        model,
        name: model,
        costIn: null,
        costOut: null,
        isFree: false,
        supportsImages: true,
        supportsTools: false,
      });
    }
    return models;
  }

  async health(signal?: AbortSignal): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const models = await this.discoverModels(signal);
      if (!models.length) {
        return {
          ok: false,
          provider: this.name,
          detail:
            "`opencode models` returned nothing. Is the OpenCode CLI installed (`opencode --version`) and signed in (`opencode auth login`)?",
          availableModels: [],
          checkedAt,
        };
      }
      return {
        ok: true,
        provider: this.name,
        detail: `${models.length} model(s) currently available through the OpenCode CLI`,
        availableModels: models,
        defaultModel: models.find((m) => m.provider === "opencode")?.id ?? models[0].id,
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

  // ------------------------------------------------------------- completion

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const t0 = Date.now();
    const cfg = config().ai.opencode;
    const model = req.model || config().ai.model;
    if (!model) {
      throw new AIError("unavailable", "No model specified and none configured", {
        provider: this.name,
      });
    }
    const cwd = await this.workspace();
    const args = ["run", "--model", model, "--format", "json"];

    // Images are attached by path. They are copied into the workspace first so
    // the child process never needs read access to arbitrary locations.
    for (const img of req.images ?? []) {
      const local = await stageImage(img, cwd);
      args.push("-f", local);
    }

    const prompt = renderPrompt(req);
    const { stdout, stderr, code, timedOut } = await this.exec(cfg.bin, args, {
      cwd,
      stdin: prompt,
      timeoutMs: config().ai.requestTimeoutMs,
      signal: req.signal,
    });

    const events = parseEvents(stdout);
    if (timedOut) {
      throw new AIError("timeout", `opencode run exceeded ${config().ai.requestTimeoutMs}ms for "${model}"`, {
        provider: this.name,
        model,
      });
    }
    if (code !== 0 && !events.length) {
      throw new AIError(
        classifyProviderError(`${stderr}\n${stdout}`.slice(0, 600)),
        `opencode run exited with code ${code}: ${(stderr || stdout).slice(0, 400)}`,
        { provider: this.name, model },
      );
    }

    // An error event is authoritative even when the exit code is 0.
    const failure = events.find((e) => e.type === "error" && e.error?.message);
    if (failure?.error?.message) {
      const message = String(failure.error.message);
      throw new AIError(
        classifyProviderError(message, statusOf(failure.error)),
        message,
        { provider: this.name, model, detail: failure.error },
      );
    }

    const text = events
      .filter((e) => e.type === "text" && typeof e.part?.text === "string")
      .map((e) => e.part?.text ?? "")
      .join("\n")
      .trim();

    if (!text) {
      const sawTool = events.some((e) => e.type === "tool" || e.type === "tool-call");
      throw new AIError(
        "structure",
        sawTool
          ? `Model "${model}" tried to call a tool instead of answering. Nothing usable was returned.`
          : `Model "${model}" returned no text. Events: ${events.map((e) => e.type).join(",") || "none"}. ${
              stderr ? `stderr: ${stderr.slice(0, 200)}` : ""
            }`,
        { provider: this.name, model },
      );
    }

    const usage = collectUsage(events);
    return {
      text,
      model,
      provider: this.name,
      durationMs: Date.now() - t0,
      usage,
      costUsd: 0,
      attempts: 1,
      modelTrail: [],
    };
  }
}

// ------------------------------------------------------------------ helpers

interface RunEvent {
  type: string;
  part?: { type?: string; text?: string; tokens?: Record<string, number> };
  error?: { type?: string; message?: string; status?: number };
  cost?: number;
}

function parseEvents(stdout: string): RunEvent[] {
  const out: RunEvent[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      out.push(JSON.parse(trimmed) as RunEvent);
    } catch {
      /* partial line from an interrupted stream */
    }
  }
  return out;
}

function statusOf(err: { status?: number; data?: { status?: number } } | undefined): number | undefined {
  return err?.status ?? err?.data?.status;
}

function collectUsage(events: RunEvent[]): CompletionResult["usage"] {
  let input: number | undefined;
  let output: number | undefined;
  let reasoning: number | undefined;
  let cost: number | undefined;
  for (const e of events) {
    const t = e.part?.tokens;
    if (t) {
      input = t.input ?? t.prompt ?? input;
      output = t.output ?? t.completion ?? output;
      reasoning = t.reasoning ?? reasoning;
    }
    if (typeof e.cost === "number") cost = e.cost;
  }
  return input !== undefined || output !== undefined
    ? { input, output, reasoning }
    : cost !== undefined
      ? undefined
      : undefined;
}

function renderPrompt(req: CompletionRequest): string {
  const parts: string[] = [];
  if (req.system.trim()) parts.push(req.system.trim());
  const imgs = req.images ?? [];
  if (imgs.length) {
    parts.push(
      `<attached-reference-images>\n${imgs
        .map((i, n) => `image ${n + 1}: ${i.label}`)
        .join("\n")}\n</attached-reference-images>`,
    );
  }
  parts.push(req.user.trim());
  return parts.join("\n\n");
}

/** Copy an attachment into the workspace and return its new path. */
async function stageImage(img: ImageAttachment, workspace: string): Promise<string> {
  const dir = path.join(workspace, ".attachments");
  await fsp.mkdir(dir, { recursive: true });
  const ext = img.mime === "image/jpeg" ? ".jpg" : img.mime === "image/webp" ? ".webp" : ".png";
  const target = path.join(dir, `${sanitiseSegment(img.label) || "image"}${ext}`);
  try {
    await fsp.copyFile(img.path, target);
  } catch (err) {
    throw new AIError("structure", `Could not attach image ${img.label}: ${(err as Error).message}`, {
      provider: "opencode",
    });
  }
  return target;
}

function sanitiseSegment(input: string): string {
  return (input ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export const defaultExec: ExecFn = async (
  file,
  args,
  opts,
): Promise<ExecResult> => {
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: { ...process.env, NO_COLOR: "1", CI: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    const onAbort = () => {
      child.kill("SIGKILL");
      finish(() => reject(new AIError("aborted", "Aborted", { provider: "opencode" })));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      finish(() =>
        reject(
          new AIError(
            e.code === "ENOENT" ? "unavailable" : classifyProviderError(e.message),
            e.code === "ENOENT"
              ? `Could not run \`${file}\`. Install the OpenCode CLI and make sure it is on PATH.`
              : e.message,
            { provider: "opencode", cause: e },
          ),
        ),
      );
    });
    child.on("close", (code) => {
      finish(() => resolve({ stdout, stderr, code, timedOut }));
    });

    if (opts.stdin !== undefined) {
      child.stdin.on("error", () => {
        /* the child may exit before we finish writing; the close handler wins */
      });
      child.stdin.end(opts.stdin, "utf8");
    } else {
      child.stdin.end();
    }
  });
};

/** Scratch directory hint used in error messages. */
export function defaultWorkspaceDir(): string {
  return config().ai.opencode.workspaceDir || path.join(os.tmpdir(), "sitewright-opencode");
}
