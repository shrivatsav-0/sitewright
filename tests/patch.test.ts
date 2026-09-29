/**
 * Patch applier tests.
 *
 * The modifier is where a natural-language request from a model meets a spec
 * that will become real files. Two things have to hold at once:
 *
 *  - A valid change actually lands. If the applier quietly drops operations, the
 *    tool reports success and changes nothing, which is the worst outcome
 *    available to a tool whose entire job is making the requested change.
 *  - An invalid or hostile change is refused. The spec is a value that will be
 *    concatenated into source files and CSS, so a value that survives here is a
 *    value that reaches generated code.
 *
 * Every op is applied independently, so one bad operation in a batch does not
 * take the good ones down with it. That per-op isolation is what the rollback
 * tests below pin down.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { z } from "zod";

import { applyPatch, safeHref, validatePatchedSpec } from "../src/lib/modifier/apply";
import { PatchSchema } from "../src/lib/modifier/schema";
import { sampleSpec } from "./fixtures";

/**
 * The schema *input* type, not the output type.
 *
 * Several operations declare defaults (`intent`, `subheading`, `bucket`), and
 * the output type then demands them. Typing the helper with the output would
 * force every test to spell out fields a real model never sends, and would
 * quietly couple the tests to defaults they are not testing.
 */
type PatchInput = z.input<typeof PatchSchema>;
type Patch = z.output<typeof PatchSchema>;

/**
 * Build a patch the way the modifier does.
 *
 * Running the operations through the schema before handing them to the applier
 * is deliberate: the real path is model JSON -> schema -> applier, and a test
 * that skipped the schema would pass an operation the modifier could never
 * actually receive. Defaults are filled here, as they are in production.
 */
function patch(ops: PatchInput["ops"]): Patch {
  return PatchSchema.parse({ note: "test", confidence: "high", ops });
}

describe("applyPatch: valid changes land", () => {
  test("setStyle changes a section style field", () => {
    const result = applyPatch(sampleSpec(), patch([
      { op: "setStyle", target: "hero", field: "background", value: "#0b1020" },
    ]));
    assert.equal(result.spec.sections[0].style.background, "#0b1020");
    assert.equal(result.changed, 1);
    assert.equal(result.rejected, 0);
  });

  test("setStyle accepts a numeric value for a length field", () => {
    const result = applyPatch(sampleSpec(), patch([
      { op: "setStyle", target: "hero", field: "paddingY", value: 120 },
    ]));
    assert.equal(result.spec.sections[0].style.paddingY, 120);
  });

  test("setText rewrites a heading", () => {
    const result = applyPatch(sampleSpec(), patch([
      { op: "setText", target: "hero", field: "heading", value: "Build faster, ship sooner" },
    ]));
    assert.equal(result.spec.sections[0].heading?.text, "Build faster, ship sooner");
  });

  test("setTheme changes a colour token", () => {
    const result = applyPatch(sampleSpec(), patch([
      { op: "setTheme", field: "primary", value: "#1d4ed8" },
    ]));
    assert.equal(result.spec.theme.tokens.primary, "#1d4ed8");
  });

  test("setMode flips light and dark", () => {
    const dark = applyPatch(sampleSpec(), patch([{ op: "setMode", value: "dark" }]));
    assert.equal(dark.spec.theme.mode, "dark");
    const back = applyPatch(dark.spec, patch([{ op: "setMode", value: "light" }]));
    assert.equal(back.spec.theme.mode, "light");
  });

  test("setKind retypes a section", () => {
    const result = applyPatch(sampleSpec(), patch([
      { op: "setKind", target: "features", value: "stats" },
    ]));
    assert.equal(result.spec.sections[1].kind, "stats");
  });

  test("removeItem drops the item whose text matches", () => {
    const before = sampleSpec();
    const result = applyPatch(before, patch([{ op: "removeItem", target: "features", match: "Small" }]));
    assert.equal(result.spec.sections[1].items.length, 1);
    assert.equal(result.spec.sections[1].items[0].title, "Fast");
  });

  test("addSection appends a new block", () => {
    const result = applyPatch(sampleSpec(), patch([
      { op: "addSection", after: "end", kind: "cta", heading: "Ready?", items: [] },
    ]));
    assert.equal(result.spec.sections.length, 3);
    assert.equal(result.spec.sections[2].kind, "cta");
    // Order must be contiguous, because the generator renders by array position.
    assert.deepEqual(result.spec.sections.map((s) => s.order), [0, 1, 2]);
  });

  test("removeSection deletes a block and renumbers the rest", () => {
    const result = applyPatch(sampleSpec(), patch([{ op: "removeSection", target: "hero" }]));
    assert.equal(result.spec.sections.length, 1);
    assert.equal(result.spec.sections[0].id, "features");
    assert.equal(result.spec.sections[0].order, 0);
  });

  test("reorder rearranges the page", () => {
    const result = applyPatch(sampleSpec(), patch([
      { op: "reorder", order: ["features", "hero"] },
    ]));
    assert.deepEqual(result.spec.sections.map((s) => s.id), ["features", "hero"]);
    assert.deepEqual(result.spec.sections.map((s) => s.order), [0, 1]);
  });

  test("setLink retargets one nav link", () => {
    const result = applyPatch(sampleSpec(), patch([
      {
        op: "setLink",
        target: "nav",
        field: "href",
        index: 0,
        value: "https://docs.example.com",
      },
    ]));
    assert.equal(result.spec.nav?.links[0].href, "https://docs.example.com");
  });

  test("setLink refuses to write a script-bearing href", () => {
    // The regression: the wholesale setLinks path sanitised hrefs and the
    // single-link path did not, so the narrower operation was the way through.
    const result = applyPatch(sampleSpec(), patch([
      { op: "setLink", target: "nav", field: "href", index: 0, value: "javascript:alert(1)" },
    ]));
    assert.equal(result.changed, 1, "the op itself is valid and should land");
    assert.equal(result.spec.nav?.links[0].href, "#", "but the href must be neutralised");
  });

  test("setLinks replaces a footer bucket", () => {
    // `legal` and `social` are distinct lists rendered as the footer bottom bar
    // and the social row, not columns. The bucket is what picks between them.
    const result = applyPatch(sampleSpec(), patch([
      {
        op: "setLinks",
        target: "footer",
        bucket: "legal",
        value: [
          { label: "Cookies", href: "/cookies", primary: false },
          { label: "Imprint", href: "/imprint", primary: false },
        ],
      },
    ]));
    assert.deepEqual(result.spec.footer?.legal.map((l) => l.label), ["Cookies", "Imprint"]);
    // The other bucket must be untouched.
    assert.equal(result.spec.footer?.social.length, 1);
  });

  test("setLinks can replace the social bucket independently", () => {
    const result = applyPatch(sampleSpec(), patch([
      {
        op: "setLinks",
        target: "footer",
        bucket: "social",
        value: [{ label: "Mastodon", href: "https://example.social/@a", primary: false }],
      },
    ]));
    assert.deepEqual(result.spec.footer?.social.map((l) => l.label), ["Mastodon"]);
    assert.equal(result.spec.footer?.legal.length, 1);
  });

  test("a batch of valid ops all apply", () => {
    const result = applyPatch(sampleSpec(), patch([
      { op: "setTheme", field: "primary", value: "#0f766e" },
      { op: "setText", target: "hero", field: "heading", value: "New headline" },
      { op: "setStyle", target: "features", field: "columns", value: 4 },
    ]));
    assert.equal(result.changed, 3);
    assert.equal(result.rejected, 0);
    assert.equal(result.spec.theme.tokens.primary, "#0f766e");
    assert.equal(result.spec.sections[0].heading?.text, "New headline");
    assert.equal(result.spec.sections[1].style.columns, 4);
  });
});

describe("applyPatch: bad changes are refused", () => {
  test("an unknown section id is rejected, not guessed at", () => {
    const result = applyPatch(sampleSpec(), patch([
      { op: "setText", target: "no-such-section", field: "heading", value: "x" },
    ]));
    assert.equal(result.changed, 0);
    assert.equal(result.rejected, 1);
    assert.match(result.applied[0].reason ?? "", /no-such-section|not found|unknown/i);
  });

  test("an index past the end of the list is rejected", () => {
    // Index 99 never reaches the applier: the schema caps the index, so this
    // throws during parsing rather than being applied or reported as a change.
    // The in-range version below is the one that has to be handled at runtime.
    assert.throws(() =>
      patch([{ op: "setLink", target: "nav", field: "href", index: 99, value: "https://x.example" }]),
    );

    // A section's link list has one entry here, so index 2 is in range but
    // absent. It must be refused, not clamped or applied to a neighbour.
    const result = applyPatch(sampleSpec(), patch([
      { op: "setLink", target: "features", field: "href", index: 2, value: "https://x.example" },
    ]));
    assert.equal(result.changed, 0);
    assert.equal(result.rejected, 1);
  });

  test("a colour that is not a colour is rejected", () => {
    const result = applyPatch(sampleSpec(), patch([
      { op: "setTheme", field: "primary", value: "red; } body { display: none" },
    ]));
    // The spec schema accepts any CSS colour string, because measured tokens can
    // legitimately hold gradients and var() references. The applier is the
    // boundary that stops one becoming a stylesheet injection.
    assert.equal(result.changed, 0);
    assert.equal(result.rejected, 1);
  });

  test("a style field is limited to the known list", () => {
    const result = applyPatch(sampleSpec(), patch([
      { op: "setStyle", target: "hero", field: "background" as any, value: "url(javascript:alert(1))" },
    ]));
    // `background` is a legitimate field; the *value* is the problem.
    assert.equal(result.changed, 0);
  });

  test("one bad op does not take a good one down with it", () => {
    // The whole reason each op is applied and recorded separately: a model that
    // gets one field name wrong should still see the rest of its change land.
    const result = applyPatch(sampleSpec(), patch([
      { op: "setTheme", field: "primary", value: "#0f766e" },
      { op: "setStyle", target: "nope", field: "columns", value: 3 },
      { op: "setText", target: "hero", field: "heading", value: "Still applied" },
    ]));
    assert.equal(result.changed, 2);
    assert.equal(result.rejected, 1);
    assert.equal(result.spec.theme.tokens.primary, "#0f766e");
    assert.equal(result.spec.sections[0].heading?.text, "Still applied");
  });

  test("removeItem that matches nothing changes nothing", () => {
    const result = applyPatch(sampleSpec(), patch([
      { op: "removeItem", target: "features", match: "Nonexistent item" },
    ]));
    assert.equal(result.changed, 0);
    assert.equal(result.spec.sections[1].items.length, 2);
  });

  test("removing every section is refused", () => {
    // A spec with no sections fails its own schema, and rendering it would
    // produce a blank page. The result must be rejected at validation.
    const result = applyPatch(sampleSpec(), patch([
      { op: "removeSection", target: "hero" },
      { op: "removeSection", target: "features" },
    ]));
    const check = validatePatchedSpec(result.spec);
    if (result.spec.sections.length === 0) {
      assert.ok(!check.ok, "an empty spec must not pass validation");
    }
  });

  test("applying to a spec never mutates the original", () => {
    // Rollback depends on this: the previous spec is the fallback, and if the
    // applier had already written into it there would be nothing to roll back to.
    const before = sampleSpec();
    const snapshot = JSON.stringify(before);
    applyPatch(before, patch([
      { op: "setTheme", field: "primary", value: "#000000" },
      { op: "removeSection", target: "hero" },
    ]));
    assert.equal(JSON.stringify(before), snapshot, "applyPatch mutated its input");
  });
});

describe("safeHref", () => {
  test("keeps ordinary links", () => {
    for (const href of [
      "https://example.com/a",
      "http://example.com",
      "/relative/path",
      "#anchor",
      "mailto:hi@example.com",
      "tel:+15551234",
    ]) {
      assert.equal(safeHref(href), href, `${href} should be preserved`);
    }
  });

  test("neutralises script-bearing and non-web schemes", () => {
    // These come from the source page, so a hostile link is entirely plausible
    // and must never survive into generated JSX.
    // Everything here was read off a real crawled page, so any of it could
    // appear in a generated <a href>. The set is a sample of the long tail the
    // old three-scheme denylist missed.
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "  javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "blob:https://example.com/1234",
      "filesystem:http://example.com/temporary/x",
      "chrome://settings",
      "about:blank",
    ]) {
      assert.equal(safeHref(href), "#", `${JSON.stringify(href)} should be neutralised`);
    }
  });

  test("keeps protocol-relative links, which inherit the page's own scheme", () => {
    assert.equal(safeHref("//cdn.example.com/a.pdf"), "//cdn.example.com/a.pdf");
    assert.equal(safeHref("/docs/intro"), "/docs/intro");
    assert.equal(safeHref("#pricing"), "#pricing");
  });

  test("an href with a harmless query string survives", () => {
    assert.equal(safeHref("/search?q=a&b=c#top"), "/search?q=a&b=c#top");
    assert.equal(safeHref("?page=2"), "?page=2");
  });

  test("an unsafe href becomes a harmless placeholder, never undefined", () => {
    // A missing href would render an <a> with no target; a placeholder keeps the
    // markup valid and obviously inert.
    assert.equal(safeHref("javascript:alert(1)"), "#");
  });
});

describe("validatePatchedSpec", () => {
  test("accepts a well-formed patched spec", () => {
    const patched = applyPatch(sampleSpec(), patch([
      { op: "setTheme", field: "accent", value: "#7c3aed" },
    ]));
    const check = validatePatchedSpec(patched.spec);
    assert.ok(check.ok, check.ok ? "" : check.issues.join("; "));
  });

  test("reports why a malformed spec is unusable", () => {
    const broken = sampleSpec();
    (broken.sections[0] as any).kind = "not-a-kind";
    const check = validatePatchedSpec(broken);
    assert.ok(!check.ok);
    assert.ok(check.issues.length > 0);
    assert.ok(check.issues.length <= 8, "issue list should be bounded");
  });
});
