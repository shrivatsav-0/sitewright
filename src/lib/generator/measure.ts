/**
 * Proportion helpers.
 *
 * The single highest-leverage thing the generator can get right is *rhythm*:
 * a section that measured 420px tall should not come out 900px tall, and the
 * gap between a heading and its body should match the source. These helpers
 * convert measured heights into the padding and type sizes the renderer uses,
 * so fidelity comes from arithmetic rather than from the model guessing.
 */

import type { ExtractedPage } from "../crawler/extract-script";
import type { ThemeSpec } from "../spec/schema";

/** Typical vertical padding when a section did not report a usable value. */
export function DEFAULT_PADDING_Y(page: ExtractedPage, theme: ThemeSpec): number {
  const candidates = ((page.design as { paddingCandidates?: unknown[] })?.paddingCandidates ?? [])
    .map((n: unknown) => Number(n))
    .filter((n: number) => Number.isFinite(n) && n >= 32 && n <= 180);
  if (candidates.length) {
    return Math.round(candidates.reduce((a, b) => a + b, 0) / candidates.length);
  }
  return theme.baseFontSize >= 18 ? 96 : 72;
}

/**
 * Scale a measured height into a padding value, for sections that have a
 * heading and no visual media to fill the space.
 *
 * The mapping is deliberately conservative: roughly a third of a tall section
 * becomes padding, capped at 140px, because over-padding reads as "wrong" far
 * more readily than under-padding reads as "fine".
 */
export function paddingFromHeight(heightPx: number, base: number): number {
  const target = Math.round(heightPx * 0.32);
  return Math.max(24, Math.min(140, target || base));
}

/**
 * Hero headings are the largest text on a page. Derive the hero size from the
 * measured hero height rather than a fixed scale, so a full-bleed 900px hero
 * gets large type and a compact 380px banner does not.
 */
export function heroFontSize(heroHeightPx: number, theme: ThemeSpec): number {
  const h = Math.max(280, heroHeightPx || 560);
  const fromHeight = Math.round(h * 0.075);
  const capped = Math.max(28, Math.min(76, fromHeight));
  // Respect the source's own type scale when it is already in that range.
  const measured = theme.fonts.heading.size;
  if (measured >= 28 && measured <= 76) return measured;
  return Math.max(measured, Math.min(76, capped));
}

/**
 * Column count for a card grid at a given breakpoint, so a 3-across desktop
 * grid does not become 3 narrow columns on a phone.
 */
export function responsiveColumns(desktop: number, width: number): number {
  if (width >= 1024) return Math.min(desktop, 6);
  if (width >= 768) return Math.min(desktop, 3);
  if (width >= 480) return Math.min(desktop, 2);
  return 1;
}

/**
 * A rough per-section height budget, used to sanity-check a generated build
 * against the source rather than to lay it out.
 */
export function expectedPageHeight(page: ExtractedPage): number {
  return (page.sections ?? []).reduce((acc: number, s: any) => acc + (Number(s?.height) || 0), 0);
}

export function heightDeltaRatio(actual: number, expected: number): number {
  if (!expected) return 0;
  return (actual - expected) / expected;
}
