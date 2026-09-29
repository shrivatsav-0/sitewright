/**
 * The AI's actual job, expressed as a schema.
 *
 * Deliberately *not* the WebsiteSpec. The WebsiteSpec is mostly measured facts
 * (colours, padding, fonts, column counts) that a model would only reproduce
 * lossily. The model is asked for the small set of decisions it is genuinely
 * good at:
 *
 *   - What each measured block *is* (`kind`) and what it is *for* (`intent`)
 *   - Which blocks should be merged or dropped
 *   - The one-line copy for each block
 *   - Whether the page is light or dark, and what the brand feels like
 *
 * `synthesize.ts` merges this plan over the measured data to produce the
 * validated WebsiteSpec. Keeping the two apart is what makes the model output
 * cheap to constrain and easy to validate.
 */

import { z } from "zod";
import { SECTION_KINDS } from "../spec/schema";

/** Keep the model honest: the allowed set is shared with the spec schema. */
const KindEnum = z.enum(SECTION_KINDS);

/**
 * A descriptive string with a length budget that *truncates* instead of failing.
 *
 * Only used for prose fields — names, intents, headings, summaries. A model
 * writing 260 characters when 200 were asked for has not produced a *wrong*
 * answer, it has produced a long one, and rejecting it spends a correction
 * round-trip to learn nothing. Structural fields (section indices, kind
 * enums, colour hexes) stay strict, because those really can be wrong.
 */
const prose = (max: number) =>
  z
    .string()
    .transform((v) => (v.length > max ? `${v.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : v))
    .pipe(z.string().max(max));

/** Index of a measured section, so the plan and the measurements stay aligned. */
const SectionIndex = z.number().int().min(0).max(60);

export const PlanItemSchema = z
  .object({
    title: prose(120).default(""),
    body: prose(400).default(""),
    price: prose(60).default(""),
    badge: prose(60).default(""),
  })
  .default({});

export const PlanSectionSchema = z.object({
  /** Every measured section index this entry consumes, in order. */
  from: SectionIndex,
  /** Extra measured sections folded into the same block. */
  merge: z.array(SectionIndex).max(4).default([]),
  kind: KindEnum,
  /** Short human label, e.g. "Pricing", "Logo strip". Used in the UI only. */
  name: prose(40).default("Section"),
  /** One sentence on what this block is for. Shown in the UI, aids review. */
  intent: prose(200).default(""),
  /** Heading copy. Empty string means "keep what the page had". */
  heading: prose(200).default(""),
  /** Supporting copy under the heading. */
  subheading: prose(300).default(""),
  /** Reproduce the measured items, or replace/trim them. */
  items: z.array(PlanItemSchema).max(8).default([]),
  /** Mark the section as reconstructed rather than observed. */
  inferred: z.boolean().default(false),
});

export const PlanNavSchema = z.object({
  variant: z.enum(["logo-links", "logo-links-cta", "centered", "minimal", "stacked"]).default("logo-links"),
  /** Rename the brand when the logo image is not usable as text. */
  brandText: prose(80).default(""),
  links: z
    .array(
      z.object({
        label: prose(60),
        href: z.string().max(400).default("#"),
        primary: z.boolean().default(false),
      }),
    )
    .max(12)
    .default([]),
});

export const PlanFooterSchema = z.object({
  variant: z.enum(["columns", "simple", "centered"]).default("columns"),
  tagline: prose(240).default(""),
  columns: z
    .array(
      z.object({
        heading: prose(80).default(""),
        links: z
          .array(z.object({ label: prose(60), href: z.string().max(400).default("#") }))
          .max(10)
          .default([]),
      }),
    )
    .max(6)
    .default([]),
});

export const SitePlanSchema = z.object({
  site: z.object({
    /** Cleaned-up page title for <title> and the top bar. */
    title: prose(200).default(""),
    description: prose(300).default(""),
    /** One-paragraph plain-English description of what this site is. */
    summary: prose(600).default(""),
    /** Design language in a few words, e.g. "editorial, high-contrast, serif". */
    designLanguage: prose(240).default(""),
    audience: prose(240).default(""),
  }),
  theme: z.object({
    /** The model may confirm or override the measured light/dark reading. */
    mode: z.enum(["light", "dark"]),
    /** The single most important brand colour, if it is obvious. */
    primary: z
      .string()
      .max(40)
      .regex(/^#[0-9a-fA-F]{3,8}$/, "must be a hex colour such as #1f6feb")
      .optional()
      .or(z.literal("")),
  }),
  nav: PlanNavSchema.default({}),
  footer: PlanFooterSchema.default({}),
  sections: z.array(PlanSectionSchema).min(1).max(30),
  /** Things the plan could not do, or that a human should check. */
  warnings: z.array(prose(240)).max(8).default([]),
});

export type SitePlan = z.infer<typeof SitePlanSchema>;
export type PlanSection = z.infer<typeof PlanSectionSchema>;
