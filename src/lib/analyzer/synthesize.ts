/**
 * Spec synthesis: measured extraction + AI plan → validated WebsiteSpec.
 *
 * The merge is deliberately one-directional. Measurements win on anything
 * visual (backgrounds, padding, columns, colours, fonts); the plan wins on
 * anything semantic (kind, name, intent, copy). Where the plan asks for
 * something the measurements cannot supply — a section with no detected items,
 * say — the plan's version is used and the section is flagged `lowConfidence`
 * so the UI can be honest about it.
 */

import path from "node:path";
import { z } from "zod";
import { buildDigest, buildSectionStyle, buildTheme, contrastReport, type PageDigest } from "./normalize";
import { collectAssets } from "./normalize";
import { structured } from "../ai/index";
import { config } from "../config";
import { createLogger } from "../logger";
import { safeHref } from "../security";
import { clampMeasured } from "./clamp";
import { AssetFetcher } from "../crawler/assets";
import type { AnalysisResult } from "../crawler/browser";
import {
  AssetRefSchema,
  coerceKind,
  SECTION_KINDS,
  WebsiteSpecSchema,
  type AssetRef,
  type Item,
  type Link,
  type SectionSpec,
  type WebsiteSpec,
} from "../spec/schema";
import { SitePlanSchema, type PlanSection, type SitePlan } from "./plan";
import { pageUser, PAGE_SYSTEM, PAGE_HINTS, sitePlanSystem, sitePlanUser, SITE_PLAN_HINTS } from "../prompts";
import { DEFAULT_PADDING_Y } from "../generator/measure";

const log = createLogger("analyzer/synthesize");

export interface SynthesizeInput {
  analysis: AnalysisResult;
  /** Public dir of the generated project; assets are written here. */
  publicDir: string;
  signal?: AbortSignal;
  onProgress?: (msg: string, detail?: Record<string, unknown>) => void;
}

export interface SynthesizeResult {
  spec: WebsiteSpec;
  digest: PageDigest;
  plan: SitePlan;
  model: string;
  modelTrail: string[];
  assetStats: { downloaded: number; missing: number; unique: number };
  /** Wall-clock breakdown, for the UI. */
  timings: Record<string, number>;
}

export async function synthesizeSpec(input: SynthesizeInput): Promise<SynthesizeResult> {
  const { analysis, publicDir } = input;
  const timings: Record<string, number> = {};
  const page = analysis.page;

  input.onProgress?.("Measuring the design system");
  let t = Date.now();
  const theme = buildTheme(page);
  const digest = buildDigest(page, theme);
  timings.measureMs = Date.now() - t;
  log.info("digest built", {
    sections: digest.sections.length,
    digestChars: JSON.stringify(digest).length,
    mode: theme.mode,
    contrast: contrastReport(theme).ratio,
  });

  input.onProgress?.("Asking the model to classify sections", {
    chars: JSON.stringify(digest).length,
  });
  t = Date.now();
  const planResult = await structured({
    operation: "analyze",
    label: "site-plan",
    system: sitePlanSystem(),
    user: sitePlanUser(digest),
    schema: SitePlanSchema,
    images: visionImages(analysis, input.signal),
    maxOutputTokens: 6000,
    temperature: 0.1,
    signal: input.signal,
    correctionHints: SITE_PLAN_HINTS,
  });
  timings.planMs = Date.now() - t;
  const plan = planResult.data;
  log.info("site plan received", {
    model: planResult.model,
    sections: plan.sections.length,
    attempts: planResult.attempts,
  });

  input.onProgress?.("Downloading assets");
  t = Date.now();
  const fetcher = new AssetFetcher({
    publicDir,
    baseUrl: page.url,
    maxAssets: config().crawl.maxAssets,
  });
  const raw = collectAssets(page);
  const fetched = await fetcher.fetchAll(raw);
  timings.assetMs = Date.now() - t;
  log.info("assets resolved", fetcher.stats);

  // Clamp measured free-text to the spec's field budgets before validating, so
  // an unusually long box-shadow or font stack cannot invalidate a whole run.
  const spec = clampMeasured(
    assemble({ analysis, theme, plan, assets: fetched, model: planResult.model, digest }),
  );

  // The spec is the contract everything downstream trusts, so it is parsed
  // through the schema once here rather than trusted by construction.
  const parsed = WebsiteSpecSchema.safeParse(spec);
  if (!parsed.success) {
    log.error("assembled spec failed validation", {
      issues: parsed.error.issues.slice(0, 10),
    });
    throw new Error(
      `The synthesized specification was invalid: ${parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
    );
  }

  return {
    spec: parsed.data,
    digest,
    plan,
    model: planResult.model,
    modelTrail: planResult.completions.map((c) => c.model),
    assetStats: fetcher.stats,
    timings,
  };
}

// ------------------------------------------------------------------ merge

function assemble(args: {
  analysis: AnalysisResult;
  theme: ReturnType<typeof buildTheme>;
  plan: SitePlan;
  assets: AssetRef[];
  model: string;
  digest: PageDigest;
}): WebsiteSpec {
  const { analysis, theme, plan, assets } = args;
  const page = analysis.page;

  // Asset lookup keyed by URL and by inline-SVG slot, so sections can claim
  // the image they were measured with.
  const byUrl = new Map<string, AssetRef>();
  const bySlot = new Map<string, AssetRef>();
  const queue = [...assets];
  const rawQueue = collectAssets(page);
  rawQueue.forEach((raw, i) => {
    const ref = queue[i];
    if (!ref) return;
    if (raw.url) byUrl.set(raw.url, ref);
    else if (raw.svgName) bySlot.set(raw.svgName, ref);
  });

  const measured = page.sections ?? [];
  const defaultPaddingY = DEFAULT_PADDING_Y(page, theme);

  // Index -> asset, for the first image in a section.
  const sectionAsset = (idx: number, offset = 0): AssetRef | undefined => {
    const s = measured[idx];
    if (!s) return undefined;
    const images: any[] = s.images ?? [];
    if (offset >= images.length) return undefined;
    const img = images[offset];
    if (img.type === "svg" && img.svg) {
      return bySlot.get(`s${idx}-i${offset}-icon.svg`);
    }
    return img.url ? byUrl.get(img.url) : undefined;
  };

  const cardAsset = (sectionIndex: number, itemIndex: number): AssetRef | undefined =>
    bySlot.get(`s${sectionIndex}-c${itemIndex}-icon.svg`) ??
    (() => {
      const s = measured[sectionIndex];
      const item = s?.items?.[itemIndex];
      return item?.image?.url ? byUrl.get(item.image.url) : undefined;
    })();

  const usedIndices = new Set<number>();
  const sections: SectionSpec[] = [];

  plan.sections.forEach((ps, ordinal) => {
    const indices = [ps.from, ...ps.merge].filter(
      (i) => i >= 0 && i < measured.length && !usedIndices.has(i),
    );
    if (!indices.length) return;
    indices.forEach((i) => usedIndices.add(i));
    const primary = measured[ps.from] ?? measured[indices[0]];
    if (!primary) return;

    const style = buildSectionStyle(primary, theme, defaultPaddingY);
    const kind = coerceKind(ps.kind);
    const heading = primary.heading;
    const headingText = ps.heading || heading?.text || "";
    const subText = ps.subheading || primary.subheading?.text || "";

    const items: Item[] = buildItems(ps, primary, indices, cardAsset, theme);

    const cta = pickCta(primary, ps);
    const links = (primary.links ?? [])
      .slice(0, 10)
      .map((l: any) => toLink(l))
      .filter((l: Link) => l.label);

    sections.push({
      id: slugId(kind, ordinal),
      kind,
      name: ps.name || titleCase(kind),
      intent: ps.intent,
      ...(headingText
        ? {
            heading: {
              text: headingText.slice(0, 400),
              level: heading?.level ?? (ordinal === 0 ? 1 : 2),
              align: (heading?.align === "center" ? "center" : "left") as "left" | "center" | "right",
              ...(heading?.fontSize ? { fontSize: heading.fontSize } : {}),
              ...(heading?.fontWeight ? { fontWeight: heading.fontWeight } : {}),
            },
          }
        : {}),
      ...(subText
        ? {
            subheading: {
              text: subText.slice(0, 600),
              level: 0,
              align: (primary.subheading?.align === "center" ? "center" : "left") as "left" | "center",
              ...(primary.subheading?.fontSize ? { fontSize: primary.subheading.fontSize } : {}),
            },
          }
        : {}),
      items,
      links,
      ...(cta ? { cta } : {}),
      ...(() => {
        const media = sectionAsset(ps.from, 0);
        return media && !media.missing ? { media } : media ? { media } : {};
      })(),
      style,
      measuredHeight: primary.height,
      measuredWidth: primary.width,
      order: sections.length,
      lowConfidence: ps.inferred || (kind === "unknown" && items.length === 0 && !headingText),
      sourceTag: primary.tag ?? "",
      sourceSelector: primary.selector ?? "",
    });
  });

  // Any measured section the plan skipped is still rendered, as a generic
  // content block. Dropping it would silently lose real page content.
  for (let i = 0; i < measured.length; i++) {
    if (usedIndices.has(i)) continue;
    const m = measured[i];
    if (m.role === "footer" || m.role === "nav") continue;
    const style = buildSectionStyle(m, theme, defaultPaddingY);
    sections.push({
      id: slugId("unknown", sections.length),
      kind: "unknown",
      name: `Section ${i + 1}`,
      intent: "Kept from the source page; the classifier did not label it.",
      ...(m.heading?.text
        ? {
            heading: {
              text: String(m.heading.text).slice(0, 400),
              level: m.heading.level ?? 2,
              align: "left",
            },
          }
        : {}),
      ...(m.subheading?.text
        ? { subheading: { text: String(m.subheading.text).slice(0, 600), level: 0, align: "left" } }
        : {}),
      items: (m.items ?? []).slice(0, 8).map((it: any) => ({
        title: String(it.title ?? "").slice(0, 200),
        body: String(it.body ?? "").slice(0, 600),
        bullets: (it.bullets ?? []).map((b: string) => String(b).slice(0, 200)),
      })),
      links: [],
      style,
      measuredHeight: m.height,
      measuredWidth: m.width,
      order: sections.length,
      lowConfidence: true,
      sourceTag: m.tag ?? "",
      sourceSelector: m.selector ?? "",
    });
  }

  const mode = plan.theme.mode === "dark" ? "dark" : plan.theme.mode === "light" ? "light" : theme.mode;
  const finalTheme = {
    ...theme,
    mode,
    ...(plan.theme.primary && isHex(plan.theme.primary)
      ? { tokens: { ...theme.tokens, primary: plan.theme.primary } }
      : {}),
  };

  const nav = buildNav(analysis, plan, page.navigation?.brandImage?.url ? byUrl.get(page.navigation.brandImage.url) : undefined);
  const footer = buildFooter(plan, analysis);

  return {
    specVersion: 1,
    meta: {
      sourceUrl: page.url,
      finalUrl: analysis.finalUrl,
      title: plan.site.title || page.title || "Website",
      description: plan.site.description || page.description,
      language: page.language || "en",
      favicon: page.favicon ?? "",
      themeColor: page.themeColor ?? "",
      generator: page.generator ?? "",
    },
    theme: finalTheme,
    nav,
    sections: sections.slice(0, 30),
    footer,
    responsive: {
      observedViewports: analysis.screenshots.map((s) => ({
        name: s.viewport,
        width: s.width,
        height: s.height,
      })),
      mobileReordersNav: true,
      mobileHidesColumns: true,
      containerGutter: 20,
    },
    analysis: {
      summary: plan.site.summary,
      designLanguage: plan.site.designLanguage,
      audience: plan.site.audience,
      warnings: [...(page.warnings ?? []), ...plan.warnings].slice(0, 12),
    },
    stats: {
      model: args.model,
      analyzedAt: new Date().toISOString(),
      durationMs: 0,
      sectionCount: sections.length,
      assetCount: assets.filter((a) => !a.missing).length,
      assetsMissing: assets.filter((a) => a.missing).length,
      modelTrail: [],
    },
  };
}

function buildItems(
  ps: PlanSection,
  measured: any,
  indices: number[],
  cardAsset: (sectionIndex: number, itemIndex: number) => AssetRef | undefined,
  theme: ReturnType<typeof buildTheme>,
): Item[] {
  void theme;

  // Measured content is authoritative; the plan may only *label* it.
  //
  // This used to return the plan's items wholesale whenever the model supplied
  // any, which meant the extracted copy was thrown away and replaced with
  // whatever the model felt like writing. It did: a clone of NASA came out with
  // "Mission overview for the upcoming crew launch" as a body paragraph that
  // appears nowhere on the site. A cloning tool has one non-negotiable job -
  // reproduce the source's content - so the model's structural judgement (what
  // kind of block this is, what to call it, how to group it) is welcome and its
  // prose is not.
  //
  // The plan's items are still used, in the two cases where measurement has
  // nothing to give: a section measured with no repeated group at all, or an
  // individual item the extractor could not title.
  const measuredList: any[] = measured?.items ?? [];
  if (!measuredList.length && ps.items.length) {
    return ps.items.map((it) => ({
      title: it.title,
      body: it.body,
      meta: "",
      price: it.price,
      badge: it.badge,
      bullets: [],
    }));
  }

  const out: Item[] = [];
  for (const idx of indices) {
    const list: any[] = measured?.items ?? [];
    for (let i = 0; i < list.length && out.length < 12; i++) {
      const it = list[i];
      const asset = cardAsset(idx, i);
      // A label from the plan fills a gap the extractor left, and is otherwise
      // ignored - see the note above.
      const label = ps.items[i];
      const title = String(it.title ?? "").trim() || String(label?.title ?? "");
      out.push({
        title: title.slice(0, 200),
        body: String(it.body ?? "").trim() || String(label?.body ?? "").slice(0, 600),
        meta: "",
        price: String(it.price ?? "").trim() || String(label?.price ?? "").slice(0, 40),
        bullets: (it.bullets ?? []).map((b: string) => String(b).slice(0, 200)),
        ...(asset ? { image: asset } : {}),
        ...(it.link
          ? {
              link: {
                label: String(it.link.label ?? ""),
                href: safeHref(String(it.link.href ?? "")),
                primary: false,
                external: /^https?:\/\//i.test(String(it.link.href ?? "")),
              },
            }
          : {}),
        badge: String(it.badge ?? "").trim() || String(label?.badge ?? "").slice(0, 40),
      });
    }
  }
  // Items that carry nothing render as blank cards, and a grid of blank cards is
  // worse than a shorter grid. A plan-supplied label already counts, because it
  // has been merged into the title/body above - supplying one is the model's way
  // of saying the slot is real even though the extractor could not measure it.
  return out.filter((item) =>
    Boolean(item.title || item.body || item.bullets.length || item.image || item.icon || item.link?.label),
  );
}

function pickCta(primary: any, ps: PlanSection): Link | undefined {
  const buttons: any[] = primary.buttons ?? [];
  const first = buttons[0];
  if (first) {
    return {
      label: String(first.label ?? "").slice(0, 60),
      href: safeHref(String(first.href ?? "")),
      primary: true,
      external: !!first.external,
    };
  }
  const link = (primary.links ?? []).find((l: Record<string, unknown>) => l.button);
  if (link) {
    return {
      label: String(link.label ?? "").slice(0, 60),
      href: safeHref(String(link.href ?? "")),
      primary: true,
      external: /^https?:\/\//i.test(String(link.href ?? "")),
    };
  }
  void ps;
  return undefined;
}

function toLink(l: any): Link {
  const href = safeHref(String(l?.href ?? ""));
  return {
    label: String(l?.label ?? "").slice(0, 120),
    href,
    primary: !!l?.button,
    external: /^https?:\/\//i.test(href),
  };
}

function buildNav(
  analysis: AnalysisResult,
  plan: SitePlan,
  logo: AssetRef | undefined,
): WebsiteSpec["nav"] {
  const measured: Record<string, any> | undefined = analysis.page.navigation ?? undefined;
  if (!measured && !plan.nav.links.length) return null;
  const links = plan.nav.links.length
    ? plan.nav.links.map((l: { label: string; href: string; primary: boolean }) => ({
        label: l.label.slice(0, 80),
        href: safeHref(l.href),
        primary: l.primary,
        external: /^https?:\/\//i.test(l.href),
      }))
    : (measured?.links ?? []).slice(0, 10).map((l: unknown) => toLink(l));
  const cta = links.find((l: { primary: boolean }) => l.primary) ?? links[links.length - 1];
  return {
    brand: "",
    brandText: (plan.nav.brandText || measured?.brandText || plan.site.title || "").slice(0, 120),
    ...(logo && !logo.missing ? { logo } : {}),
    links: links.filter((l: { primary: boolean }) => !l.primary || links.length > 1).slice(0, 12),
    ...(cta && cta.primary ? { cta: { ...cta, primary: true } } : {}),
    variant: plan.nav.variant,
    background: measured?.style?.background ?? "transparent",
    sticky: !!measured?.sticky,
    borderBottom:
      measured?.style?.borderBottom && measured.style.borderBottom !== "none"
        ? measured.style.borderBottom
        : "none",
    height: measured?.height ?? 0,
  };
}

function buildFooter(plan: SitePlan, analysis: AnalysisResult): WebsiteSpec["footer"] {
  const measured: Record<string, any> | undefined = analysis.page.footer ?? undefined;
  if (!measured && !plan.footer.columns.length) return null;
  const columns = plan.footer.columns.length
    ? plan.footer.columns.map((c) => ({
        heading: c.heading.slice(0, 80),
        links: c.links.map((l) => ({
          label: l.label.slice(0, 80),
          href: safeHref(l.href),
          primary: false,
          external: /^https?:\/\//i.test(l.href),
        })),
      }))
    : groupFooterLinks(measured);
  return {
    brand: "",
    brandText: (measured?.brandText ?? "").slice(0, 200),
    tagline: (plan.footer.tagline || measured?.tagline || "").slice(0, 400),
    columns: columns.slice(0, 6),
    legal: (measured?.links ?? []).slice(-4).map((l: unknown) => toLink(l)),
    social: [],
    variant: plan.footer.variant,
    background: measured?.style?.background ?? "transparent",
    color: measured?.style?.color ?? "inherit",
    paddingY: Math.max(32, Math.min(120, Math.round((measured?.height ?? 200) / 6))),
    copyright: `© ${new Date().getFullYear()}`,
  };
}

function groupFooterLinks(measured: any): { heading: string; links: Link[] }[] {
  const groups: { heading: string; links: Link[] }[] = [];
  for (const g of measured?.groups ?? []) {
    const links = (g.links ?? []).slice(0, 8).map((l: string) => ({ label: String(l).slice(0, 80), href: "#", primary: false, external: false }));
    if (links.length) groups.push({ heading: String(g.title ?? "").slice(0, 80), links });
  }
  return groups.slice(0, 6);
}

function slugId(kind: string, ordinal: number): string {
  const base = kind === "unknown" ? `section-${ordinal + 1}` : kind;
  return `${base}-${ordinal + 1}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 60);
}

function titleCase(s: string): string {
  return s.replace(/(^|\s)\w/g, (m) => m.toUpperCase());
}

function isHex(v: string): boolean {
  return /^#[0-9a-fA-F]{3,8}$/.test(v);
}

// ------------------------------------------------------------ page layout

/**
 * Ask the model for the page composition, then validate it hard.
 *
 * This step is optional by design: a wrong composition is worse than the
 * deterministic order, so anything that fails validation falls back to the
 * spec's own section order. The model can improve the layout; it can never
 * break it.
 */
export async function composePage(args: {
  spec: WebsiteSpec;
  model: string;
  signal?: AbortSignal;
}): Promise<{ sections: { kind: string; id: string; props: Record<string, unknown> }[]; source: "ai" | "deterministic" }> {
  const list = args.spec.sections.map((s) => ({
    index: s.order,
    kind: s.kind,
    name: s.name,
    height: s.measuredHeight ?? 0,
    heading: (s.heading?.text ?? "").slice(0, 80),
  }));
  const schema = z.object({
    sections: z
      .array(
        z.object({
          kind: z.enum(SECTION_KINDS),
          id: z.string().max(60),
          props: z.record(z.string(), z.unknown()).default({}),
        }),
      )
      .max(40),
  });
  try {
    const res = await structured({
      operation: "generate",
      label: "page-composition",
      system: PAGE_SYSTEM,
      user: pageUser(list),
      schema,
      maxAttempts: 2,
      maxOutputTokens: 2500,
      signal: args.signal,
      correctionHints: PAGE_HINTS,
    });
    // Only accept ids the spec actually contains: the composition reorders and
    // groups, it never invents sections.
    const known = new Set(args.spec.sections.map((s) => s.id));
    const kept = res.data.sections.filter((entry) => known.has(entry.id));
    if (kept.length !== args.spec.sections.length) {
      const seen = new Set(kept.map((s) => s.id));
      for (const s of args.spec.sections) {
        if (!seen.has(s.id)) kept.push({ kind: s.kind, id: s.id, props: {} });
      }
      return { sections: kept, source: "ai" };
    }
    return { sections: kept, source: "ai" };
  } catch (err) {
    log.warn("page composition fell back to the deterministic order", {
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return { sections: deterministicComposition(args.spec), source: "deterministic" };
  }
}

export function deterministicComposition(spec: WebsiteSpec) {
  return spec.sections.map((s) => ({ kind: s.kind, id: s.id, props: {} as Record<string, unknown> }));
}

export interface VisionImageRef {
  path: string;
  mime: "image/png";
  label: string;
}

/**
 * Decide which captured screenshots the vision model sees for the site plan.
 *
 * The fold shot gives the overall layout; the per-section crops are the close
 * "photos" of each measured block. Attaching them makes the multimodal step
 * actually look at the design before anything is generated, bounded by
 * `AI_MAX_SECTION_IMAGES` so a section-heavy page cannot blow the context.
 * Kept a pure selection function so the budget logic is unit-testable.
 */
export function pickVisionImages(args: {
  /** Directory the capture files live in. */
  shotsDir: string;
  /** Fold screenshot file name, when the desktop capture produced one. */
  foldFile?: string;
  /** Captured per-section crops of the desktop view. */
  sectionShots: AnalysisResult["sectionShots"];
  /** How many section crops to attach at most. */
  maxSectionImages: number;
  /** Hard ceiling on total attachments, fold included. */
  maxTotal?: number;
}): VisionImageRef[] {
  const maxTotal = Math.max(0, args.maxTotal ?? 4);
  const out: VisionImageRef[] = [];
  if (args.foldFile) {
    out.push({
      path: path.join(args.shotsDir, args.foldFile),
      mime: "image/png",
      label: "fold: the source site at desktop width",
    });
  }
  const budget = Math.max(0, Math.min(args.maxSectionImages, maxTotal - out.length));
  if (budget > 0 && args.sectionShots.length) {
    // The largest crops carry the most visual information; take those first.
    const crops = [...args.sectionShots]
      .sort((a, b) => b.width * b.height - a.width * a.height)
      .slice(0, budget);
    for (const shot of crops) {
      out.push({
        path: path.join(args.shotsDir, shot.file),
        mime: "image/png",
        label: `section ${shot.index}: desktop crop of the source page`,
      });
    }
  }
  return out;
}

function visionImages(analysis: AnalysisResult, signal?: AbortSignal) {
  void signal;
  if (!config().ai.useVision) return undefined;
  const fold = analysis.screenshots.find((s) => s.viewport === "desktop" && s.foldFile);
  const images = pickVisionImages({
    shotsDir: analysis.screenshotsDir,
    foldFile: fold?.foldFile,
    sectionShots: analysis.sectionShots,
    maxSectionImages: config().ai.maxSectionImages,
  });
  if (images.length === 0) return undefined;
  log.info("vision attached to the site plan", {
    images: images.length,
    sectionCrops: Math.max(0, images.length - (fold?.foldFile ? 1 : 0)),
  });
  return images;
}

export { AssetRefSchema };
