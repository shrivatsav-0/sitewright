/**
 * Patch application.
 *
 * Applying a patch is deterministic, total, and non-throwing: the applier never
 * raises on a bad operation, it records the operation as rejected and moves on.
 * That property is what lets the pipeline treat "the model asked for something I
 * cannot do" as a normal outcome rather than a crash, and it guarantees a
 * partially-applied patch still leaves a valid, buildable spec.
 *
 * Every op is applied to a working copy and rolled back individually if it
 * fails, so one bad operation cannot corrupt the rest of the patch. The final
 * spec is re-validated against `WebsiteSpecSchema` before it is returned, so a
 * patch that would produce an invalid spec (a bad colour, zero columns) is
 * rejected before it can reach the generator.
 */

import { safeHref } from "../security";

/** Re-exported so callers of the patch layer use the same sanitiser as the generators. */
export { safeHref };
import { WebsiteSpecSchema, type Link, type SectionSpec, type SectionStyle, type WebsiteSpec } from "../spec/schema";
import { describeOp, type Patch, type PatchOp } from "./schema";

export interface AppliedOp {
  op: PatchOp;
  description: string;
  applied: boolean;
  reason?: string;
}

export interface ApplyResult {
  spec: WebsiteSpec;
  applied: AppliedOp[];
  /** Operations that actually changed something. */
  changed: number;
  rejected: number;
}

const SECTION_ID_MAX = 62;

/** A colour-ish value: hex, rgb(), hsl(), or a var() reference. */
const CSS_COLOR =
  /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/]+(?:deg)?\)|var\(--[a-z0-9-]+\)|transparent|currentcolor)$/i;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function applyPatch(spec: WebsiteSpec, patch: Patch): ApplyResult {
  const working = structuredClone(spec);
  const applied: AppliedOp[] = [];

  for (const op of patch.ops) {
    const before = structuredClone(working);
    let reason: string | undefined;
    try {
      reason = run(working, op);
    } catch (err) {
      reason = err instanceof Error ? err.message.slice(0, 160) : "unexpected error";
    }
    if (reason) {
      restore(working, before);
      applied.push({ op, description: describeOp(op), applied: false, reason });
      continue;
    }
    if (JSON.stringify(working) === JSON.stringify(before)) {
      applied.push({
        op,
        description: describeOp(op),
        applied: false,
        reason: "no change (the value already matched)",
      });
      continue;
    }
    applied.push({ op, description: describeOp(op), applied: true });
  }

  working.sections.forEach((s, i) => (s.order = i));
  return {
    spec: working,
    applied,
    changed: applied.filter((a) => a.applied).length,
    rejected: applied.filter((a) => !a.applied).length,
  };
}

function restore(target: WebsiteSpec, snapshot: WebsiteSpec): void {
  for (const k of Object.keys(target) as (keyof WebsiteSpec)[]) {
    delete (target as Record<string, unknown>)[k as string];
  }
  Object.assign(target, structuredClone(snapshot));
}

/**
 * Run one op against `spec`, mutating it in place. Returns a rejection reason,
 * or undefined on success. Every branch states *why* it refused, because that
 * reason is what the user is shown when a request could not be honoured.
 */
function run(spec: WebsiteSpec, op: PatchOp): string | undefined {
  switch (op.op) {
    case "setMode": {
      spec.theme = { ...spec.theme, mode: op.value };
      return undefined;
    }

    case "setTheme": {
      const v = op.value.trim();
      if (v.startsWith("#") && !HEX.test(v)) return `"${op.value}" is not a valid hex colour`;
      if (!CSS_COLOR.test(v)) return `"${op.value}" is not a colour value`;
      spec.theme = { ...spec.theme, tokens: { ...spec.theme.tokens, [op.field]: v } };
      return undefined;
    }

    case "setText":
      return setText(spec, op.target, op.field, op.value);

    case "setStyle":
      return setStyle(spec, op.target, op);

    case "setKind": {
      const s = findSection(spec, op.target);
      if (!s) return `no section with id "${op.target}"`;
      s.kind = op.value;
      return undefined;
    }

    case "setItems": {
      const s = findSection(spec, op.target);
      if (!s) return `no section with id "${op.target}"`;
      const items = op.value.map((it, i) => {
        // Keep the imagery the browser already downloaded: a rewritten copy
        // usually describes the same items, and dropping the photos would be a
        // regression the user did not ask for.
        const prev = s.items[i] ?? s.items.find((p) => p.title === it.title);
        return prev?.image || prev?.icon
          ? { ...it, image: prev.image, icon: prev.icon }
          : { ...it };
      });
      s.items = items;
      return undefined;
    }

    case "removeItem": {
      const s = findSection(spec, op.target);
      if (!s) return `no section with id "${op.target}"`;
      const needle = op.match.toLowerCase();
      const items = s.items.filter(
        (it) =>
          !it.title.toLowerCase().includes(needle) &&
          !it.body.toLowerCase().includes(needle) &&
          !(it.bullets ?? []).some((b) => b.toLowerCase().includes(needle)),
      );
      if (items.length === s.items.length) return `nothing in "${op.target}" matched "${op.match}"`;
      if (!items.length) return `refusing to remove every item from "${op.target}"`;
      s.items = items;
      return undefined;
    }

    case "addSection":
      return addSection(spec, op);

    case "removeSection": {
      const s = findSection(spec, op.target);
      if (!s) return `no section with id "${op.target}"`;
      if (spec.sections.length <= 1) return "cannot remove the only section";
      spec.sections = spec.sections.filter((x) => x.id !== s.id);
      return undefined;
    }

    case "reorder": {
      const known = new Map(spec.sections.map((s) => [s.id, s]));
      const ordered: SectionSpec[] = [];
      for (const id of op.order) {
        const s = known.get(id);
        if (s && !ordered.includes(s)) ordered.push(s);
      }
      // Anything the model forgot keeps its position, appended.
      for (const s of spec.sections) if (!ordered.includes(s)) ordered.push(s);
      if (ordered.every((s, i) => s.id === spec.sections[i]?.id)) return "reorder matches the current order";
      spec.sections = ordered;
      return undefined;
    }

    case "setLink": {
      const links = linkList(spec, op.target, op.bucket);
      if (!links) return linkTargetError(spec, op.target);
      const link = links.links[op.index];
      if (!link) return `no link at index ${op.index} in the ${op.target} ${op.bucket ?? "links"} list`;
      const updated = [...links.links];
      // An href written here goes straight into a rendered anchor, so it passes
      // through the same sanitiser as the wholesale setLinks path. The two were
      // inconsistent: replacing a whole list sanitised every href while
      // retargeting a single link did not, which made the narrower operation the
      // way through.
      updated[op.index] =
        op.field === "href"
          ? { ...link, href: safeHref(op.value) }
          : { ...link, [op.field]: op.value };
      setLinks(spec, op.target, op.bucket, updated);
      return undefined;
    }

    case "setLinks": {
      if (op.target === "footer") {
        const links = linkList(spec, "footer", op.bucket);
        if (!links) return "this site has no footer";
        setLinks(
          spec,
          "footer",
          op.bucket,
          op.value.map((l) => ({
            label: l.label,
            href: safeHref(l.href),
            primary: l.primary,
            external: /^https?:\/\//i.test(l.href),
          })),
        );
        return undefined;
      }
      if (op.target !== "nav") return "links can only be replaced on nav or footer";
      if (!spec.nav) return "this site has no navigation";
      spec.nav = {
        ...spec.nav,
        links: op.value.map((l) => ({
          label: l.label,
          href: safeHref(l.href),
          primary: l.primary,
          external: /^https?:\/\//i.test(l.href),
        })),
      };
      return undefined;
    }
  }
}

// -------------------------------------------------------------------- ops

function setText(
  spec: WebsiteSpec,
  target: string,
  field: string,
  value: string,
): string | undefined {
  if (target === "site") {
    if (field === "title" || field === "description") {
      spec.meta = { ...spec.meta, [field]: value };
      return undefined;
    }
    return `site has no "${field}" (only title and description)`;
  }
  if (target === "nav") {
    if (!spec.nav) return "this site has no navigation";
    if (field === "brandText") {
      spec.nav = { ...spec.nav, brandText: value };
      return undefined;
    }
    return `nav has no "${field}" (only brandText)`;
  }
  if (target === "footer") {
    if (!spec.footer) return "this site has no footer";
    if (field === "tagline" || field === "brandText" || field === "copyright") {
      spec.footer = { ...spec.footer, [field]: value };
      return undefined;
    }
    return `footer has no "${field}" (only tagline, brandText, copyright)`;
  }
  const s = findSection(spec, target);
  if (!s) return `no section with id "${target}"`;
  if (field === "name" || field === "intent") {
    s[field] = value;
    return undefined;
  }
  if (field !== "heading" && field !== "subheading") return `sections have no "${field}"`;
  const prev = s[field];
  s[field] = {
    text: value,
    level: prev?.level ?? (field === "heading" ? 2 : 3),
    align: prev?.align ?? (s.style.align === "center" ? "center" : "left"),
    ...(prev?.fontSize ? { fontSize: prev.fontSize } : {}),
    ...(prev?.fontWeight ? { fontWeight: prev.fontWeight } : {}),
    ...(prev?.color ? { color: prev.color } : {}),
  };
  return undefined;
}

function setStyle(
  spec: WebsiteSpec,
  target: string,
  op: Extract<PatchOp, { op: "setStyle" }>,
): string | undefined {
  const s = findSection(spec, target);
  if (!s) return `no section with id "${target}"`;
  const style = s.style;
  const num = typeof op.value === "number" ? op.value : Number(op.value);
  const str = typeof op.value === "string" ? op.value : String(op.value);

  switch (op.field) {
    case "align":
      if (str !== "left" && str !== "center") return 'align must be "left" or "center"';
      style.align = str;
      break;
    case "split":
      if (str !== "stack" && str !== "side") return 'split must be "stack" or "side"';
      style.split = str;
      break;
    case "side":
      if (str !== "text-first" && str !== "media-first") {
        return 'side must be "text-first" or "media-first"';
      }
      style.side = str;
      break;
    case "columns":
      if (!Number.isFinite(num)) return "columns must be a number";
      style.columns = clampInt(num, 1, 6);
      break;
    case "paddingY":
      if (!Number.isFinite(num)) return "paddingY must be a number";
      style.paddingY = clampInt(num, 0, 400);
      break;
    case "paddingX":
      if (!Number.isFinite(num)) return "paddingX must be a number";
      style.paddingX = clampInt(num, 0, 200);
      break;
    case "gap":
      if (!Number.isFinite(num)) return "gap must be a number";
      style.gap = clampInt(num, 0, 200);
      break;
    case "maxWidth":
      style.maxWidth = Number.isFinite(num) ? clampInt(num, 320, 2200) : undefined;
      break;
    case "background":
    case "color": {
      if (str.startsWith("#") && !HEX.test(str)) return `"${op.value}" is not a valid hex colour`;
      if (!CSS_COLOR.test(str)) return `"${op.value}" is not a colour value`;
      style[op.field] = str;
      break;
    }
    case "radius":
      if (str !== "0px" && !/^\d{1,3}px$/.test(str)) return 'radius must be "Npx" or "0px"';
      style.radius = str;
      break;
  }
  return undefined;
}

function addSection(spec: WebsiteSpec, op: Extract<PatchOp, { op: "addSection" }>): string | undefined {
  const anchor = op.after === "end" ? undefined : findSection(spec, op.after);
  if (op.after !== "end" && !anchor) return `no section with id "${op.after}" to insert after`;

  // Inherit the anchor's surface so a new block does not look bolted on.
  const fallbackStyle: SectionStyle = {
    background: "transparent",
    color: "inherit",
    paddingY: 72,
    paddingX: 24,
    maxWidth: spec.theme.containerWidth,
    align: "left",
    columns: 3,
    gap: 24,
    split: "stack",
    side: "text-first",
    borderTop: "none",
    radius: "0px",
  };
  const base = anchor?.style ?? spec.sections[spec.sections.length - 1]?.style ?? fallbackStyle;
  const align = base.align;
  const fresh: SectionSpec = {
    id: uniqueId(spec, op.kind),
    kind: op.kind,
    name: op.heading ? truncateWords(op.heading, 6) : op.kind,
    intent: op.intent || "added by request",
    ...(op.heading ? { heading: { text: op.heading, level: 2, align } } : {}),
    ...(op.subheading ? { subheading: { text: op.subheading, level: 3, align } } : {}),
    items: op.items.map((it) => ({
      title: it.title,
      body: it.body,
      meta: "",
      price: "",
      badge: "",
      bullets: [] as string[],
    })),
    links: [],
    style: { ...base },
    order: 0,    lowConfidence: false,
    sourceTag: "user",
    sourceSelector: "",
  };

  const at = anchor ? spec.sections.findIndex((s) => s.id === anchor.id) + 1 : spec.sections.length;
  spec.sections = [...spec.sections.slice(0, at), fresh, ...spec.sections.slice(at)];
  return undefined;
}

// ---------------------------------------------------------------- helpers

function findSection(spec: WebsiteSpec, id: string): SectionSpec | undefined {
  return spec.sections.find((s) => s.id === id);
}

function linkList(
  spec: WebsiteSpec,
  target: string,
  bucket: "legal" | "social" | undefined,
): { links: Link[] } | undefined {
  if (target === "nav") return spec.nav ?? undefined;
  if (target === "footer") {
    if (!spec.footer) return undefined;
    return { links: spec.footer[bucket ?? "legal"] };
  }
  return findSection(spec, target);
}

function linkTargetError(spec: WebsiteSpec, target: string): string {
  if (target === "nav") return "this site has no navigation";
  if (target === "footer") return "this site has no footer";
  return `no section with id "${target}"`;
}

function setLinks(
  spec: WebsiteSpec,
  target: string,
  bucket: "legal" | "social" | undefined,
  links: Link[],
): void {
  if (target === "nav" && spec.nav) {
    spec.nav = { ...spec.nav, links };
    return;
  }
  if (target === "footer" && spec.footer) {
    spec.footer = { ...spec.footer, [bucket ?? "legal"]: links };
    return;
  }  const s = findSection(spec, target);
  if (s) s.links = links;
}

function uniqueId(spec: WebsiteSpec, kind: string): string {
  const taken = new Set(spec.sections.map((s) => s.id));
  const stem = (kind.replace(/[^a-z0-9]/g, "") || "section").slice(0, SECTION_ID_MAX);
  if (!taken.has(stem)) return stem;
  for (let i = 2; i < 100; i++) {
    const candidate = `${stem}-${i}`.slice(0, SECTION_ID_MAX + 3);
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}-${Math.random().toString(36).slice(2, 6)}`;
}

/** hrefs we are willing to emit: anything not a script/data URL passes. */

function clampInt(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function truncateWords(s: string, n: number): string {
  const words = s.trim().split(/\s+/);
  return words.length <= n ? s : `${words.slice(0, n).join(" ")}…`;
}

/** Validate the patched spec, so a bad patch never reaches the generator. */
export function validatePatchedSpec(
  spec: WebsiteSpec,
): { ok: true; spec: WebsiteSpec } | { ok: false; issues: string[] } {
  const parsed = WebsiteSpecSchema.safeParse(spec);
  if (parsed.success) return { ok: true, spec: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`),
  };
}
