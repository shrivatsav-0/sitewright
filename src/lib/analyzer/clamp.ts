/**
 * Measured-value clamping.
 *
 * A spec field like `theme.shadow.md` is capped at 160 characters, but the value
 * filling it came from a real `box-shadow` that a designer can make arbitrarily
 * long. The same is true of border shorthand, font stacks, and CSS custom
 * property values. Rejecting an entire generation because one decorative string
 * overflowed its budget would be a bad trade: the information loss from
 * truncating a shadow is nil, the information loss from a failed run is the
 * whole site.
 *
 * So: clamp every free-text field on its way into the spec, and let the schema
 * stay strict about structure. Structural problems (a missing section, a colour
 * that is not a colour) are real errors and are still rejected.
 */

import type { WebsiteSpec } from "../spec/schema";

/** Longest value the spec's bounded string fields will accept. */
const LIMITS = {
  color: 120,
  fontFamily: 300,
  radius: 60,
  shadowSmMd: 160,
  shadowLg: 200,
  cssValue: 400,
  linkHref: 400,
  linkLabel: 80,
  brand: 200,
  text: 600,
} as const;

function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  if (t.length <= max) return t;
  // Cut on a boundary so a clipped CSS value stays parseable.
  return `${t.slice(0, max - 1).replace(/[\s,;]+$/, "")}…`;
}

/** Also strip anything that could terminate a value early in a stylesheet. */
function safe(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  // `</style>` and a bare semicolon can end or corrupt a generated rule.
  return value.replace(/<\/?style/gi, "").replace(/[;{}]/g, " ");
}

export function clampMeasured(spec: WebsiteSpec): WebsiteSpec {
  const s = structuredClone(spec);

  // ---- theme
  for (const key of ["background", "surface", "surfaceAlt", "text", "textMuted", "primary", "onPrimary", "border", "accent"] as const) {
    s.theme.tokens[key] = clip(safe(s.theme.tokens[key]), LIMITS.color) ?? s.theme.tokens[key];
  }
  s.theme.fonts.heading.family = clip(s.theme.fonts.heading.family, LIMITS.fontFamily) ?? s.theme.fonts.heading.family;
  s.theme.fonts.body.family = clip(s.theme.fonts.body.family, LIMITS.fontFamily) ?? s.theme.fonts.body.family;
  for (const r of ["sm", "md", "lg", "pill"] as const) {
    s.theme.radius[r] = clip(safe(s.theme.radius[r]), LIMITS.radius) ?? s.theme.radius[r];
  }
  s.theme.shadow.sm = clip(safe(s.theme.shadow.sm), LIMITS.shadowSmMd) ?? s.theme.shadow.sm;
  s.theme.shadow.md = clip(safe(s.theme.shadow.md), LIMITS.shadowSmMd) ?? s.theme.shadow.md;
  s.theme.shadow.lg = clip(safe(s.theme.shadow.lg), LIMITS.shadowLg) ?? s.theme.shadow.lg;
  s.theme.borderWidth = clip(safe(s.theme.borderWidth), LIMITS.radius) ?? s.theme.borderWidth;

  // ---- meta
  s.meta.title = clip(s.meta.title, 400) ?? s.meta.title;
  s.meta.description = clip(s.meta.description, 1000) ?? s.meta.description;
  s.meta.themeColor = clip(safe(s.meta.themeColor), 60) ?? s.meta.themeColor;
  s.meta.favicon = clip(s.meta.favicon, 500) ?? s.meta.favicon;
  s.meta.generator = clip(s.meta.generator, 200) ?? s.meta.generator;

  // ---- nav
  if (s.nav) {
    s.nav.background = clip(safe(s.nav.background), LIMITS.cssValue) ?? s.nav.background;
    s.nav.borderBottom = clip(safe(s.nav.borderBottom), 60) ?? s.nav.borderBottom;
    s.nav.brand = clip(s.nav.brand, 200) ?? s.nav.brand;
    s.nav.brandText = clip(s.nav.brandText, 200) ?? s.nav.brandText;
    s.nav.links = s.nav.links.map((l) => clipLink(l));
    if (s.nav.cta) s.nav.cta = clipLink(s.nav.cta);
  }

  // ---- footer
  if (s.footer) {
    s.footer.background = clip(safe(s.footer.background), LIMITS.cssValue) ?? s.footer.background;
    s.footer.color = clip(safe(s.footer.color), LIMITS.color) ?? s.footer.color;
    s.footer.tagline = clip(s.footer.tagline, 500) ?? s.footer.tagline;
    s.footer.brandText = clip(s.footer.brandText, 300) ?? s.footer.brandText;
    s.footer.copyright = clip(s.footer.copyright, 300) ?? s.footer.copyright;
    s.footer.legal = s.footer.legal.map((l) => clipLink(l));
    s.footer.social = s.footer.social.map((l) => clipLink(l));
    s.footer.columns = s.footer.columns.map((c) => ({
      heading: clip(c.heading, 120) ?? c.heading,
      links: c.links.map((l) => clipLink(l)),
    }));
  }

  // ---- sections
  for (const sec of s.sections) {
    sec.name = clip(sec.name, 120) ?? sec.name;
    sec.intent = clip(sec.intent, 300) ?? sec.intent;
    sec.style.background = clip(safe(sec.style.background), LIMITS.cssValue) ?? sec.style.background;
    sec.style.color = clip(safe(sec.style.color), LIMITS.color) ?? sec.style.color;
    sec.style.borderTop = clip(safe(sec.style.borderTop), 60) ?? sec.style.borderTop;
    sec.style.radius = clip(safe(sec.style.radius), 60) ?? sec.style.radius;
    if (sec.heading) sec.heading.text = clip(sec.heading.text, LIMITS.text) ?? sec.heading.text;
    if (sec.subheading) sec.subheading.text = clip(sec.subheading.text, LIMITS.text) ?? sec.subheading.text;
    sec.links = sec.links.map((l) => clipLink(l));
    if (sec.cta) sec.cta = clipLink(sec.cta);
    sec.items = sec.items.map((it) => ({
      ...it,
      title: clip(it.title, 200) ?? it.title,
      body: clip(it.body, 1200) ?? it.body,
      meta: clip(it.meta, 200) ?? it.meta,
      price: clip(it.price, 60) ?? it.price,
      badge: clip(it.badge, 60) ?? it.badge,
      bullets: it.bullets.map((b) => clip(b, 300) ?? b),
    }));
  }

  // ---- analysis
  s.analysis.summary = clip(s.analysis.summary, 1200) ?? s.analysis.summary;
  s.analysis.designLanguage = clip(s.analysis.designLanguage, 400) ?? s.analysis.designLanguage;
  s.analysis.audience = clip(s.analysis.audience, 300) ?? s.analysis.audience;
  s.analysis.warnings = s.analysis.warnings.map((w) => clip(w, 300) ?? w);

  return s;
}

function clipLink<T extends { label: string; href: string }>(l: T): T {
  return { ...l, label: clip(l.label, LIMITS.linkLabel) ?? l.label, href: clip(l.href, LIMITS.linkHref) ?? l.href };
}
