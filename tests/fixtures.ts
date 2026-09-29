/**
 * Test fixtures and helpers.
 *
 * Not a test file: shared setup, so each test file states only what it is
 * actually asserting.
 */

import type { WebsiteSpec } from "../src/lib/spec/schema";

/**
 * A small but complete spec.
 *
 * Every optional-but-defaulted field is left out, so a change that adds a
 * required field to the schema surfaces here as a fixture failure rather than
 * as a confusing assertion error in whichever test happened to run first.
 */
export function sampleSpec(): WebsiteSpec {
  return {
    specVersion: 1,
    meta: {
      sourceUrl: "https://example.com",
      finalUrl: "https://example.com/",
      title: "Example Domain",
      description: "A sample site",
    },
    theme: {
      mode: "light",
      tokens: {
        background: "#ffffff",
        surface: "#ffffff",
        surfaceAlt: "#f6f6f6",
        text: "#1b1b1b",
        textMuted: "#646464",
        primary: "#da532c",
        onPrimary: "#000000",
        border: "#d6d6d6",
        accent: "#d83933",
      },
      fonts: {
        heading: {
          family: "Inter, sans-serif",
          size: 29,
          weight: 700,
          lineHeight: 1.2,
          letterSpacing: "normal",
          transform: "none",
          italic: false,
        },
        body: {
          family: "Inter, sans-serif",
          size: 16,
          weight: 400,
          lineHeight: 1.6,
          letterSpacing: "normal",
          transform: "none",
          italic: false,
        },
      },
      radius: { sm: "4px", md: "8px", lg: "16px", pill: "9999px" },
      shadow: {
        sm: "0 1px 2px rgba(0,0,0,0.1)",
        md: "0 6px 16px rgba(0,0,0,0.14)",
        lg: "0 20px 48px rgba(0,0,0,0.18)",
      },
      containerWidth: 1200,
      baseFontSize: 16,
      headingWeight: 700,
      borderWidth: "1px",
      provenance: { tokens: "measured", fonts: "measured", radius: "measured" },
    },
    nav: {
      variant: "logo-links",
      brandText: "Example",
      links: [
        { label: "Docs", href: "/docs", primary: false },
        { label: "Pricing", href: "/pricing", primary: true },
      ],
    },
    sections: [
      {
        id: "hero",
        kind: "hero",
        name: "Hero",
        intent: "Lead with the value proposition.",
        heading: { text: "Build faster", level: 1, align: "left" },
        subheading: { text: "A one-line summary of the offer.", level: 0, align: "left" },
        items: [],
        links: [],
        cta: { label: "Get started", href: "/start", primary: true, external: false },
        style: {
          background: "transparent",
          color: "inherit",
          align: "left",
          columns: 1,
          paddingY: 72,
          radius: "0px",
          side: "text-first",
          split: "stack",
        },
        measuredHeight: 520,
        measuredWidth: 1440,
        order: 0,
        lowConfidence: false,
        sourceTag: "section",
        sourceSelector: "body > section:nth-of-type(1)",
      },
      {
        id: "features",
        kind: "features",
        name: "Features",
        intent: "List the three things that matter.",
        heading: { text: "Why teams switch", level: 2, align: "center" },
        items: [
          {
            title: "Fast",
            body: "Renders in under a second.",
            meta: "",
            price: "",
            badge: "",
            bullets: ["No build step", "Edge deployed"],
            link: { label: "Read more", href: "/fast", primary: false, external: false },
          },
          {
            title: "Small",
            body: "Nothing you do not use.",
            meta: "",
            price: "",
            badge: "",
            bullets: [],
            link: { label: "Read more", href: "/small", primary: false, external: false },
          },
        ],
        links: [],
        style: {
          background: "rgb(246, 246, 246)",
          color: "inherit",
          align: "center",
          columns: 3,
          paddingY: 64,
          radius: "0px",
          side: "text-first",
          split: "stack",
        },
        measuredHeight: 480,
        measuredWidth: 1440,
        order: 1,
        lowConfidence: false,
        sourceTag: "section",
        sourceSelector: "body > section:nth-of-type(2)",
      },
    ],
    footer: {
      variant: "columns",
      tagline: "Example, Inc.",
      brand: "Example",
      brandText: "Example",
      // Separate from `columns`: the generator renders these as the bottom bar
      // and the social row respectively.
      legal: [{ label: "Terms", href: "/terms", primary: false, external: false }],
      social: [
        { label: "GitHub", href: "https://github.com/example", primary: false, external: true },
      ],
      columns: [
        {
          heading: "Product",
          links: [
            { label: "Features", href: "/features", primary: false, external: false },
            { label: "Pricing", href: "/pricing", primary: false, external: false },
          ],
        },
        {
          heading: "Company",
          links: [
            { label: "About", href: "/about", primary: false, external: false },
            { label: "Careers", href: "/careers", primary: false, external: false },
          ],
        },
      ],
    },
    responsive: {},
    analysis: { summary: "", designLanguage: "", audience: "", warnings: [] },
    stats: {
      model: "test/model",
      analyzedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 0,
      sectionCount: 2,
      assetCount: 0,
      assetsMissing: 0,
      modelTrail: ["test/model"],
    },
  } as unknown as WebsiteSpec;
}

/** A minimal design observation, as the in-page extractor would return it. */
export function sampleDesign(overrides: Record<string, unknown> = {}) {
  return {
    bodyBackground: "rgb(255, 255, 255)",
    bodyColor: "rgb(27, 27, 27)",
    bodyFont: "Inter, sans-serif",
    bodyFontSize: 16,
    colorCandidates: ["rgb(255, 255, 255)", "rgb(27, 27, 27)"],
    backgroundCandidates: ["rgb(255, 255, 255)"],
    brandFills: [],
    brandInks: [],
    themeColorMeta: "",
    fontCandidates: ["Inter, sans-serif"],
    sizeCandidates: [16, 14],
    radiusCandidates: ["4px"],
    shadowCandidates: [],
    borderCandidates: ["1px rgb(0, 0, 0)"],
    paddingCandidates: [24],
    containerWidth: 1200,
    headings: {},
    ...overrides,
  };
}

/** A minimal measured page, as the extractor would return it. */
export function samplePage(overrides: Record<string, unknown> = {}) {
  return {
    url: "https://example.com/",
    title: "Example Domain",
    counts: { images: 0, links: 0, forms: 0, buttons: 0, listItems: 0 },
    viewport: { scrollHeight: 2000, width: 1440, height: 900 },
    design: sampleDesign(),
    navigation: null,
    footer: null,
    sections: [],
    assets: [],
    warnings: [],
    ...overrides,
  } as any;
}
