/**
 * Natural-language modification.
 *
 * The cost argument
 * -----------------
 * The model is shown a *summary* of the spec, not the spec. A summary carries
 * every field a patch can address — ids, kinds, names, headings, item counts,
 * style knobs, the nav and footer link labels — in a fraction of the tokens,
 * because it omits the long text bodies and the asset metadata that no
 * modification op can reference. Typical reduction is 8–15×.
 *
 * The result is a patch against the *stored* spec, so a simple change never
 * re-crawls, re-classifies, or re-downloads anything. Regeneration stays
 * available as an explicit user action.
 */

import { structured } from "../ai/index";
import { config } from "../config";
import { createLogger } from "../logger";
import { MODIFY_HINTS, modifySystem, modifyUser } from "../prompts";
import { SECTION_KINDS, type WebsiteSpec } from "../spec/schema";
import { applyPatch, validatePatchedSpec, type AppliedOp } from "./apply";
import { PatchSchema, type Patch } from "./schema";

const log = createLogger("modifier");

const clip = (s: string | undefined, n: number): string => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * The compact view of the site that the model reasons over.
 *
 * Emitted as JSON because models follow an explicit shape better than prose,
 * and because it is the same document the user sees in the UI panel.
 */
export function specSummary(spec: WebsiteSpec): string {
  return JSON.stringify(
    {
      site: { title: spec.meta.title, description: clip(spec.meta.description, 140) },
      theme: { mode: spec.theme.mode, primary: spec.theme.tokens.primary, background: spec.theme.tokens.background },
      nav: spec.nav
        ? {
            variant: spec.nav.variant,
            brand: clip(spec.nav.brandText, 40),
            links: spec.nav.links.map((l) => clip(l.label, 30)),
          }
        : null,
      footer: spec.footer
        ? {
            variant: spec.footer.variant,
            tagline: clip(spec.footer.tagline, 80),
            columns: spec.footer.columns.map((c) => ({
              heading: clip(c.heading, 30),
              links: c.links.map((l) => clip(l.label, 24)),
            })),
          }
        : null,
      sections: spec.sections.map((s) => ({
        id: s.id,
        kind: s.kind,
        name: clip(s.name, 40),
        heading: clip(s.heading?.text, 70),
        subheading: clip(s.subheading?.text, 70),
        items: s.items.length,
        itemTitles: s.items.slice(0, 6).map((i) => clip(i.title, 34)),
        align: s.style.align,
        columns: s.style.columns,
        split: s.style.split,
        paddingY: s.style.paddingY,
        background: s.style.background,
      })),
      availableKinds: SECTION_KINDS,
    },
    null,
    0,
  );
}

export interface ModificationResult {
  patch: Patch;
  spec: WebsiteSpec;
  /** The spec as it was before, for rollback. */
  previous: WebsiteSpec;
  model: string;
  attempts: number;
  applied: AppliedOp[];
  changed: number;
  rejected: number;
  note: string;
  confidence: "low" | "medium" | "high";
  /** Present when the patch was rejected outright. */
  error?: string;
}

export interface ModifyOptions {
  spec: WebsiteSpec;
  request: string;
  signal?: AbortSignal;
}

/**
 * Turn a request into an applied patch.
 *
 * Bounded: at most `maxAttempts` structured calls, each of which is itself
 * bounded by the provider's model-rotation budget. On total failure the original
 * spec is returned with an `error`, and the caller simply does not regenerate —
 * no partial state, no infinite retry.
 */
export async function modifySite(opts: ModifyOptions): Promise<ModificationResult> {
  const summary = specSummary(opts.spec);
  const maxAttempts = config().ai.maxStructureAttempts;

  let patch: Patch | null = null;
  let model = "";
  let attempts = 0;
  let error: string | undefined;

  try {
    const res = await structured({
      operation: "modify",
      label: "modification",
      system: modifySystem(summary, [...SECTION_KINDS]),
      user: modifyUser(opts.request, summary),
      schema: PatchSchema,
      maxAttempts,
      temperature: 0.1,
      correctionHints: MODIFY_HINTS,
      signal: opts.signal,
    });
    patch = res.data;
    model = res.model;
    attempts = res.attempts;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    log.warn("modification failed", { error: error.slice(0, 200) });
    return {
      patch: { ops: [], note: "", confidence: "low" },
      spec: opts.spec,
      previous: opts.spec,
      model,
      attempts,
      applied: [],
      changed: 0,
      rejected: 0,
      note: "",
      confidence: "low",
      error,
    };
  }

  if (!patch.ops.length) {
    return {
      patch,
      spec: opts.spec,
      previous: opts.spec,
      model,
      attempts,
      applied: [],
      changed: 0,
      rejected: 0,
      note: patch.note,
      confidence: patch.confidence,
      error: patch.note || "The model did not propose any change.",
    };
  }

  const result = applyPatch(opts.spec, patch);
  const valid = validatePatchedSpec(result.spec);

  if (!valid.ok) {
    log.warn("patch produced an invalid spec; keeping the original", { issues: valid.issues });
    return {
      patch,
      spec: opts.spec,
      previous: opts.spec,
      model,
      attempts,
      applied: result.applied,
      changed: 0,
      rejected: result.applied.length,
      note: patch.note,
      confidence: patch.confidence,
      error: `The proposed change would produce an invalid site, so nothing was applied: ${valid.issues[0]}`,
    };
  }

  if (!result.changed) {
    return {
      patch,
      spec: opts.spec,
      previous: opts.spec,
      model,
      attempts,
      applied: result.applied,
      changed: 0,
      rejected: result.rejected,
      note: patch.note,
      confidence: patch.confidence,
      error: result.applied[0]?.reason ?? "Nothing in the patch changed the site.",
    };
  }

  log.info("patch applied", {
    model,
    changed: result.changed,
    rejected: result.rejected,
    ops: result.applied.filter((a) => a.applied).map((a) => a.description),
  });

  return {
    patch,
    spec: valid.spec,
    previous: opts.spec,
    model,
    attempts,
    applied: result.applied,
    changed: result.changed,
    rejected: result.rejected,
    note: patch.note,
    confidence: patch.confidence,
  };
}

/** One-line, user-facing account of what a patch did. */
export function summariseModification(result: ModificationResult): string {
  if (result.error) return result.error;
  const done = result.applied.filter((a) => a.applied).map((a) => a.description);
  const skipped = result.applied.filter((a) => !a.applied);
  const parts = [`${result.changed} change${result.changed === 1 ? "" : "s"}: ${done.join("; ")}`];
  if (result.note) parts.push(result.note);
  if (skipped.length) {
    parts.push(
      `${skipped.length} operation${skipped.length === 1 ? "" : "s"} skipped: ${skipped
        .slice(0, 3)
        .map((s) => s.reason ?? "unknown")
        .join("; ")}`,
    );
  }
  return parts.join(" — ");
}
