/**
 * Spec schema and prompt-vocabulary tests.
 *
 * The spec is the contract between the analyzer, the modifier, the generator
 * and the on-disk project. If it drifts, the failure is not a type error: it is
 * a clone that builds but renders the wrong thing, so these assert the shape
 * rather than just the types.
 *
 * The prompt-vocabulary tests exist because of a specific, recurring waste: the
 * prompts used to describe enum-valued fields as plain strings, so the model
 * invented plausible-looking values, the validator rejected them, and every run
 * spent an extra full model call on a correction. The prompt and the schema now
 * share the vocabulary, and these keep them from drifting apart.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  SECTION_KINDS,
  WebsiteSpecSchema,
  coerceKind,
} from "../src/lib/spec/schema";
import { sitePlanSystem } from "../src/lib/prompts/index";
import { PatchSchema } from "../src/lib/modifier/schema";
import { sampleSpec } from "./fixtures";

describe("WebsiteSpecSchema", () => {
  test("accepts a complete spec", () => {
    const result = WebsiteSpecSchema.safeParse(sampleSpec());
    assert.ok(result.success, JSON.stringify(result.error?.issues.slice(0, 5), null, 2));
  });

  test("rejects a spec with no sections", () => {
    // A site with zero sections is not a reconstruction, it is a failure, and
    // accepting it would let an empty page reach the generator.
    const spec = sampleSpec();
    (spec as any).sections = [];
    assert.ok(!WebsiteSpecSchema.safeParse(spec).success);
  });

  test("rejects an unknown section kind", () => {
    const spec = sampleSpec();
    (spec.sections[0] as any).kind = "definitely-not-a-kind";
    assert.ok(!WebsiteSpecSchema.safeParse(spec).success);
  });

  // Note: colour *format* is deliberately not a schema rule. Measured tokens
  // legitimately hold gradients, `color-mix()` and `var()` references, so
  // rejecting them here would throw away real measurements. The security
  // boundary is the generator's sanitiser, asserted in generator.test.ts where
  // the value actually becomes CSS.

  test("fills defaults for optional fields", () => {
    const spec = sampleSpec() as any;
    delete spec.responsive;
    delete spec.analysis;
    delete spec.stats;
    const parsed = WebsiteSpecSchema.safeParse(spec);
    assert.ok(parsed.success);
    assert.equal(parsed.data.stats.sectionCount, 0);
    assert.deepEqual(parsed.data.analysis.warnings, []);
  });

  test("bounds the section count so a runaway plan cannot produce a 200-block page", () => {
    const spec = sampleSpec() as any;
    spec.sections = Array.from({ length: 41 }, (_, i) => ({
      ...spec.sections[0],
      id: `s${i}`,
      order: i,
    }));
    assert.ok(!WebsiteSpecSchema.safeParse(spec).success);
  });
});

describe("coerceKind", () => {
  test("maps the names a model is likely to reach for", () => {
    // These are the words that actually appear in plans. The table is a
    // vocabulary bridge, not a per-site list.
    const cases: [string, string][] = [
      ["hero", "hero"],
      ["Hero", "hero"],
      ["features", "features"],
      ["portfolio", "showcase"],
      ["menu", "menu"],
      ["logos", "logos"],
      ["testimonial", "testimonials"],
      ["pricing", "pricing"],
    ];
    for (const [input, expected] of cases) {
      assert.equal(coerceKind(input), expected, `${input} should coerce to ${expected}`);
    }
  });

  test("strips a layout word off the end of a compound", () => {
    // A model told to pick one of nineteen kinds usually does, but when it
    // describes the layout instead - "feature-grid" - the bare noun is still
    // recoverable. Without this the section silently fell through to "unknown"
    // and rendered as a generic content block.
    const cases: [string, string][] = [
      ["feature-grid", "features"],
      ["pricing-cards", "pricing"],
      ["team-grid", "team"],
      ["stats-row", "stats"],
      ["menu-items", "menu"],
      ["cta-section", "cta"],
      ["featuregridlayout", "features"],
    ];
    for (const [input, expected] of cases) {
      assert.equal(coerceKind(input), expected, `${input} should coerce to ${expected}`);
    }
  });

  test("finds the kind word at either edge of a compound", () => {
    // The trailing word is itself a kind, so the layout loop cannot decompose
    // it; the edge match is what recovers these.
    const cases: [string, string][] = [
      ["hero-banner", "hero"],
      ["logo-wall", "logos"],
      ["testimonial-carousel", "testimonials"],
      ["image-gallery", "gallery"],
      ["pricing-table", "pricing"],
      ["faq-accordion", "faq"],
      ["value-grid", "features"],
    ];
    for (const [input, expected] of cases) {
      assert.equal(coerceKind(input), expected, `${input} should coerce to ${expected}`);
    }
  });

  test("prefers the longest matching kind word", () => {
    // "pricingcards" contains both "pricing" and "cards"; the more specific of
    // the two real concepts has to win.
    assert.equal(coerceKind("pricingcards"), "pricing");
  });

  test("does not match a kind word buried in the middle", () => {
    // Otherwise any string containing "cta" or "art" would claim that kind,
    // which is worse than admitting ignorance.
    assert.equal(coerceKind("spectacular"), "unknown");
    assert.equal(coerceKind("partnernav"), "unknown");
  });

  test("admits when it does not know", () => {
    // The honest answer, and the reason the fallbacks exist: a block that
    // cannot be classified still renders, as a generic content section.
    for (const input of ["wibble", "news-items", "art"]) {
      assert.equal(coerceKind(input), "unknown", `${input} should be unknown`);
    }
  });

  test("falls back to unknown rather than throwing", () => {
    for (const input of [undefined, null, "", "   ", "💥"]) {
      assert.equal(coerceKind(input as any), "unknown");
    }
  });

  test("never returns a kind the schema does not accept", () => {
    // The whole point of the table: whatever comes in, the output is valid.
    for (const input of ["hero", "pricing", "wibble", "Feature Grid", "FAQ", "2 columns"]) {
      assert.ok(
        SECTION_KINDS.includes(coerceKind(input) as any),
        `coerceKind(${JSON.stringify(input)}) escaped the kind list`,
      );
    }
  });
});

describe("prompt vocabulary", () => {
  const prompt = sitePlanSystem();

  test("names every section kind, so the model cannot invent one", () => {
    for (const kind of SECTION_KINDS) {
      assert.ok(prompt.includes(kind), `prompt never mentions the section kind "${kind}"`);
    }
  });

  test("names the exact nav variants the schema accepts", () => {
    for (const variant of ["logo-links", "logo-links-cta", "centered", "minimal", "stacked"]) {
      assert.ok(prompt.includes(variant), `prompt never mentions the nav variant "${variant}"`);
    }
    // The specific invention that cost a wasted call, pinned so it cannot return.
    assert.ok(!prompt.includes("topbar-with-utility-strip"));
  });

  test("names the exact footer variants the schema accepts", () => {
    for (const variant of ["columns", "simple", "centered"]) {
      assert.ok(prompt.includes(variant), `prompt never mentions the footer variant "${variant}"`);
    }
  });

  test("tells the model it never sees the markup", () => {
    // The central architectural claim: the model interprets measurements, it
    // does not transcribe HTML. If this line is dropped, the guarantee is gone.
    assert.match(prompt, /never see the page's HTML|never write code/i);
  });

  test("tells the model that measured text wins over its own", () => {
    // Otherwise it invents plausible filler, which is worse than leaving a gap:
    // a clone containing text that appears nowhere on the original.
    assert.match(prompt, /leave it empty/i);
  });

  test("stays a bounded size", () => {
    // Prompt size is a recurring cost. Anything much over this is a sign that
    // measured data has leaked into the prompt instead of a digest.
    assert.ok(prompt.length < 8000, `plan prompt is ${prompt.length} chars`);
  });
});

describe("PatchSchema", () => {
  test("accepts a multi-op patch", () => {
    const parsed = PatchSchema.safeParse({
      note: "rebrand",
      confidence: "high",
      ops: [
        // A target is a section id, "nav", "footer" or "end" - not an object.
        { op: "setStyle", target: "hero", field: "background", value: "#123456" },
        { op: "setText", target: "hero", field: "heading", value: "Ship it" },
        { op: "setLink", target: "nav", field: "href", index: 0, value: "https://example.com" },
        { op: "removeItem", target: "features", match: "Small" },
      ],
    });
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3), null, 2));
  });

  test("rejects an unknown op rather than ignoring it", () => {
    // Silently dropping an op the model asked for would report success while
    // making no change, which is the worst possible outcome for a tool whose
    // job is to make the change that was requested.
    assert.ok(!PatchSchema.safeParse({ note: "", confidence: "high", ops: [{ op: "deleteEverything" }] }).success);
  });

  test("bounds the op count", () => {
    // A patch is a targeted edit, not a rewrite. An unbounded op count is how a
    // model turns "make the heading blue" into a full re-authoring, so the
    // ceiling is enforced at the schema rather than trusted to the prompt.
    const op = { op: "removeItem", target: "features", match: "Small" };
    assert.ok(!PatchSchema.safeParse({ note: "", confidence: "high", ops: Array(60).fill(op) }).success);
  });

  test("refuses an out-of-range setStyle field", () => {
    // The field list is an enum on purpose: `field` becomes a key on the inline
    // style object, so an arbitrary key would be an arbitrary CSS property.
    assert.ok(
      !PatchSchema.safeParse({
        note: "",
        confidence: "high",
        ops: [{ op: "setStyle", target: "hero", field: "behavior", value: "url(javascript:alert(1))" }],
      }).success,
    );
  });
});
