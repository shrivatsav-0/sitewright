/**
 * Optional code-authoring step: the model writes `app/page.tsx`.
 *
 * This is the only place the model emits code, and it is deliberately behind a
 * flag and behind a fallback. `composePage` (JSON composition) always runs; this
 * runs in addition when `GENERATION_MODE=ai-page`. If the authored file fails
 * to build, the validator repairs it a bounded number of times, then the
 * generator rewrites the page deterministically. A model can improve the page
 * and cannot break the run.
 */

import { createLogger } from "../logger";
import { structured } from "../ai/index";
import { text } from "../ai/index";
import { AGENT_PREAMBLE, NO_TOOLS_NOTE } from "../prompts";
import { SECTIONS_TSX } from "./sections";
import { CHROME_TSX } from "./chrome";
import type { WebsiteSpec } from "../spec/schema";
import { z } from "zod";

const log = createLogger("generator/compose");

const AvailableImportsSchema = z.object({
  imports: z.array(z.string()).max(12).default([]),
});

const AVAILABLE_IMPORTS = [
  `import { renderSection } from "../components/sections";`,
  `import { SECTION_COMPONENTS } from "../components/sections";`,
  `import { siteSpec } from "../lib/site-spec";`,
  `import type { SectionSpec, CompositionEntry, Item, Link, AssetRef } from "../lib/types";`,
];

function system(): string {
  return [
    AGENT_PREAMBLE,
    "",
    "TASK: write the single page module of a Next.js App Router site.",
    "",
    "AVAILABLE IMPORTS (these modules already exist; import nothing else)",
    ...AVAILABLE_IMPORTS,
    "",
    "AVAILABLE COMPONENTS",
    ...componentIndex(),
    "",
    "RULES",
    "1. Output one ```tsx fenced block and nothing else.",
    "2. Export a default function component. It must be a server component: no \"use client\".",
    "3. Import only from the modules listed above. Never import a package, never import from a parent directory.",
    "4. Render every section of the supplied composition, in order. You may wrap them in layout elements",
    "   (a <div> grid, a fragment) but you may not drop, duplicate, or invent sections.",
    "5. Do not write CSS beyond Tailwind utility classes. Do not add <style> blocks.",
    "6. Do not use hooks, event handlers, or browser APIs.",
    "7. Keep it short. A correct 40-line page beats an elaborate broken one.",
    "",
    NO_TOOLS_NOTE,
  ].join("\n");
}

/** The public export names of the section library, so the model cannot guess. */
function componentIndex(): string[] {
  const names = new Set<string>();
  for (const m of SECTIONS_TSX.matchAll(/export function ([A-Z][A-Za-z0-9]*)/g)) {
    names.add(m[1]);
  }
  for (const m of CHROME_TSX.matchAll(/export function ([A-Z][A-Za-z0-9]*)/g)) {
    names.add(m[1]);
  }
  return Array.from(names).map((n) => `- ${n}`);
}

function user(spec: WebsiteSpec, composition: { kind: string; id: string }[]): string {
  const summary = composition.map((c) => ({ id: c.id, kind: c.kind, name: findName(spec, c.id) }));
  return [
    "PAGE SECTIONS, in order",
    JSON.stringify(summary, null, 2),
    "",
    "SITE TITLE",
    spec.meta.title,
    "",
    `Write \`app/page.tsx\` for these ${composition.length} sections.`,
  ].join("\n");
}

function findName(spec: WebsiteSpec, id: string): string {
  return spec.sections.find((s) => s.id === id)?.name ?? id;
}

export interface ComposeResult {
  source: string | null;
  model: string;
  /** Why authoring was skipped, when it was. */
  skipped?: string;
}

/**
 * Ask for a page module. Returns `null` on any failure — every failure path is
 * expected, not exceptional, because the deterministic page is always valid.
 */
export async function authorPage(args: {
  spec: WebsiteSpec;
  composition: { kind: string; id: string }[];
  signal?: AbortSignal;
}): Promise<ComposeResult> {
  // One cheap structured call first: it confirms the model is on-plan and gives
  // us a token-bounded way to bail out before spending a long code completion.
  try {
    const check = await structured({
      operation: "generate",
      label: "page-preflight",
      system: system(),
      user: user(args.spec, args.composition),
      schema: AvailableImportsSchema,
      maxAttempts: 1,
      maxOutputTokens: 200,
      signal: args.signal,
    });
    const ok = check.data.imports.some((i) => i.includes("components/sections"));
    if (!ok) {
      log.warn("page authoring preflight did not confirm the component import; skipping", {
        model: check.model,
      });
      return { source: null, model: check.model, skipped: "preflight" };
    }
  } catch (err) {
    log.warn("page authoring preflight failed; skipping", {
      error: err instanceof Error ? err.message.slice(0, 160) : String(err),
    });
    return { source: null, model: "", skipped: "preflight" };
  }

  try {
    const res = await text({
      operation: "generate",
      label: "page-source",
      system: system(),
      user: user(args.spec, args.composition),
      maxOutputTokens: 3000,
      temperature: 0.2,
      signal: args.signal,
    });
    return { source: res.text, model: res.model };
  } catch (err) {
    log.warn("page authoring failed; using the deterministic page", {
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return { source: null, model: "", skipped: "completion" };
  }
}
