/**
 * Theme emission: WebsiteSpec design tokens → a Tailwind v4 stylesheet.
 *
 * The generated project gets a real design system rather than a bag of inline
 * styles: tokens become `@theme` custom properties, so components can be
 * written with ordinary Tailwind classes (`bg-surface`, `text-muted`,
 * `rounded-md`) and still be driven entirely by what was measured on the source
 * page. Swapping a token restyles the whole site.
 *
 * All values are sanitised here. The spec is model-influenced, so nothing that
 * reaches the stylesheet is trusted to already be valid CSS.
 */

import { toHex, parseColor } from "../analyzer/color";
import type { ThemeSpec } from "../spec/schema";

/** Only allow a value that cannot terminate a declaration or open a block. */
function safeValue(value: string, fallback: string): string {
  const v = (value ?? "").trim();
  if (!v || v.length > 400) return fallback;
  if (/[;{}<>\\]/.test(v)) return fallback;
  // `url(...)` is the one at-rule-ish thing we genuinely want to keep, but it
  // must not be able to reference a remote origin: the clone must not depend
  // on the original site at runtime.
  if (/url\(/i.test(v)) {
    if (!/url\((['"]?)\/assets\/[^)'"]{1,200}\1\)/i.test(v)) return fallback;
  }
  if (/@import/i.test(v)) return fallback;
  return v;
}

/**
 * Reduce a colour token to something CSS will actually honour.
 *
 * Three passes, in order of how much they can be trusted:
 *
 *  1. A parseable colour becomes hex. This is the normal path.
 *  2. A keyword or custom-property reference is kept verbatim, because
 *     `transparent`, `inherit` and `var(--x)` are legitimate spec values and are
 *     not something to normalise away.
 *  3. Everything else is dropped in favour of the fallback.
 *
 * The third pass is the one that used to be missing. The generic declaration
 * sanitiser rejects `;`, `}`, `<`, `>` and `\`, which is enough to stop a value
 * from escaping its declaration - so `javascript:alert(1)` was not a security
 * hole, since CSS cannot execute it. It was still a correctness bug: the
 * custom property was written out, the browser marked it guaranteed-invalid, and
 * every element using it silently fell back to the cascade instead of the
 * fallback colour the generator intended.
 */
function safeColor(value: string, fallback: string): string {
  const parsed = parseColor(value);
  if (parsed) {
    // `transparent` parses as alpha-0 black, and toHex drops the alpha channel,
    // so a transparent token came out as an opaque #000000 - a black surface
    // where the source had none at all. The keyword is the only faithful
    // spelling of that value.
    if (parsed.a === 0) return "transparent";
    return toHex(parsed);
  }

  const v = (value ?? "").trim();
  // Keywords and references, which are values rather than colours to normalise.
  if (/^(transparent|inherit|currentcolor|currentColor)$/i.test(v)) return v;
  if (/^var\(--[A-Za-z0-9_-]+\)$/.test(v)) return v;
  // A gradient is a legitimate measured value for a background, and cannot be
  // reduced to a single colour. It still has to clear the declaration sanitiser.
  if (/gradient\(/i.test(v)) return safeValue(v, "") || fallback;

  return fallback;
}

function fontStack(family: string, fallback: string): string {
  const v = safeValue(family, "");
  if (!v) return fallback;
  if (!/^(["']?)[A-Za-z0-9 _-]+\1\s*(,|$)/.test(v.trim())) return fallback;
  return v;
}

function safeShadow(value: string, fallback: string): string {
  const v = safeValue(value, "");
  if (!v) return fallback;
  // A shadow must not smuggle in a url() reference.
  if (/url\(|@/i.test(v)) return fallback;
  return v;
}

/**
 * Web fonts are self-hosted: the cloned site must render the same offline and
 * must not phone the source site for a stylesheet.
 */
function fontFaceBlock(theme: ThemeSpec, families: string[]): string {
  void families;
  void theme;
  // Font files are not fetched in this MVP; the measured stack is preserved and
  // system fallbacks keep the layout stable. Documented in docs/architecture.md.
  return "";
}

export function renderGlobalsCss(theme: ThemeSpec, opts: { fontImports?: string[] } = {}): string {
  const t = theme.tokens;
  const dark = theme.mode === "dark";

  const fontImports = (opts.fontImports ?? [])
    .map((f) => safeValue(f, ""))
    .filter(Boolean)
    .map((f) => `@import url(${JSON.stringify(f)});`)
    .join("\n");

  const headingStack = fontStack(theme.fonts.heading.family, dark ? "ui-sans-serif, system-ui, sans-serif" : "ui-sans-serif, system-ui, sans-serif");
  const bodyStack = fontStack(theme.fonts.body.family, "ui-sans-serif, system-ui, -apple-system, sans-serif");

  const vars: Record<string, string> = {
    "--color-bg": safeColor(t.background, dark ? "#0b0f19" : "#ffffff"),
    "--color-surface": safeColor(t.surface, dark ? "#131a2a" : "#f7f8fa"),
    "--color-surface-alt": safeColor(t.surfaceAlt, dark ? "#1b2436" : "#eef0f4"),
    "--color-text": safeColor(t.text, dark ? "#f5f7fa" : "#111827"),
    "--color-muted": safeColor(t.textMuted, dark ? "#98a2b3" : "#667085"),
    "--color-primary": safeColor(t.primary, "#2563eb"),
    "--color-on-primary": safeColor(t.onPrimary, "#ffffff"),
    "--color-border": safeColor(t.border, dark ? "#263248" : "#e5e7eb"),
    "--color-accent": safeColor(t.accent, "#7c3aed"),
    "--font-heading": headingStack,
    "--font-body": bodyStack,
    "--radius-sm": safeValue(theme.radius.sm, "4px"),
    "--radius-md": safeValue(theme.radius.md, "8px"),
    "--radius-lg": safeValue(theme.radius.lg, "16px"),
    "--radius-pill": safeValue(theme.radius.pill, "9999px"),
    "--shadow-sm": safeShadow(theme.shadow.sm, "0 1px 2px rgba(0,0,0,0.08)"),
    "--shadow-md": safeShadow(theme.shadow.md, "0 8px 24px rgba(0,0,0,0.10)"),
    "--shadow-lg": safeShadow(theme.shadow.lg, "0 24px 56px rgba(0,0,0,0.16)"),
    "--container": `${Math.round(theme.containerWidth)}px`,
    "--gutter": "20px",
    "--section-pad": `${Math.round(theme.baseFontSize * 4)}px`,
    "--heading-weight": String(theme.headingWeight),
    "--border-w": safeValue(theme.borderWidth, "1px"),
  };

  const headingSize = Math.round(theme.fonts.heading.size);
  const bodySize = Math.round(theme.fonts.body.size);

  const themeBlock = Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");

  return `/* Generated by Sitewright. Design tokens measured from the source page. */
${fontImports}

@import "tailwindcss";

@theme {
${themeBlock}
}

@layer base {
  :root {
    color-scheme: ${dark ? "dark" : "light"};
  }

  html {
    -webkit-text-size-adjust: 100%;
  }

  body {
    background-color: var(--color-bg);
    color: var(--color-text);
    font-family: var(--font-body);
    font-size: ${bodySize}px;
    line-height: ${theme.fonts.body.lineHeight};
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }

  h1, h2, h3, h4, h5, h6 {
    font-family: var(--font-heading);
    font-weight: var(--heading-weight);
    line-height: ${theme.fonts.heading.lineHeight};
    letter-spacing: ${safeValue(theme.fonts.heading.letterSpacing, "normal")};
    ${theme.fonts.heading.transform === "uppercase" ? "text-transform: uppercase;" : ""}
  }

  a {
    color: inherit;
  }

  img, svg, video {
    max-width: 100%;
    height: auto;
  }

  ::selection {
    background: var(--color-primary);
    color: var(--color-on-primary);
  }

  :focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
}

@layer components {
  /* The one layout primitive every section shares. */
  .sw-container {
    width: 100%;
    max-width: var(--container);
    margin-inline: auto;
    padding-inline: var(--gutter);
  }

  /*
   * Column counts come from the measurement, not from a class name. A section
   * sets \`--sw-cols\` (desktop) and \`--sw-cols-md\` (tablet) inline, and these
   * three rules are the whole responsive story: one column on a phone, at most
   * two on a tablet, the measured count on a desktop. That is what stops a
   * measured 4-across grid from turning into four 80px columns on a phone.
   */
  .sw-grid,
  [data-sw-grid] {
    display: grid;
    gap: var(--sw-gap, 1.5rem);
    grid-template-columns: minmax(0, 1fr);
  }
  @media (min-width: 640px) {
    [data-sw-grid] {
      grid-template-columns: repeat(var(--sw-cols-md, 2), minmax(0, 1fr));
    }
  }
  @media (min-width: 1024px) {
    [data-sw-grid] {
      grid-template-columns: repeat(var(--sw-cols, 3), minmax(0, 1fr));
    }
  }

  .sw-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    border-radius: var(--radius-md);
    padding: 0.7rem 1.25rem;
    font-weight: 600;
    line-height: 1.2;
    text-decoration: none;
    transition: transform 120ms ease, filter 120ms ease, background-color 120ms ease;
  }
  .sw-btn:hover { filter: brightness(1.06); }
  .sw-btn:active { transform: translateY(1px); }

  .sw-btn-primary {
    background-color: var(--color-primary);
    color: var(--color-on-primary);
    border: var(--border-w) solid transparent;
  }

  .sw-btn-ghost {
    background-color: transparent;
    color: var(--color-text);
    border: var(--border-w) solid var(--color-border);
  }

  .sw-eyebrow {
    font-size: 0.8125rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-primary);
  }

  .sw-card {
    background-color: var(--color-surface);
    border: var(--border-w) solid var(--color-border);
    border-radius: var(--radius-lg);
  }

  .sw-prose p + p { margin-top: 1rem; }
  .sw-prose a { color: var(--color-primary); text-decoration: underline; }
  .sw-prose ul { list-style: disc; padding-left: 1.25rem; }
  .sw-prose ol { list-style: decimal; padding-left: 1.25rem; }
}

@media (min-width: 640px) {
  :root { --gutter: 32px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
`;
}

/** Convenience for the doc block at the top of a generated stylesheet. */
export function themeHeader(sourceUrl: string, model: string): string {
  return `/*
 * Generated by Sitewright from ${sourceUrl}
 * Design tokens: measured from the source page. Layout decisions: ${model}.
 * This project is standalone — it has no runtime dependency on the source site.
 */
`;
}

export { safeValue as sanitizeCssValue, fontFaceBlock };
