/**
 * Small dependency-free structured logger.
 *
 * Every pipeline stage emits here, and the run transcript is also persisted
 * per project so the UI can show the agent's reasoning trail without needing
 * a log aggregator. That transcript is a big part of making the agent's
 * behaviour legible in a demo.
 */

import fs from "node:fs";
import path from "node:path";
import { config } from "./config";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  ts: string;
  level: LogLevel;
  scope: string;
  message: string;
  data?: Record<string, unknown>;
}

let projectLogPath: string | null = null;

export function attachProjectLog(dir: string | null): void {
  projectLogPath = dir ? path.join(dir, "agent.log") : null;
}

function write(record: LogRecord): void {
  if (!projectLogPath) return;
  try {
    fs.mkdirSync(path.dirname(projectLogPath), { recursive: true });
    fs.appendFileSync(projectLogPath, JSON.stringify(record) + "\n");
  } catch {
    /* logging must never break the pipeline */
  }
}

function emit(level: LogLevel, scope: string, message: string, data?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[config().logLevel]) return;
  const record: LogRecord = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...(data ? { data: serialise(data) } : {}),
  };
  write(record);
  const tag = `[${record.ts.slice(11, 19)}] ${level.toUpperCase().padEnd(5)} ${scope}`;
  const line = `${tag} ${message}`;
  if (level === "error") console.error(line, data ?? "");
  else if (level === "warn") console.warn(line, data ?? "");
  else console.log(line, data ?? "");
}

/** Keep Error objects readable and guard against cycles / huge payloads. */
function serialise(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v instanceof Error) out[k] = { name: v.name, message: v.message };
    else if (typeof v === "string" && v.length > 2000) out[k] = v.slice(0, 2000) + `…(+${v.length - 2000})`;
    else out[k] = v;
  }
  return out;
}

export function createLogger(scope: string) {
  return {
    debug: (m: string, d?: Record<string, unknown>) => emit("debug", scope, m, d),
    info: (m: string, d?: Record<string, unknown>) => emit("info", scope, m, d),
    warn: (m: string, d?: Record<string, unknown>) => emit("warn", scope, m, d),
    error: (m: string, d?: Record<string, unknown>) => emit("error", scope, m, d),
  };
}

export type Logger = ReturnType<typeof createLogger>;
