/**
 * The modification patch: the contract between a natural-language request and a
 * change to the WebsiteSpec.
 *
 * Why a patch language instead of "regenerate the spec"
 * ---------------------------------------------------
 * A regeneration re-decides everything, so an unrelated sentence can move a
 * heading, reword a section name, or change the column count of a block the
 * user never mentioned. A patch is explicit about intent and is auditable: the
 * applied operations are the record of what happened.
 *
 * The operations are deliberately few and orthogonal. Every one of them is
 * something the renderer already knows how to honour, so a patch can never
 * require new code.
 */

import { z } from "zod";
import { SECTION_KINDS } from "../spec/schema";

const Target = z.string().max(80);

const SetTextSchema = z.object({
  op: z.literal("setText"),
  target: Target,
  field: z.enum([
    "heading",
    "subheading",
    "tagline",
    "title",
    "description",
    "name",
    "intent",
    "brandText",
    "copyright",
  ]),
  value: z.string().max(600),
});

const SetThemeSchema = z.object({
  op: z.literal("setTheme"),
  field: z.enum([
    "primary",
    "background",
    "text",
    "surface",
    "surfaceAlt",
    "accent",
    "onPrimary",
    "textMuted",
    "border",
  ]),
  value: z.string().max(64),
});

const SetModeSchema = z.object({
  op: z.literal("setMode"),
  value: z.enum(["light", "dark"]),
});

const SetStyleSchema = z.object({
  op: z.literal("setStyle"),
  target: Target,
  field: z.enum([
    "align",
    "columns",
    "paddingY",
    "paddingX",
    "gap",
    "split",
    "side",
    "maxWidth",
    "background",
    "color",
    "radius",
  ]),
  value: z.union([z.string().max(200), z.number().min(0).max(4000)]),
});

const SetKindSchema = z.object({
  op: z.literal("setKind"),
  target: Target,
  value: z.enum(SECTION_KINDS),
});

const SetItemsSchema = z.object({
  op: z.literal("setItems"),
  target: Target,
  value: z
    .array(
      z.object({
        title: z.string().max(160).default(""),
        body: z.string().max(800).default(""),
        meta: z.string().max(160).default(""),
        price: z.string().max(60).default(""),
        badge: z.string().max(60).default(""),
        bullets: z.array(z.string().max(240)).max(12).default([]),
      }),
    )
    .max(24),
});

const RemoveItemSchema = z.object({
  op: z.literal("removeItem"),
  target: Target,
  match: z.string().max(200),
});

const AddSectionSchema = z.object({
  op: z.literal("addSection"),
  after: Target.describe("A section id, or \"end\""),
  kind: z.enum(SECTION_KINDS),
  heading: z.string().max(240).default(""),
  subheading: z.string().max(400).default(""),
  intent: z.string().max(240).default(""),
  items: z
    .array(z.object({ title: z.string().max(160), body: z.string().max(800) }))
    .max(12)
    .default([]),
});

const RemoveSectionSchema = z.object({
  op: z.literal("removeSection"),
  target: Target,
});

const ReorderSchema = z.object({
  op: z.literal("reorder"),
  order: z.array(Target).max(40),
});

const SetLinkSchema = z.object({
  op: z.literal("setLink"),
  target: Target,
  field: z.enum(["label", "href"]),
  index: z.number().int().min(0).max(40),
  value: z.string().max(300),
  /** Footer only: which link list to edit. Ignored for nav and sections. */
  bucket: z.enum(["legal", "social"]).default("legal"),
});

const SetLinksSchema = z.object({
  op: z.literal("setLinks"),
  target: Target,
  value: z
    .array(z.object({ label: z.string().max(80), href: z.string().max(300), primary: z.boolean().default(false) }))
    .max(20),
  /** Footer only: which link list to replace. Ignored for nav and sections. */
  bucket: z.enum(["legal", "social"]).default("legal"),
});

export const PatchOpSchema = z.discriminatedUnion("op", [
  SetTextSchema,
  SetThemeSchema,
  SetModeSchema,
  SetStyleSchema,
  SetKindSchema,
  SetItemsSchema,
  RemoveItemSchema,
  AddSectionSchema,
  RemoveSectionSchema,
  ReorderSchema,
  SetLinkSchema,
  SetLinksSchema,
]);

export type PatchOp = z.infer<typeof PatchOpSchema>;

export const PatchSchema = z.object({
  ops: z.array(PatchOpSchema).max(24),
  note: z.string().max(600).default(""),
  confidence: z.enum(["low", "medium", "high"]).default("medium"),
});

export type Patch = z.infer<typeof PatchSchema>;

/** A compact, human-readable rendering of one operation, for the run log. */
export function describeOp(op: PatchOp): string {
  switch (op.op) {
    case "setText":
      return `set ${op.target}.${op.field} = ${truncate(op.value, 60)}`;
    case "setTheme":
      return `set theme.${op.field} = ${op.value}`;
    case "setMode":
      return `set theme mode = ${op.value}`;
    case "setStyle":
      return `set ${op.target}.style.${op.field} = ${String(op.value)}`;
    case "setKind":
      return `set ${op.target}.kind = ${op.value}`;
    case "setItems":
      return `replace ${op.target}.items (${op.value.length} item(s))`;
    case "removeItem":
      return `remove item matching ${truncate(op.match, 40)} from ${op.target}`;
    case "addSection":
      return `add ${op.kind} section after ${op.after}`;
    case "removeSection":
      return `remove section ${op.target}`;
    case "reorder":
      return `reorder into ${op.order.length} position(s)`;
    case "setLink":
      return `set ${op.target}.${op.bucket}[${op.index}].${op.field} = ${truncate(op.value, 50)}`;
    case "setLinks":
      return `replace ${op.target}.${op.bucket} links (${op.value.length} link(s))`;
  }
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}
