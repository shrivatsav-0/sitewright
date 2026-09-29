/**
 * AI error taxonomy.
 *
 * The distinction that actually matters for this system is
 * "is this worth retrying on a different model?" — a transient provider or
 * rate-limit failure is, while a malformed structured response is not
 * (it needs a *correction* prompt on the *same* model).
 */

export type AIErrorKind =
  | "transient" // rate limited, throttled, model temporarily unavailable
  | "unavailable" // model/endpoint not present right now -> rotate model
  | "auth" // credentials problem -> do not retry, surface clearly
  | "timeout" // exceeded the per-attempt budget
  | "structure" // model replied but the payload did not validate
  | "aborted" // caller cancelled
  | "unknown";

export class AIError extends Error {
  readonly kind: AIErrorKind;
  readonly model?: string;
  readonly provider: string;
  readonly detail?: unknown;

  constructor(
    kind: AIErrorKind,
    message: string,
    opts: { model?: string; provider: string; cause?: unknown; detail?: unknown } = {
      provider: "unknown",
    },
  ) {
    super(message, { cause: opts.cause });
    this.name = "AIError";
    this.kind = kind;
    this.model = opts.model;
    this.provider = opts.provider;
    this.detail = opts.detail;
  }
}

/**
 * Provider free tiers rotate capacity between models, so the same request
 * can succeed and then fail a minute later. We match on message content as
 * well as status because the upstream gateway reports the throttle as a
 * 403 "auth" error, which is semantically wrong.
 */
const TRANSIENT_PATTERNS: RegExp[] = [
  /free tier can only be used/i,
  /model unavailable/i,
  /\b429\b/,
  /rate.?limit/i,
  /too many requests/i,
  /overloaded/i,
  /\b5\d\d\b/,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN/i,
  /fetch failed/i,
  /socket hang up/i,
  /premature close/i,
  /no capacity|capacity|throttl/i,
  /service unavailable/i,
  /bad gateway/i,
];

const AUTH_PATTERNS: RegExp[] = [
  /unauthorized/i,
  /\b401\b/,
  /\b403\b/,
  /api key not valid|invalid api key|incorrect api key|no api key|missing api key/i,
  /authentication token has been invalidated|token has been expired|invalid token/i,
  /authentication/i,
  /not logged in|login required|please try signing in again/i,
];

export function classifyProviderError(
  message: string,
  status?: number,
): AIErrorKind {
  const text = message ?? "";
  // Check transient patterns first: the free-tier throttle is reported as 403
  // and would otherwise be misread as a credential problem.
  if (TRANSIENT_PATTERNS.some((re) => re.test(text))) return "transient";
  if (status === 401) return "auth";
  if (status === 403) return "unavailable";
  if (status === 404) return "unavailable";
  if (status === 429) return "transient";
  if (status && status >= 500) return "transient";
  if (status && status >= 400) return "unknown";
  if (AUTH_PATTERNS.some((re) => re.test(text))) return "auth";
  if (/timeout|timed out|aborted/i.test(text)) return "timeout";
  return "unknown";
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof AIError) {
    return err.kind === "transient" || err.kind === "timeout" || err.kind === "unavailable";
  }
  return classifyProviderError(err instanceof Error ? err.message : String(err)) === "transient";
}

export function describeError(err: unknown): string {
  if (err instanceof AIError) return `${err.kind}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
