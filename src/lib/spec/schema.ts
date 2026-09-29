/**
 * WebsiteSpec — the contract between analysis and generation.
 *
 * Design intent
 * -------------
 * Raw browser output is noisy, huge, and ambiguous. Raw AI output is lossy and
 * untrustworthy. The spec is the narrow, validated middle: it is small enough
 * to be cheap to produce and to store, and it is complete enough that code
 * generation is a mechanical projection with no further model calls.
 *
 * The spec deliberately mixes two provenances, recorded per field so that a
 * reviewer can always tell what the browser measured from what the model
 * inferred:
 *   - `measured`  visual facts taken from computed styles and bounding boxes
 *   - `inferred`  semantic decisions: what a block *is*, how it should be
 *                 named, what it is for
 */

import { z } from "zod";

export const SECTION_KINDS = [
  "hero",
  "announcement",
  "logos",
  "features",
  "stats",
  "showcase",
  "gallery",
  "menu",
  "testimonials",
  "pricing",
  "faq",
  "team",
  "timeline",
  "cta",
  "richtext",
  "form",
  "table",
  "video",
  "footer",
  "unknown",
] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

// ------------------------------------------------------------------ tokens

export const ColorTokenSchema = z
  .string()
  .describe("Any CSS colour value: #rrggbb, rgb(...), hsl(...), or a CSS var reference")
  .max(120);

export const FontTokenSchema = z.object({
  /** CSS font-family stack, quoted exactly as the browser resolved it. */
  family: z.string().min(1).max(300),
  /** Representative size in px for this role. */
  size: z.number().min(4).max(200),
  weight: z.number().min(100).max(1000),
  lineHeight: z.number().min(0.5).max(6).default(1.2),
  letterSpacing: z.string().max(40).default("normal"),
  transform: z.enum(["none", "uppercase", "lowercase", "capitalize"]).default("none"),
  italic: z.boolean().default(false),
});

export const ThemeSpecSchema = z.object({
  mode: z.enum(["light", "dark"]),
  tokens: z.object({
    background: ColorTokenSchema,
    surface: ColorTokenSchema,
    surfaceAlt: ColorTokenSchema,
    text: ColorTokenSchema,
    textMuted: ColorTokenSchema,
    primary: ColorTokenSchema,
    onPrimary: ColorTokenSchema,
    border: ColorTokenSchema,
    accent: ColorTokenSchema,
  }),
  fonts: z.object({
    heading: FontTokenSchema,
    body: FontTokenSchema,
  }),
  radius: z.object({
    sm: z.string().max(20).default("4px"),
    md: z.string().max(20).default("8px"),
    lg: z.string().max(24).default("16px"),
    pill: z.string().max(24).default("9999px"),
  }),
  shadow: z.object({
    sm: z.string().max(160).default("0 1px 2px rgba(0,0,0,0.06)"),
    md: z.string().max(160).default("0 4px 12px rgba(0,0,0,0.08)"),
    lg: z.string().max(200).default("0 18px 40px rgba(0,0,0,0.12)"),
  }),
  /** Widest content column observed, in px. */
  containerWidth: z.number().min(320).max(2400).default(1200),
  /** Base body font size used to derive the spacing scale. */
  baseFontSize: z.number().min(8).max(32).default(16),
  /** Global border/heading style, picked up from the most common values. */
  headingWeight: z.number().min(100).max(1000).default(700),
  borderWidth: z.string().max(12).default("1px"),
  /** Where each token came from. */
  provenance: z
    .object({
      tokens: z.enum(["measured", "inferred"]).default("measured"),
      fonts: z.enum(["measured", "inferred"]).default("measured"),
      radius: z.enum(["measured", "inferred"]).default("measured"),
    })
    .default({ tokens: "measured", fonts: "measured", radius: "measured" }),
});

export type ThemeSpec = z.infer<typeof ThemeSpecSchema>;

// ------------------------------------------------------------------ content

export const AssetRefSchema = z.object({
  /** Local path inside the generated project's `public/` directory. */
  localPath: z.string().max(300),
  /** Original absolute URL, kept for provenance and for the UI. */
  sourceUrl: z.string().max(2000).optional(),
  alt: z.string().max(300).default(""),
  width: z.number().int().min(0).max(20000).optional(),
  height: z.number().int().min(0).max(20000).optional(),
  intrinsicWidth: z.number().int().min(0).max(20000).optional(),
  intrinsicHeight: z.number().int().min(0).max(20000).optional(),
  /** Set when the download failed and a placeholder is being used. */
  missing: z.boolean().default(false),
  kind: z.enum(["image", "svg", "video", "icon", "font", "other"]).default("image"),
});

export type AssetRef = z.infer<typeof AssetRefSchema>;

export const TextBlockSchema = z.object({
  text: z.string().max(4000).default(""),
  /** Heading level the source used, 1-6, or 0 for body copy. */
  level: z.number().int().min(0).max(6).default(0),
  align: z.enum(["left", "center", "right"]).default("left"),
  color: ColorTokenSchema.optional(),
  fontSize: z.number().min(4).max(200).optional(),
  fontWeight: z.number().min(100).max(1000).optional(),
});

export const LinkSchema = z.object({
  label: z.string().min(0).max(200).default(""),
  href: z.string().max(1000).default("#"),
  /** Primary-styled links become buttons. */
  primary: z.boolean().default(false),
  external: z.boolean().default(false),
});

export const ItemSchema = z.object({
  title: z.string().max(300).default(""),
  body: z.string().max(2000).default(""),
  meta: z.string().max(300).default(""),
  /** Price label for pricing tiers. */
  price: z.string().max(80).default(""),
  /** Bullet list, used by pricing and feature tiers. */
  bullets: z.array(z.string().max(300)).max(20).default([]),
  image: AssetRefSchema.optional(),
  icon: AssetRefSchema.optional(),
  link: LinkSchema.optional(),
  badge: z.string().max(80).default(""),
});

export type Item = z.infer<typeof ItemSchema>;
export type Link = z.infer<typeof LinkSchema>;
export type TextBlock = z.infer<typeof TextBlockSchema>;

// ------------------------------------------------------------------ layout

export type SectionStyle = z.infer<typeof SectionStyleSchema>;

export const SectionStyleSchema = z.object({
  background: z.string().max(400).default("transparent"),
  color: ColorTokenSchema.default("inherit"),
  /** Vertical padding in px, as measured. */
  paddingY: z.number().min(0).max(400).default(80),
  paddingX: z.number().min(0).max(200).default(24),
  maxWidth: z.number().min(280).max(2400).optional(),
  align: z.enum(["left", "center"]).default("left"),
  /** Grid columns for card-style sections. */
  columns: z.number().int().min(1).max(6).default(1),
  gap: z.number().min(0).max(200).default(24),
  /** 1 for a single-column hero, 2 for text-beside-image. */
  split: z.enum(["stack", "side"]).default("stack"),
  side: z.enum(["text-first", "media-first"]).default("media-first"),
  borderTop: z.string().max(60).default("none"),
  radius: z.string().max(24).default("0px"),
});

export const SectionSpecSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  kind: z.enum(SECTION_KINDS),
  /** Human label shown in the UI, e.g. "Hero", "Pricing". */
  name: z.string().max(80).default("Section"),
  /** One-line explanation of the section's job, produced by the model. */
  intent: z.string().max(300).default(""),
  heading: TextBlockSchema.optional(),
  subheading: TextBlockSchema.optional(),
  items: z.array(ItemSchema).max(24).default([]),
  links: z.array(LinkSchema).max(12).default([]),
  /** Primary action rendered as a button. */
  cta: LinkSchema.optional(),
  media: AssetRefSchema.optional(),
  backgroundMedia: AssetRefSchema.optional(),
  style: SectionStyleSchema.default({}),
  /** Measured height, used to sanity-check the clone's proportions. */
  measuredHeight: z.number().min(0).max(20000).optional(),
  measuredWidth: z.number().min(0).max(20000).optional(),
  /** Ordinal position in the source page. */
  order: z.number().int().min(0).max(200).default(0),
  /** True when the model is guessing rather than reading a real block. */
  lowConfidence: z.boolean().default(false),
  /** Raw source tag, useful when debugging extraction. */
  sourceTag: z.string().max(40).default(""),
  sourceSelector: z.string().max(200).default(""),
});

export type SectionSpec = z.infer<typeof SectionSpecSchema>;

// ----------------------------------------------------------------- chrome

export const NavSpecSchema = z.object({
  brand: z.string().max(200).default(""),
  brandText: z.string().max(200).default(""),
  logo: AssetRefSchema.optional(),
  links: z.array(LinkSchema).max(20).default([]),
  cta: LinkSchema.optional(),
  variant: z
    .enum(["logo-links", "logo-links-cta", "centered", "minimal", "stacked"])
    .default("logo-links"),
  background: z.string().max(400).default("transparent"),
  sticky: z.boolean().default(false),
  borderBottom: z.string().max(60).default("none"),
  height: z.number().min(0).max(400).optional(),
});

export const FooterSpecSchema = z.object({
  brand: z.string().max(200).default(""),
  brandText: z.string().max(300).default(""),
  logo: AssetRefSchema.optional(),
  tagline: z.string().max(500).default(""),
  columns: z
    .array(
      z.object({
        heading: z.string().max(120).default(""),
        links: z.array(LinkSchema).max(20).default([]),
      }),
    )
    .max(8)
    .default([]),
  legal: z.array(LinkSchema).max(12).default([]),
  social: z.array(LinkSchema).max(12).default([]),
  variant: z.enum(["columns", "simple", "centered"]).default("columns"),
  background: z.string().max(400).default("transparent"),
  color: ColorTokenSchema.default("inherit"),
  paddingY: z.number().min(0).max(400).default(64),
  copyright: z.string().max(300).default(""),
});

export const ResponsiveSpecSchema = z.object({
  /** Breakpoints actually observed by the crawler. */
  observedViewports: z
    .array(
      z.object({
        name: z.string(),
        width: z.number(),
        height: z.number(),
      }),
    )
    .default([]),
  /** Element order changes between desktop and mobile, where detected. */
  mobileReordersNav: z.boolean().default(true),
  mobileHidesColumns: z.boolean().default(true),
  containerGutter: z.number().min(0).max(96).default(20),
});

export const MetaSpecSchema = z.object({
  sourceUrl: z.string(),
  finalUrl: z.string(),
  title: z.string().max(400).default(""),
  description: z.string().max(1000).default(""),
  language: z.string().max(20).default("en"),
  favicon: z.string().max(500).default(""),
  themeColor: z.string().max(60).default(""),
  generator: z.string().max(200).default(""),
});

export const WebsiteSpecSchema = z.object({
  /** Spec format version, so the modifier and generator can migrate safely. */
  specVersion: z.literal(1).default(1),
  meta: MetaSpecSchema,
  theme: ThemeSpecSchema,
  nav: NavSpecSchema.nullable().default(null),
  sections: z.array(SectionSpecSchema).min(1).max(40),
  footer: FooterSpecSchema.nullable().default(null),
  responsive: ResponsiveSpecSchema.default({}),
  /** Everything the model said about the site, kept for the UI/debugging. */
  analysis: z
    .object({
      summary: z.string().max(1200).default(""),
      designLanguage: z.string().max(400).default(""),
      audience: z.string().max(300).default(""),
      warnings: z.array(z.string().max(300)).max(12).default([]),
    })
    .default({ summary: "", designLanguage: "", audience: "", warnings: [] }),
  /** Bookkeeping about the run. */
  stats: z
    .object({
      model: z.string().max(200).default(""),
      analyzedAt: z.string().max(60).default(""),
      durationMs: z.number().min(0).default(0),
      sectionCount: z.number().int().min(0).default(0),
      assetCount: z.number().int().min(0).default(0),
      assetsMissing: z.number().int().min(0).default(0),
      modelTrail: z.array(z.string().max(200)).max(20).default([]),
    })
    .default({
      model: "",
      analyzedAt: "",
      durationMs: 0,
      sectionCount: 0,
      assetCount: 0,
      assetsMissing: 0,
      modelTrail: [],
    }),
});

export type WebsiteSpec = z.infer<typeof WebsiteSpecSchema>;

/**
 * Layout words that carry no meaning about what a block *is*.
 *
 * A model asked for one of nineteen kinds usually answers with one, but when it
 * does not, it tends to describe the layout instead: "feature-grid",
 * "logo-wall", "testimonial-carousel". The lookup table below is keyed on bare
 * nouns, so these are stripped and the bare noun is tried. Growing the table with
 * every compound instead would mean a new entry each time a model invents a
 * fresh layout word, and the miss would still be silent.
 */
const LAYOUT_WORDS = [
  "grids", "grid", "walls", "wall", "rows", "row", "lists", "list",
  "sliders", "slider", "carousels", "carousel", "sections", "section",
  "blocks", "block", "panels", "panel", "columns", "col", "wrappers", "wrapper",
  "layouts", "layout", "strips", "strip", "bars", "bar", "bands", "band",
  "boxes", "box", "tiles", "tile", "modules", "module", "components", "component",
  "cards", "card", "items", "item", "links", "link", "area", "block2",
];

/** Narrow a partially-known value to a valid kind, defaulting to `unknown`. */
export function coerceKind(value: string | undefined | null): SectionKind {
  if (!value) return "unknown";
  // Separators are removed, not replaced with nothing: "feature grid",
  // "feature-grid" and "FeatureGrid" must all reduce to the same key.
  const v = String(value).trim().toLowerCase().replace(/[\s_-]+/g, "");
  const table: Record<string, SectionKind> = {
    hero: "hero", banner: "hero", masthead: "hero", header: "hero", cover: "hero", jumbotron: "hero",
    intro: "hero", lead: "hero", opening: "hero",
    announcement: "announcement", alert: "announcement", notice: "announcement", topbar: "announcement",
    logos: "logos", logo: "logos", logocloud: "logos", brands: "logos", clients: "logos", partners: "logos",
    trust: "logos", trustbar: "logos",
    features: "features", feature: "features", benefits: "features", services: "features", why: "features",
    value: "features", valueslist: "features", advantage: "features", advantages: "features",
    offerings: "features", pillars: "features", values: "features", cards: "features", highlights: "features",
    stats: "stats", metrics: "stats", numbers: "stats", kpis: "stats", counters: "stats",
    showcase: "showcase", work: "showcase", portfolio: "showcase", projects: "showcase",
    casestudy: "showcase", case: "showcase",
    gallery: "gallery", image: "gallery", images: "gallery", photos: "gallery", lookbook: "gallery",
    lightbox: "gallery", masonry: "gallery",
    menu: "menu", products: "menu", catalog: "menu", catalogue: "menu", shop: "menu", store: "menu",
    testimonials: "testimonials", testimonial: "testimonials", reviews: "testimonials",
    quotes: "testimonials", feedback: "testimonials",
    pricing: "pricing", plans: "pricing", tiers: "pricing", packages: "pricing", subscriptions: "pricing",
    price: "pricing", rates: "pricing",
    faq: "faq", faqs: "faq", questions: "faq", accordion: "faq",
    team: "team", people: "team", staff: "team", aboutus: "team", employees: "team",
    timeline: "timeline", steps: "timeline", process: "timeline", howitworks: "timeline", journey: "timeline",
    cta: "cta", calltoaction: "cta", signup: "cta", bannercta: "cta",
    richtext: "richtext", text: "richtext", content: "richtext", about: "richtext", article: "richtext",
    prose: "richtext", copy: "richtext",
    form: "form", contact: "form", newsletter: "form", subscribe: "form", signupform: "form",
    table: "table", comparison: "table",
    video: "video", media: "video",
    footer: "footer", colophon: "footer",
  };

  const direct = table[v];
  if (direct) return direct;

  // Drop trailing layout words one at a time, from the right. A compound like
  // "featuregridlayout" needs three passes, and trying only the first would
  // still miss.
  // Strip trailing layout words one at a time, longest match first, and retry.
  //
  // Suffix matching has to be done against the word list rather than with a
  // regular expression capturing "the last few letters": greedy and lazy groups
  // both cut the compound at the wrong place, so "featuregrid" comes back as
  // "featuregr" plus the meaningless tail "id" and nothing is ever looked up.
  let candidate = v;
  for (let guard = 0; guard < 4; guard++) {
    let stripped = false;
    for (const word of LAYOUT_WORDS) {
      if (candidate.length <= word.length || !candidate.endsWith(word)) continue;
      const shorter = candidate.slice(0, -word.length);
      const found = table[shorter];
      if (found) return found;
      candidate = shorter;
      stripped = true;
      break;
    }
    if (!stripped) break;
  }

  // Last resort, and the reason this function is total: find the longest table
  // key that appears at either end of the input. "herobanner" contains "banner",
  // "logowall" contains "logo", "testimonialcarousel" contains "testimonial" -
  // compounds the suffix loop cannot decompose because the trailing word is
  // itself a kind rather than a layout word.
  //
  // Only the *edges* are compared, never the middle: a bare substring test would
  // map any input containing "cta" or "art" onto that kind, which is worse than
  // admitting ignorance. Longest wins, so "pricingcards" prefers "pricing" over
  // "cards".
  let best: { kind: SectionKind; len: number } | null = null;
  for (const [key, kind] of Object.entries(table)) {
    if (!v.startsWith(key) && !v.endsWith(key)) continue;
    if (!best || key.length > best.len) best = { kind, len: key.length };
  }
  return best ? best.kind : "unknown";
}
