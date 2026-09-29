/**
 * Normalisation: browser output → design tokens + a compact page digest.
 *
 * This is the cost-control centre of the pipeline. The raw extraction can be
 * several hundred kilobytes; the digest handed to the model is a few kilobytes
 * of the facts a decision actually depends on. Everything the model is *not*
 * asked to do stays out of the prompt:
 *
 *   - Colours, fonts, spacing, radii, shadows  → measured here, never asked
 *   - Which blocks are "features" vs "testimonials" → asked
 *   - What the blocks mean and how to name them → asked
 *
 * The generated prompt is also printed by `npm run doctor -- --prompt <url>` so
 * the exact token cost of a run is inspectable.
 */

import { derivePalette, parseColor, toHex, contrastRatio, isDark, mix, type Rgb } from "./color";
import type { ExtractedPage } from "../crawler/extract-script";
import type { ThemeSpec, SectionStyle } from "../spec/schema";

// ------------------------------------------------------------------ theme

/**
 * Build the design-token set straight from the measurements.
 *
 * The model is consulted later only to confirm the light/dark reading and the
 * brand intent; if it disagrees, the measured tokens still win, because they
 * came from computed styles rather than from a description.
 */
export function buildTheme(page: ExtractedPage): ThemeSpec {
  const d = page.design;
  const palette = derivePalette({
    bodyBackground: d.bodyBackground,
    bodyColor: d.bodyColor,
    backgroundCandidates: (d.backgroundCandidates ?? []).filter(
      (c: string) => !/gradient/i.test(c),
    ),
    colorCandidates: d.colorCandidates ?? [],
    brandFills: d.brandFills ?? [],
    brandInks: d.brandInks ?? [],
    themeColorMeta: d.themeColorMeta || "",
  });

  const headings = d.headings ?? {};
  const h1 = headings.h1;
  const h2 = headings.h2;
  const p = headings.p;
  const bodySize = d.bodyFontSize || 16;

  const headingFamily = h1?.fontFamily || h2?.fontFamily || d.bodyFont;
  /**
   * The display size, in order of trust.
   *
   * `h1` first, then the largest *observed* size on the page. A page with no
   * `<h1>` at all is common (NASA's homepage has none), and falling straight
   * back to `h2` made an 18px sub-heading the site's biggest type, which
   * flattened the whole hierarchy. The size-frequency list is the better
   * signal: it is the largest size the author actually rendered.
   */
  const observedSizes: number[] = (d.sizeCandidates as unknown[] ?? [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > bodySize * 1.15 && n <= 140);
  const headingSize =
    h1?.fontSize ||
    (observedSizes.length ? Math.max(...observedSizes) : undefined) ||
    h2?.fontSize ||
    Math.round(bodySize * 2.6);
  const headingWeight = h1?.fontWeight || h2?.fontWeight || 700;

  // The type scale is read from the page's own heading elements rather than
  // invented, so a 96px display hero stays 96px.
  const sizes = [h1?.fontSize, h2?.fontSize, headings.h3?.fontSize, headings.h4?.fontSize, p?.fontSize]
    .filter((n): n is number => typeof n === "number" && n > 0)
    .sort((a, b) => b - a);

  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

  /**
   * A CSS `line-height` is a ratio, so a measured ratio is used as-is.
   *
   * This used to be `clamp(fontSize * ratio, 0.9, 2.4)`, which multiplied a
   * 16px size by a 1.2 ratio and clamped the product to the 2.4 ceiling - so
   * *every* heading and paragraph on the site came out with `line-height: 2.4`,
   * roughly double the intended leading. The product is only meaningful when
   * converting an absolute `line-height: 19px` to a ratio, which is what
   * `toLineHeightRatio` handles at the point of measurement.
   */
  const leading = (ratio: number | undefined, fallback: number) =>
    Math.max(0.9, Math.min(1.9, Math.round((ratio ?? fallback) * 100) / 100));

  const radius = pickRadius(d.radiusCandidates ?? []);
  const shadow = pickShadow(d.shadowCandidates ?? [], palette.mode);
  const borderWidth = (d.borderCandidates?.[0] ?? "1px").split(/\s+/)[0] || "1px";

  return {
    mode: palette.mode,
    tokens: {
      background: palette.background,
      surface: palette.surface,
      surfaceAlt: palette.surfaceAlt,
      text: palette.text,
      textMuted: palette.textMuted,
      primary: palette.primary,
      onPrimary: palette.onPrimary,
      border: palette.border,
      accent: palette.accent,
    },
    fonts: {
      heading: {
        family: headingFamily,
        size: clamp(headingSize, 14, 120),
        weight: headingWeight,
        lineHeight: leading(h1?.lineHeight ?? h2?.lineHeight, 1.15),
        letterSpacing: h1?.letterSpacing || h2?.letterSpacing || "normal",
        transform: h1?.textTransform === "uppercase" ? "uppercase" : "none",
        italic: false,
      },
      body: {
        family: d.bodyFont,
        size: clamp(bodySize, 12, 24),
        weight: 400,
        lineHeight: leading(p?.lineHeight, 1.6),
        letterSpacing: "normal",
        transform: "none",
        italic: false,
      },
    },
    radius,
    shadow,
    containerWidth: clamp(d.containerWidth || 1200, 320, 2400),
    baseFontSize: clamp(bodySize, 12, 24),
    headingWeight: headingWeight,
    borderWidth,
    provenance: { tokens: "measured", fonts: "measured", radius: "measured" },
  };
}

/**
 * Corner radii, from the measurements.
 *
 * When a site uses several radii the nearest observed value to each step of the
 * scale is used, so a 2px/6px/14px design comes back as itself. When it uses
 * only one - common, and honest to report - that value is used for every step
 * rather than inventing a ramp from nothing: a flat 4px scale is what the
 * source actually looks like, and pretending otherwise would be a fabrication.
 * `pill` is the one exception, since a genuinely round control is detectable.
 */
function pickRadius(candidates: string[]): ThemeSpec["radius"] {
  const values = Array.from(
    new Set(
      candidates
        .map(parseCssPixels)
        .filter((n): n is number => n !== null && n > 0)
        .map((n) => Math.round(n)),
    ),
  ).sort((a, b) => a - b);
  const pill = values.some((v) => v >= 999);
  const asPx = (n: number) => `${clampNum(n, 0, 999, 0)}px`;
  const only = values.length === 1 ? values[0] : undefined;

  // Zero is excluded from the scale above, because a scale step of 0 is not a
  // step. But when *every* observed radius is zero the site is deliberately
  // square-cornered, and falling through to the 4/8/16 defaults gave it rounded
  // corners it does not have - a visible difference on a design-led site. An
  // empty candidate list stays on the defaults, because that means "nothing on
  // this page has a radius" rather than "everything here is square".
  const parsedAll = candidates.map(parseCssPixels).filter((n): n is number => n !== null);
  if (values.length === 0 && parsedAll.length > 0 && parsedAll.every((n) => n === 0)) {
    return { sm: "0px", md: "0px", lg: "0px", pill: "0px" };
  }

  return {
    sm: only !== undefined ? asPx(only) : nearest(values, 4, "4px"),
    md: only !== undefined ? asPx(only) : nearest(values, 8, "8px"),
    lg: only !== undefined ? asPx(only) : nearest(values, 16, "16px"),
    pill: pill ? "9999px" : only !== undefined ? asPx(only * 4) : nearest(values, 24, "9999px"),
  };
}

/**
 * Shadows, from the measurements.
 *
 * Real `box-shadow` values are frequently longer than the spec's field budget —
 * layered shadows, long `rgba()` lists, and multi-layer Tailwind ring
 * definitions all blow past 160 characters. Rather than let a measured value
 * invalidate the whole spec, keep only what fits and synthesise a single-layer
 * shadow from the first one otherwise. The value is decorative, so a clean
 * approximation beats a rejected spec.
 */
function pickShadow(candidates: string[], mode: "light" | "dark"): ThemeSpec["shadow"] {
  const SM = 160;
  const LG = 200;
  const fits = (c: string, max: number) => c && c !== "none" && c.length <= max;
  const simplify = (c: string): string => {
    // Keep the first layer of a multi-layer shadow, then re-fit.
    const first = c.split(/,(?![^(]*\))/)[0]?.trim() ?? c;
    if (fits(first, LG)) return first;
    // Last resort: a plain two-part shadow derived from whatever blur it had.
    const blur = c.match(/0\s+(\d+)px\s+(\d+)px/);
    return blur ? `0 ${blur[1]}px ${blur[2]}px rgba(0,0,0,0.12)` : defaultShadow(mode).md;
  };

  const usable = candidates.filter((c) => c && c !== "none");
  if (usable.length) {
    // The most-used shadow becomes the middle of the scale, and its blur and
    // spread are scaled up and down to produce the other two steps. Returning
    // one value for all three - the previous behaviour - made `shadow-lg`
    // indistinguishable from `shadow-sm` in the emitted CSS, so every card in
    // the clone looked identically flat.
    const md = simplify(usable[0]);
    const scale = (c: string, k: number, max: number): string => {
      if (!fits(c, max)) return simplify(defaultShadow(mode)[k === 0.5 ? "sm" : k > 1 ? "lg" : "md"]);
      const withNumbers = c.replace(
        /(-?[\d.]+)px(\s+-?[\d.]+px)?/g,
        (_m, a: string, b: string) =>
          `${Math.round(parseFloat(a) * k)}px${b ? ` ${Math.round(parseFloat(b) * k)}px` : ""}`,
      );
      return fits(withNumbers, max) ? withNumbers : c;
    };
    return { sm: scale(md, 0.5, SM), md, lg: scale(md, 2, LG) };
  }
  return defaultShadow(mode);
}

function defaultShadow(mode: "light" | "dark"): ThemeSpec["shadow"] {
  const a = mode === "dark" ? 0.4 : 0.1;
  return {
    sm: `0 1px 2px rgba(0,0,0,${a})`,
    md: `0 6px 16px rgba(0,0,0,${a + 0.04})`,
    lg: `0 20px 48px rgba(0,0,0,${a + 0.08})`,
  };
}

function parseCssPixels(value: string): number | null {
  const m = value.match(/([\d.]+)px/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Nearest candidate to a target, or the fallback when there are none. */
function nearest(values: number[], target: number, fallback: string): string {
  if (!values.length) return fallback;
  const best = values.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
  return `${Math.round(best)}px`;
}

// ----------------------------------------------------------------- sections

/** Section padding, alignment and column count, all measured. */
export function buildSectionStyle(raw: any, theme: ThemeSpec, fallbackPaddingY: number): SectionStyle {
  const style = raw?.style ?? {};
  const items: any[] = Array.isArray(raw?.items) ? raw.items : [];
  const columns = inferColumns(items, style);
  const align = raw?.heading?.align === "center" || style.align === "center" ? "center" : "left";
  const paddingY = clampNum(style.paddingY, 24, 200, fallbackPaddingY);
  const width = raw?.width || 1440;
  const side = columns >= 2 && (raw?.images?.length ?? 0) > 0 && (raw?.paragraphs?.length ?? 0) <= 2
    ? "side"
    : "stack";
  return {
    background: normaliseBackground(style.background, theme),
    color: style.color && style.color !== "rgba(0, 0, 0, 0)" ? style.color : "inherit",
    paddingY,
    paddingX: clampNum(style.paddingX, 8, 96, 20),
    maxWidth: style.maxWidth > 320 ? clampNum(style.maxWidth, 320, 2000, 0) || undefined : undefined,
    align,
    columns,
    gap: clampNum(style.gap, 0, 96, 24),
    split: side,
    side: raw?.images?.length ? "media-first" : "text-first",
    borderTop: style.borderTop && style.borderTop !== "none" ? style.borderTop : "none",
    radius: "0px",
  };
  void width;
}

function normaliseBackground(raw: string | undefined, theme: ThemeSpec): string {
  if (!raw || raw === "transparent") return "transparent";
  if (/gradient/i.test(raw)) return raw.slice(0, 400);
  if (raw === "rgba(0, 0, 0, 0)") return "transparent";
  return raw;
}

/**
 * Column count for a repeated group of items, from their geometry.
 *
 * The extract script does not return each item's x position, so this uses the
 * measured card width against the section width: three cards across a 1200px
 * container are 3 columns. Narrow cards on a wide section mean more columns;
 * a single card wider than 80% of the container means one.
 */
function inferColumns(items: any[], style: any): number {
  if (items.length < 2) return 1;
  const widths = items
    .map((i) => Number(i?.width) || 0)
    .filter((w) => w > 40);
  if (!widths.length) return items.length >= 4 ? 4 : 2;
  const median = widths.sort((a, b) => a - b)[Math.floor(widths.length / 2)];
  const container = Number(style?.maxWidth) || 1200;
  const perRow = Math.max(1, Math.round(container / (median + 32)));
  return Math.max(1, Math.min(6, perRow));
}

function clampNum(value: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

// ------------------------------------------------------------------- digest

export interface SectionDigest {
  index: number;
  tag: string;
  role: string;
  height: number;
  /** Background colour, or "gradient" when a background image is set. */
  bg: string;
  heading?: { level: number; text: string; size: number; align: string };
  body?: string;
  /** Up to 3 example item titles, to hint at what a repeated group means. */
  itemTitles: string[];
  itemCount: number;
  /** Prices / bullet counts, so pricing and feature grids can be told apart. */
  priceHints: string[];
  linkLabels: string[];
  imageCount: number;
  hasTable: boolean;
  hasForm: boolean;
  hasVideo: boolean;
}

export interface PageDigest {
  url: string;
  title: string;
  description: string;
  generator: string;
  language: string;
  mode: "light" | "dark";
  palette: Record<string, string>;
  typeScale: string;
  containerWidth: number;
  fontNames: string[];
  nav: { brand: string; links: string[]; height: number } | null;
  footer: { linkCount: number; headings: string[] } | null;
  sections: SectionDigest[];
  assetCandidates: number;
  warnings: string[];
  counts: Record<string, number>;
}

/**
 * Reduce the extraction to what a section-classification decision needs.
 *
 * Every string is truncated hard. A 40-section page lands around 4–6 KB of
 * JSON, which fits comfortably in a cheap model's context alongside the output
 * contract — the reason this pipeline can afford to use free models at all.
 */
export function buildDigest(page: ExtractedPage, theme: ThemeSpec): PageDigest {
  const sections: SectionDigest[] = (page.sections ?? []).map((s: any) => {
    const heading = s.heading
      ? {
          level: s.heading.level,
          text: clip(s.heading.text, 140),
          size: s.heading.fontSize,
          align: s.heading.align,
        }
      : undefined;
    const items: any[] = Array.isArray(s.items) ? s.items : [];
    return {
      index: s.index,
      tag: s.tag,
      role: s.role,
      height: s.height,
      bg: /gradient/i.test(s.style?.background ?? "") ? "gradient" : (s.style?.background ?? ""),
      ...(heading ? { heading } : {}),
      ...(s.subheading?.text ? { body: clip(s.subheading.text, 220) } : {}),
      itemTitles: items.slice(0, 3).map((i) => clip(i.title || i.body, 60)).filter(Boolean),
      itemCount: items.length,
      priceHints: items.map((i) => i.price).filter(Boolean).slice(0, 3),
      linkLabels: (s.links ?? []).slice(0, 8).map((l: any) => clip(l.label, 32)).filter(Boolean),
      imageCount: (s.images ?? []).length,
      hasTable: !!s.tables,
      hasForm: (s.forms ?? []).length > 0,
      hasVideo: !!s.hasVideo,
    };
  });

  const d = page.design;
  return {
    url: page.url,
    title: clip(page.title, 200),
    description: clip(page.description, 240),
    generator: clip(page.generator, 80),
    language: page.language || "en",
    mode: theme.mode,
    palette: theme.tokens,
    typeScale: `${theme.fonts.heading.family.split(",")[0]} ${theme.fonts.heading.size}px/${theme.fonts.heading.lineHeight} w${theme.fonts.heading.weight} · body ${theme.fonts.body.family.split(",")[0]} ${theme.fonts.body.size}px/${theme.fonts.body.lineHeight}`,
    containerWidth: theme.containerWidth,
    fontNames: (d.fontFamilyNames ?? []).slice(0, 3),
    nav: page.navigation
      ? {
          brand: clip(page.navigation.brandText, 40),
          links: (page.navigation.links ?? []).slice(0, 10).map((l: any) => clip(l.label, 28)),
          height: page.navigation.height,
        }
      : null,
    footer: page.footer
      ? {
          linkCount: (page.footer.links ?? []).length,
          headings: (page.footer.headings ?? []).map((h: any) => clip(h.text, 40)).filter(Boolean).slice(0, 6),
        }
      : null,
    sections,
    assetCandidates: countAssets(page),
    warnings: page.warnings ?? [],
    counts: page.counts as unknown as Record<string, number>,
  };
}

function countAssets(page: ExtractedPage): number {
  let n = page.sections?.reduce((acc, s: any) => acc + ((s.images ?? []).length as number), 0) ?? 0;
  if (page.navigation?.brandImage) n++;
  return n;
}

function clip(s: unknown, max: number): string {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// ------------------------------------------------------------------- assets

export interface RawAssetCandidate {
  url: string;
  alt?: string;
  width?: number;
  height?: number;
  kind?: "image" | "svg" | "video" | "icon";
  svg?: string;
  svgName?: string;
  /** Higher wins. Hero images are fetched before card thumbnails. */
  priority: number;
}

/**
 * Flatten every image the extractor saw into a download queue, de-duplicated,
 * ordered by how much it matters to the layout.
 */
export function collectAssets(page: ExtractedPage): RawAssetCandidate[] {
  const out = new Map<string, RawAssetCandidate>();
  const add = (c: RawAssetCandidate) => {
    if (!c.url && !c.svg) return;
    const key = c.url || `inline:${c.svgName ?? c.svg!.length}`;
    const existing = out.get(key);
    if (existing) {
      existing.priority = Math.max(existing.priority, c.priority);
      existing.alt = existing.alt || c.alt;
      return;
    }
    out.set(key, c);
  };

  if (page.navigation?.brandImage?.url) {
    add({ url: page.navigation.brandImage.url, alt: "logo", kind: "image", priority: 100 });
  }

  page.sections?.forEach((s: any, si: number) => {
    const isFirst = si === 0;
    (s.images ?? []).forEach((img: any, ii: number) => {
      if (img.type === "svg" && img.svg) {
        add({
          url: "",
          svg: img.svg,
          svgName: `s${si}-i${ii}-icon.svg`,
          alt: img.alt,
          width: img.width,
          height: img.height,
          kind: "svg",
          priority: (isFirst ? 50 : 30) - ii,
        });
        return;
      }
      if (!img.url) return;
      add({
        url: img.url,
        alt: img.alt,
        width: img.width,
        height: img.height,
        kind: img.type === "video" ? "video" : img.isSvg ? "svg" : "image",
        priority: (isFirst ? 50 : 30) - ii + (img.width > 480 ? 10 : 0),
      });
    });
    // Card imagery, after the section's own images.
    (s.items ?? []).slice(0, 8).forEach((item: any, ii: number) => {
      if (item.image?.url) {
        add({
          url: item.image.url,
          alt: item.image.alt || item.title,
          width: item.image.width,
          height: item.image.height,
          kind: "image",
          priority: 20 - ii,
        });
      }
      if (item.iconSvg) {
        add({
          url: "",
          svg: item.iconSvg,
          svgName: `s${si}-c${ii}-icon.svg`,
          alt: item.title,
          width: 48,
          height: 48,
          kind: "svg",
          priority: 18 - ii,
        });
      }
    });
  });

  return Array.from(out.values()).sort((a, b) => b.priority - a.priority);
}

// ------------------------------------------------------------------ helpers

/** Human-readable contrast report, surfaced in the UI as an accessibility hint. */
export function contrastReport(theme: ThemeSpec): { ratio: number; passes: boolean } {
  const bg = parseColor(theme.tokens.background) ?? { r: 255, g: 255, b: 255, a: 1 };
  const fg = parseColor(theme.tokens.text) ?? { r: 0, g: 0, b: 0, a: 1 };
  const ratio = contrastRatio(fg, bg);
  return { ratio: Math.round(ratio * 100) / 100, passes: ratio >= 4.5 };
}

export function textOn(background: string, candidates: string[] = ["#ffffff", "#000000"]): string {
  const bg = parseColor(background);
  if (!bg) return candidates[0];
  let best = candidates[0];
  let bestRatio = -1;
  for (const c of candidates) {
    const parsed = parseColor(c);
    if (!parsed) continue;
    const ratio = contrastRatio(parsed, bg);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = c;
    }
  }
  return best;
}

export function subtleBorder(token: string): string {
  const c = parseColor(token) ?? { r: 128, g: 128, b: 128, a: 1 };
  const target: Rgb = isDark(c) ? mix(c, { r: 255, g: 255, b: 255, a: 1 }, 0.18) : mix(c, { r: 0, g: 0, b: 0, a: 1 }, 0.12);
  return toHex(target);
}
