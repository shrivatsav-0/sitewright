/**
 * Prompts.
 *
 * Two rules govern everything here:
 *
 *   1. **Never send HTML.** The model sees a JSON digest of measured facts.
 *      Raw markup is 50–200× larger, mostly irrelevant, and the single easiest
 *      way to get a model to "clone" by copying markup instead of reasoning.
 *
 *   2. **Ask for JSON, in a shape the schema already knows.** The output
 *      contract is restated in the prompt because free models follow an
 *      explicit example far more reliably than an implied one, and restating it
 *      is a few hundred tokens against a saved correction round-trip.
 *
 * Each prompt is a function of its inputs so the exact text sent can be
 * asserted in tests and printed by the doctor script.
 */

import { SECTION_KINDS } from "../spec/schema";
import type { PageDigest } from "../analyzer/normalize";

/** One-line framing shared by every stage, so the model knows the job. */
export const AGENT_PREAMBLE = [
  "You are the analysis engine of Sitewright, an agent that rebuilds existing websites as clean React components.",
  "You never see the page's HTML and you never write code. You are given a JSON digest of what a real browser measured",
  "on the page (computed styles, geometry, text) and you decide what each block MEANS.",
].join(" ");

/**
 * The permitted chrome variants.
 *
 * The prompt used to describe these two fields as plain strings, so the model
 * dutifully invented descriptive ones - "topbar-with-utility-strip",
 * "multi-column" - which the schema then rejected, costing an extra full model
 * call on every run purely to send a correction. Naming the exact vocabulary
 * removes that retry outright. These are asserted against the schema in the
 * tests, so the two cannot drift apart.
 */
const NAV_VARIANTS = ["logo-links", "logo-links-cta", "centered", "minimal", "stacked"] as const;
const FOOTER_VARIANTS = ["columns", "simple", "centered"] as const;

export const NO_TOOLS_NOTE =
  "You have no tools. Answer directly with the requested document and nothing else.";

// ------------------------------------------------------------ site plan

export function sitePlanSystem(): string {
  return [
    AGENT_PREAMBLE,
    "",
    "TASK: classify every visual block on the page and describe it in plain language.",
    "",
    "RULES",
    "1. Output one JSON document and nothing else. No prose, no markdown fences, no comments.",
    "2. `sections` must cover the measured blocks in document order. The `from` field is the index of the first",
    "   measured block that the section starts at. Use every index between 0 and the last one, in ascending order,",
    "   with no gaps and no repeats. If two adjacent blocks are really one block (a logo strip immediately followed",
    "   by a trust banner, say), put the extra indices in that section's `merge` array instead of emitting a new entry.",
    "3. `kind` must be exactly one of: " + SECTION_KINDS.join(", ") + ".",
    "   Pick the closest fit. Use \"unknown\" only when nothing in the list describes it.",
    "4. `heading` and `subheading`: copy the page's own wording. Only write something different if the measured",
    "   text is empty or obviously a placeholder like \"Lorem ipsum\".",
    "5. `items`: leave it empty unless the measured items are wrong or a block clearly needs content that was",
    "   never detected (a pricing block whose tiers were missed, say). The measured text is what actually gets",
    "   rendered: anything you write here is used only to fill a gap the extractor left, so writing your own",
    "   copy achieves nothing except losing the page's real wording. At most 6.",
    "6. `inferred: true` means you are reconstructing a block rather than reading one. Be honest about it.",
    "7. Do not invent sections that were not measured. Do not drop a block unless it is purely decorative.",
    "8. Reference screenshots of the source page may be attached as images. Use them to confirm layout, colour,",
    "   spacing and typography; the measured JSON is still authoritative when the two disagree.",
    "",
    "OUTPUT SHAPE",
    "{",
    '  "site": { "title": string, "description": string, "summary": string, "designLanguage": string, "audience": string },',
    '  "theme": { "mode": "light"|"dark", "primary": "#rrggbb" },',
    '  "nav": { "variant": "' + NAV_VARIANTS.join("|") + '", "brandText": string,',
    '            "links": [ { "label": string, "href": string, "primary": boolean } ] },',
    '  "footer": { "variant": "' + FOOTER_VARIANTS.join("|") + '", "tagline": string,',
    '              "columns": [ { "heading": string, "links": [ { "label": string, "href": string } ] } ] },',
    '  "sections": [ { "from": number, "merge": number[], "kind": string, "name": string, "intent": string,',
    '                 "heading": string, "subheading": string, "items": [ { "title": string, "body": string,',
    '                 "price": string, "badge": string } ], "inferred": boolean } ],',
    '  "warnings": [ string ]',
    "}",
    "",
    NO_TOOLS_NOTE,
  ].join("\n");
}

export function sitePlanUser(digest: PageDigest): string {
  return [
    "Here is what the browser measured.",
    "",
    JSON.stringify(digest, null, 0),
    "",
    `Classify all ${digest.sections.length} measured blocks and return the JSON document described in the system prompt.`,
    `The \`from\` indices must be 0 through ${Math.max(0, digest.sections.length - 1)} in order.`,
  ].join("\n");
}

export const SITE_PLAN_HINTS = [
  "The `from` indices must cover 0..N with no gaps and no repeats.",
  "`kind` must be one of the listed values.",
  "Output only the JSON object. No explanation before or after it.",
];

// ---------------------------------------------------------- page composition

export const PAGE_SYSTEM = [
  AGENT_PREAMBLE,
  "",
  "TASK: compose the page's top-level layout module as React.",
  "",
  "A renderer already exists that turns a validated site specification into the visual result, section by section.",
  "Your only job is the composition file: which sections, in which order, in which grouping.",
  "",
  "RULES",
  "1. Output one JSON document: { \"sections\": [ { \"kind\": string, \"id\": string, \"props\": object } ] }.",
  "2. Use only section kinds that appear in the supplied section list. Do not invent new kinds.",
  "3. Preserve the source page's order. Merge two sections into one only when they are genuinely one block.",
  "4. `props` may contain any of: heading, subheading, align, columns, items, links, media, backgroundMedia, paddingY.",
  "5. Do not write JSX, CSS, or imports. Do not add interactivity. The renderer supplies the components.",
  "6. If anything is unclear, return the sections exactly as supplied. A faithful default beats a clever guess.",
  "",
  "OUTPUT SHAPE",
  '{ "sections": [ { "kind": "hero", "id": "hero", "props": { "align": "left" } } ] }',
  "",
  NO_TOOLS_NOTE,
].join("\n");

export function pageUser(list: { index: number; kind: string; name: string; height: number; heading: string }[]): string {
  return [
    "Measured sections of the source page, in order:",
    JSON.stringify(list),
    "",
    "Return the composition JSON for these sections.",
  ].join("\n");
}

export const PAGE_HINTS = [
  "Only use kinds that appear in the supplied list.",
  "Output only the JSON object.",
];

// ------------------------------------------------------------- modification

export function modifySystem(specSummary: string, kinds: string[]): string {
  return [
    AGENT_PREAMBLE,
    "",
    "TASK: turn a user's natural-language request into a change against an existing site specification.",
    "",
    "The site is a validated document. You are not regenerating it, and you are not writing code.",
    "You produce a patch: a list of operations the agent applies to the document.",
    "",
    "AVAILABLE OPERATIONS",
    '- { "op": "setText",     "target": "<section id or \"nav|footer|site>\", "field": \"heading\"|\"subheading\"|\"tagline\"|\"title\"|\"description\", "value\": string }',
    '- { "op": "setTheme",    "field": "primary"|"background"|"text"|"surface"|"accent", "value": "#rrggbb" }',
    '- { "op": "setMode",     "value": "light"|"dark" }',
    '- { "op": "setStyle",    "target": "<section id>", "field": "align"|"columns"|"paddingY"|"split", "value": string|number }',
    '- { "op": "setKind",     "target": "<section id>", "value": one of: ' +
      kinds.join(", ") +
      " }",
    '- { "op": "setItems",    "target": "<section id>", "value": [ { "title": string, "body": string } ] }',
    '- { "op": "removeItem",  "target": "<section id>", "match": string }',
    '- { "op": "addSection",  "after": "<section id or \\"end\\">", "kind": string, "heading": string, "subheading": string, "intent": string }',
    '- { "op": "removeSection", "target": "<section id>" }',
    '- { "op": "reorder",     "order": [ "<section id>", ... ] }',
    '- { "op": "setLink",     "target": "nav|footer|<section id>", "field": "label"|"href", "index": number, "value": string, "bucket": "legal"|"social" }',
    '- { "op": "setLinks",    "target": "nav|<section id>", "value": [ { "label": string, "href": string, "primary": boolean } ] }',
    "",
    "RULES",
    "1. Use the smallest set of operations that satisfies the request. Prefer editing over rebuilding.",
    "2. Only reference ids that exist in the site summary below.",
    "3. If the request cannot be expressed with these operations, still return your best approximation and put the",
    "   gap in `note`. Do not invent an operation.",
    "4. Output one JSON document: { \"ops\": [ ... ], \"note\": string, \"confidence\": \"low\"|\"medium\"|\"high\" }.",
    "",
    "SITE SUMMARY",
    specSummary,
    "",
    NO_TOOLS_NOTE,
  ].join("\n");
}

export function modifyUser(request: string, specSummary: string): string {
  return [
    "CURRENT SITE",
    specSummary,
    "",
    "USER REQUEST",
    `"""${request}"""`,
    "",
    "Return the patch JSON.",
  ].join("\n");
}

export const MODIFY_HINTS = [
  "Use only the listed operations.",
  "Only reference section ids that appear in the site summary.",
  "Output only the JSON object.",
];

// ------------------------------------------------------------------ repair

export function repairSystem(language: "ts" | "css"): string {
  if (language === "css") {
    return [
      "You fix broken CSS in a generated stylesheet. The file is Tailwind CSS v4 plus a small block of custom",
      "properties. A build error means the CSS parser rejected something.",
      "",
      "RULES",
      "1. Return the complete corrected stylesheet, not a diff.",
      "2. Change only what the error points at. Do not redesign the site.",
      "3. Preserve every custom property and every @theme block.",
      "",
      NO_TOOLS_NOTE,
    ].join("\n");
  }
  return [
    "You fix TypeScript/React compile errors in a generated Next.js page module.",
    "",
    "RULES",
    "1. Return the complete corrected file. Not a diff, not a fragment.",
    "2. Change only what the error points at. Do not redesign the layout, do not remove sections,",
    "   do not add dependencies. The components and props you are given already exist.",
    "3. Never import anything that is not listed as available. Never use `any` to silence a real type error.",
    "4. If an error refers to a component or prop that does not exist, remove the usage rather than inventing it.",
    "",
    NO_TOOLS_NOTE,
  ].join("\n");
}

export function repairUser(input: {
  language: "ts" | "css";
  filename: string;
  source: string;
  errors: string[];
  availableImports?: string[];
}): string {
  const parts = [
    `FILE: ${input.filename}`,
    "",
    "AVAILABLE IMPORTS",
    (input.availableImports ?? ["none"]).join("\n"),
    "",
    "BUILD ERRORS",
    input.errors.slice(0, 6).join("\n"),
    "",
    "CURRENT CONTENT",
    "```" + input.language,
    input.source.length > 12_000 ? input.source.slice(0, 12_000) + "\n…(truncated)" : input.source,
    "```",
    "",
    `Return the complete corrected ${input.language === "ts" ? "TypeScript module" : "stylesheet"} and nothing else.`,
  ];
  return parts.join("\n");
}
