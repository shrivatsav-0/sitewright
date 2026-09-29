/**
 * Colour maths and token derivation.
 *
 * The browser hands back whatever CSS the site used — `rgb()`, `rgba()`,
 * `oklch()`, `color-mix()`, gradients, `transparent`. To reason about contrast
 * and to derive a coherent palette we need actual numbers, so this module
 * parses what it can and degrades gracefully for the rest.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  transparent: "#00000000",
};

export function parseColor(input: string | undefined | null): Rgb | null {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();
  if (NAMED[s]) return parseColor(NAMED[s]);

  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      const a = hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : 1;
      if ([r, g, b].every(Number.isFinite)) return { r, g, b, a };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      if ([r, g, b].every(Number.isFinite)) return { r, g, b, a };
    }
    return null;
  }

  const fn = s.match(/^(rgba?|hsla?)\(([^)]+)\)$/);
  if (fn) {
    const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
    if (fn[1].startsWith("rgb")) {
      const num = (v: string, scale: number) => {
        const n = v.endsWith("%") ? (parseFloat(v) / 100) * scale : parseFloat(v);
        return Number.isFinite(n) ? n : 0;
      };
      const a = parts[3] !== undefined ? (parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
      return {
        r: Math.round(num(parts[0], 255)),
        g: Math.round(num(parts[1], 255)),
        b: Math.round(num(parts[2], 255)),
        a: Number.isFinite(a) ? a : 1,
      };
    }
    const h = parseFloat(parts[0]) || 0;
    const sat = (parseFloat(parts[1]) || 0) / 100;
    const l = (parseFloat(parts[2]) || 0) / 100;
    const a = parts[3] !== undefined ? (parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
    const rgb = hslToRgb(h, sat, l);
    return { ...rgb, a: Number.isFinite(a) ? a : 1 };
  }

  if (s.startsWith("oklch(")) {
    const nums = s
      .slice(6, -1)
      .split(/[\s,/]+/)
      .map((t) => t.replace(/[a-z%]+/gi, ""));
    const l = parseFloat(nums[0]);
    if (Number.isFinite(l)) {
      // Preserve hue/chroma intent without a full oklab implementation:
      // lightness alone is enough to place the colour on the right side of
      // the light/dark decision, which is all we use it for.
      const grey = Math.round(Math.max(0, Math.min(1, l)) * 255);
      return { r: grey, g: grey, b: grey, a: 1 };
    }
  }
  return null;
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (hue < 60) [rp, gp, bp] = [c, x, 0];
  else if (hue < 120) [rp, gp, bp] = [x, c, 0];
  else if (hue < 180) [rp, gp, bp] = [0, c, x];
  else if (hue < 240) [rp, gp, bp] = [0, x, c];
  else if (hue < 300) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  return {
    r: Math.round((rp + m) * 255),
    g: Math.round((gp + m) * 255),
    b: Math.round((bp + m) * 255),
    a: 1,
  };
}

export function toHex(c: Rgb): string {
  const p = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${p(c.r)}${p(c.g)}${p(c.b)}`;
}

export function toRgbString(c: Rgb): string {
  if (c.a >= 1) return toHex(c);
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${Number(c.a.toFixed(3))})`;
}

export function luminance(c: Rgb): number {
  const f = (v: number) => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

export function isDark(c: Rgb): boolean {
  return luminance(c) < 0.4;
}

/** Composite a possibly-translucent colour over an opaque backdrop. */
export function flatten(fg: Rgb, bg: Rgb): Rgb {
  if (fg.a >= 1) return fg;
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
    a: 1,
  };
}

/** Nudge a colour until it is readable on `bg`, preserving its hue. */
export function ensureContrast(fg: Rgb, bg: Rgb, target = 4.5): Rgb {
  const bgDark = isDark(bg);
  let best = fg;
  let bestRatio = contrastRatio(fg, bg);
  if (bestRatio >= target) return fg;
  for (let i = 1; i <= 10; i++) {
    const t = i / 10;
    const candidate = bgDark ? mix(fg, { r: 255, g: 255, b: 255, a: 1 }, t) : mix(fg, { r: 0, g: 0, b: 0, a: 1 }, t);
    const ratio = contrastRatio(candidate, bg);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = candidate;
    }
    if (ratio >= target) return candidate;
  }
  return best;
}

/**
 * Derive a small, coherent palette from a site's observed colours.
 * Deterministic and cheap: this runs on every analysis, so it must not need a
 * model call.
 */
export interface DerivedPalette {
  background: string;
  surface: string;
  surfaceAlt: string;
  text: string;
  textMuted: string;
  primary: string;
  onPrimary: string;
  border: string;
  accent: string;
  mode: "light" | "dark";
}

export function derivePalette(input: {
  bodyBackground: string;
  bodyColor: string;
  backgroundCandidates: string[];
  colorCandidates: string[];
  /** Colours the site uses as fills on its own chrome. Strongest brand signal. */
  brandFills?: string[];
  /** Colours the site uses as ink on its own chrome. Weaker: unstyled links. */
  brandInks?: string[];
  /** `<meta name="theme-color">`, when the site declared one. */
  themeColorMeta?: string;
}): DerivedPalette {
  const bg = parseColor(input.bodyBackground) ?? { r: 255, g: 255, b: 255, a: 1 };
  const mode: "light" | "dark" = isDark(bg) ? "dark" : "light";
  const text = parseColor(input.bodyColor) ?? (mode === "dark" ? { r: 245, g: 245, b: 245, a: 1 } : { r: 17, g: 17, b: 17, a: 1 });

  // Surfaces.
  //
  // A "surface" is the tint behind cards and panels, which by definition sits
  // *close* to the page background - a few percent darker, not a different
  // colour altogether. Taking the most frequent background regardless of how
  // far it was from the page background put `#000000` behind every card on a
  // white page, because black is a very common background on any site with
  // dark hero sections. So candidates are ranked by how near they sit to the
  // page background, and anything too far away is treated as a *section*
  // colour (handled separately) rather than a surface.
  const surfaceObserved = input.backgroundCandidates
    .map((c) => parseColor(c))
    .filter((c): c is Rgb => !!c && c.a > 0.4)
    .filter((c) => contrastRatio(c, bg) < 1.6);
  const nearBg = (c: Rgb) => Math.abs(luminance(c) - luminance(bg));
  const surfaceCandidates = surfaceObserved
    .slice()
    .sort((a, b) => Math.abs(nearBg(a) - 0.03) - Math.abs(nearBg(b) - 0.03));
  const surface = pick(
    surfaceCandidates,
    mode === "dark" ? mix(bg, { r: 255, g: 255, b: 255, a: 1 }, 0.07) : mix(bg, { r: 0, g: 0, b: 0, a: 1 }, 0.04),
  );
  const surfaceAltCandidates = surfaceCandidates.filter((c) => toHex(c) !== toHex(surface));
  const surfaceAlt = pick(
    surfaceAltCandidates,
    mode === "dark" ? mix(bg, { r: 255, g: 255, b: 255, a: 1 }, 0.13) : mix(bg, { r: 0, g: 0, b: 0, a: 1 }, 0.08),
  );

  const textMuted = mix(text, bg, 0.32);
  const border = mix(text, bg, 0.82);

  // Primary, resolved in descending order of trust.
  //
  // This ordering is the whole reason a clone comes out the right colour. A
  // plain "most chromatic colour on the page" search is dominated by the
  // browser's own default link blue - pure #0000ee has the maximum possible
  // chroma and appears on every link the author forgot to style, so it beat
  // even a real brand red. Order matters: an author's declared `theme-color`,
  // then a fill on their own buttons and nav, then an ink on that chrome, and
  // only then the general colour soup.
  const general = [...input.backgroundCandidates, ...input.colorCandidates];
  const primary =
    parseColor(input.themeColorMeta) ??
    pickChroma(input.brandFills ?? [], bg, text) ??
    pickChroma(input.brandInks ?? [], bg, text, undefined, true) ??
    pickChroma(general, bg, text) ??
    DEFAULT_PRIMARY;
  const onPrimary =
    contrastRatio(primary, bg) < 0.3 ? pickReadableOn(primary) : toHex(readableOn(primary));

  //
  // The accent is the one colour that sits *beside* the primary as a deliberate
  // second brand colour, so the browser's own defaults are removed from the
  // general pool rather than merely penalised. Scoring alone was not enough:
  // #0000ee has the maximum possible chroma, so on a page whose only other
  // colour is unstyled links it still won, and a site with a real brand red got
  // a browser-blue accent beside it. The primary keeps the penalised pool,
  // because for a page with no brand signal at all its links really are the
  // only chromatic thing it paints.
  const generalForAccent = general.filter((c) => {
    const parsed = parseColor(c);
    return !parsed || !UA_DEFAULTS.has(toHex(parsed));
  });
  const accent =
    pickChroma(input.brandFills ?? [], bg, text, primary) ??
    pickChroma(input.brandInks ?? [], bg, text, primary, true) ??
    pickChroma(generalForAccent, bg, text, primary) ??
    // Nothing else chromatic on the page: derive a companion hue from the
    // primary rather than reaching for a fixed blue. It stays related to the
    // measured brand colour instead of importing an unrelated one.
    shiftHue(primary, 42);

  return {
    background: toHex(bg),
    surface: toHex(surface),
    surfaceAlt: toHex(surfaceAlt),
    text: toHex(ensureContrast(text, bg, 6)),
    textMuted: toHex(ensureContrast(textMuted, bg, 3.4)),
    primary: toHex(primary),
    onPrimary: onPrimary,
    border: toHex(border),
    accent: toHex(accent),
    mode,
  };
}

function pick(list: Rgb[], fallback: Rgb): Rgb {
  return list.length ? list[0] : fallback;
}

function rgbToHsl(c: Rgb): [number, number, number] {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return [h, sat, l];
}

function chroma(c: Rgb): number {
  return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
}

function readableOn(c: Rgb): Rgb {
  const white = { r: 255, g: 255, b: 255, a: 1 };
  const black = { r: 0, g: 0, b: 0, a: 1 };
  return contrastRatio(c, white) >= contrastRatio(c, black) ? white : black;
}

function pickReadableOn(c: Rgb): string {
  return toHex(readableOn(c));
}

/**
 * Choose the most likely brand colour: saturated, reasonably bright, and
 * distinguishable from the page background and body text.
 */
/** Last-resort brand colour, used only when the page declares none. */
const DEFAULT_PRIMARY: Rgb = { r: 37, g: 99, b: 235, a: 1 };

/** Rotate a colour's hue by `deg`, preserving saturation and lightness. */
/**
 * Rotate a colour's hue, preserving saturation and lightness.
 *
 * Used to derive an accent from a measured primary when the page has only one
 * brand colour. Exported because the relationship "the accent is a ~42 degree
 * rotation of the primary" is a real invariant worth testing, and testing it
 * needs this function.
 */
export function shiftHue(c: Rgb, deg: number): Rgb {
  const [h, sat, l] = rgbToHsl(c);
  return { ...hslToRgb((h + deg + 360) % 360, sat, l), a: c.a };
}

/**
 * Colours the browser picks on its own. A site that never chose them has not
 * expressed a brand, so they are demoted rather than banned: a genuinely blue
 * site still comes out blue, just not by accident.
 */
const UA_DEFAULTS = new Set(["#0000ee", "#0000ff", "#551a8b", "#a0a0a0", "#ee0000"]);

/**
 * Choose the most likely brand colour, or `null` when nothing qualifies so the
 * caller can fall through to the next, weaker source.
 *
 * @param penaliseUaDefaults demote the browser's own link colours. Only correct
 *   for *ink* observations - a site whose buttons are filled with its brand
 *   blue really does mean it.
 */
function pickChroma(
  candidates: string[],
  bg: Rgb,
  text: Rgb,
  avoid?: Rgb,
  penaliseUaDefaults = false,
): Rgb | null {
  const parsed = candidates
    .map((c) => parseColor(c))
    .filter((c): c is Rgb => !!c && c.a > 0.5)
    .filter((c) => chroma(c) > 24)
    .filter((c) => toHex(c) !== toHex(avoid ?? { r: -1, g: -1, b: -1, a: 1 }))
    .filter((c) => {
      // Reject near-background and near-text values; they are not brand colours.
      if (contrastRatio(c, bg) < 1.15) return false;
      if (contrastRatio(c, text) < 1.15) return false;
      return true;
    });
  if (!parsed.length) return null;
  const scored = parsed
    .map((c) => {
      const sat = chroma(c) / 255;
      const midTone = 1 - Math.abs(luminance(c) - 0.42) * 1.6;
      const distinct = Math.min(contrastRatio(c, bg), contrastRatio(c, text)) / 21;
      const ua = penaliseUaDefaults && UA_DEFAULTS.has(toHex(c)) ? -1.4 : 0;
      return { c, score: sat * 2.2 + midTone * 1.1 + distinct * 0.8 + ua };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0].c;
}
