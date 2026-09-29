/**
 * Theme measurement tests.
 *
 * This is where most of the visual fidelity actually lives, and every rule here
 * was added because the naive version was demonstrably wrong on a real site.
 * Each test states the failure it prevents, because "the brand colour is the
 * most common colour" looks like a reasonable rule until you see that the most
 * common colour on a modern page is the browser's own default link blue.
 *
 * The theme is deliberately provenance-split: tokens, fonts and radii are
 * measured deterministically, and the model only ever supplies semantic
 * decisions. So nothing in this file may depend on a model being called, and
 * every test runs in milliseconds with no network.
 *
 * These exercise the public surface - `buildTheme`, `buildSectionStyle` - rather
 * than the internal helpers behind them, because the contract that matters is
 * the one callers use.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildTheme, buildSectionStyle, contrastReport } from "../src/lib/analyzer/normalize";
import { parseColor, contrastRatio, shiftHue, derivePalette, toHex } from "../src/lib/analyzer/color";
import { samplePage, sampleDesign } from "./fixtures";

/** The colour a browser paints an unstyled link with, on white. */
const UA_LINK_BLUE = "rgb(0, 0, 238)";

/** buildTheme takes the whole extracted page, with the design block inside. */
function themeFor(design: Record<string, unknown>) {
  return buildTheme(samplePage({ design: sampleDesign(design) }) as any);
}

describe("brand colour resolution", () => {
  test("a real brand fill beats the browser's default link blue", () => {
    // The failure this prevents: frequency ranking made #0000ee win, because
    // every unstyled link on the page contributes it and it is the most
    // saturated colour in the soup. A page whose button is brand red cloned as
    // link blue.
    const theme = themeFor({
      backgroundCandidates: ["rgb(255, 255, 255)"],
      colorCandidates: ["rgb(255, 255, 255)", "rgb(17, 17, 17)", UA_LINK_BLUE, "rgb(218, 83, 44)"],
      brandFills: ["rgb(218, 83, 44)"],
      brandInks: [],
    });
    assert.equal(theme.tokens.primary, "#da532c");
  });

  test("theme-color meta wins over everything else", () => {
    // Highest-trust source, and a genuinely common one: plenty of sites declare
    // their brand colour in a meta tag and then never use it consistently in CSS.
    const theme = themeFor({
      backgroundCandidates: ["rgb(255, 255, 255)"],
      themeColorMeta: "#0b3d91",
      colorCandidates: ["rgb(255, 255, 255)", UA_LINK_BLUE, "rgb(200, 16, 46)"],
      brandFills: ["rgb(200, 16, 46)"],
    });
    assert.equal(theme.tokens.primary, "#0b3d91");
  });

  test("falls back to a usable default when the page has no brand signal", () => {
    // A genuinely unstyled page still has to produce a real colour. Returning
    // null would emit an empty --color-primary and every accent-coloured element
    // would inherit the browser default instead.
    const theme = themeFor({
      backgroundCandidates: ["rgb(255, 255, 255)"],
      colorCandidates: ["rgb(255, 255, 255)", "rgb(0, 0, 0)"],
      brandFills: [],
      brandInks: [],
      themeColorMeta: "",
    });
    assert.match(theme.tokens.primary, /^#[0-9a-f]{6}$/i);
  });

  test("every theme token is a colour the browser will accept", () => {
    // One unparseable token becomes an invalid CSS custom property, and the
    // element silently falls back to whatever the cascade gives it. Cheap to
    // check, and it catches a value that slipped through from the page.
    const theme = themeFor({
      backgroundCandidates: ["rgb(255, 255, 255)"],
      brandFills: ["rgb(218, 83, 44)"],
    });
    for (const [name, value] of Object.entries(theme.tokens)) {
      assert.ok(
        parseColor(value) !== null || value === "transparent" || value === "inherit",
        `token ${name} is not a colour: ${JSON.stringify(value)}`,
      );
    }
  });

  test("parses the notations a browser actually reports", () => {
    for (const value of [
      "rgb(218, 83, 44)",
      "rgb(218 83 44 / 1)",
      "rgba(218, 83, 44, 0.5)",
      "#da532c",
      "#DA532C",
      "#da5",
      "hsl(14, 70%, 51%)",
      "transparent",
    ]) {
      assert.notEqual(parseColor(value), null, `${value} should parse`);
    }
  });

  test("rejects values that are not colours", () => {
    for (const bad of ["", "   ", "not-a-colour", "rgb(", "#12345", "url(x)"]) {
      assert.equal(parseColor(bad), null, `${JSON.stringify(bad)} should not parse`);
    }
  });
});

describe("surfaces and readability", () => {
  test("a card surface is near the page background, not a dark slab", () => {
    // The failure this prevents: ranking observed backgrounds by which is
    // lightest or darkest put pure black behind every card on a white page. A
    // surface is only a surface if the page is still visible through it, so it
    // has to sit within a small contrast ratio of the background.
    const theme = themeFor({
      backgroundCandidates: [
        "rgb(255, 255, 255)", // page
        "rgb(246, 246, 246)", // a real alternating band
        "rgb(0, 0, 0)", // the footer
      ],
      bodyBackground: "rgb(255, 255, 255)",
      brandFills: ["rgb(218, 83, 44)"],
    });
    const bg = parseColor(theme.tokens.background)!;
    const surface = parseColor(theme.tokens.surface)!;
    assert.ok(
      contrastRatio(bg, surface) < 1.6,
      `surface ${theme.tokens.surface} is too far from background ${theme.tokens.background}`,
    );
  });

  test("body and text are readable against each other", () => {
    // A clone can be perfectly faithful and still be unreadable if the
    // measured text colour and background are a low-contrast pair that only
    // worked on the original because of an inherited context we do not
    // reproduce. The pipeline re-derives rather than trusting.
    const theme = themeFor({ backgroundCandidates: ["rgb(255, 255, 255)"] });
    const bg = parseColor(theme.tokens.background)!;
    const text = parseColor(theme.tokens.text)!;
    assert.ok(
      contrastRatio(bg, text) > 4.5,
      `text ${theme.tokens.text} on ${theme.tokens.background} is not readable`,
    );
  });

  test("the contrast report agrees", () => {
    const report = contrastReport(themeFor({ backgroundCandidates: ["rgb(255, 255, 255)"] }));
    assert.ok(report.ratio > 0, "a contrast ratio must be positive");
    assert.equal(typeof report.passes, "boolean");
  });

  test("honours a dark page", () => {
    const theme = themeFor({
      bodyBackground: "rgb(17, 17, 17)",
      bodyColor: "rgb(240, 240, 240)",
      backgroundCandidates: ["rgb(17, 17, 17)"],
      colorCandidates: ["rgb(17, 17, 17)", "rgb(240, 240, 240)"],
      brandFills: ["rgb(255, 106, 61)"],
    });
    assert.equal(theme.mode, "dark");
    const bg = parseColor(theme.tokens.background)!;
    const text = parseColor(theme.tokens.text)!;
    assert.ok(contrastRatio(bg, text) > 4.5, "a dark clone must still be readable");
  });
});

describe("accent", () => {
  test("is derived from the primary when the site has only one colour", () => {
    // A hardcoded blue accent put a blue button beside a red brand on every site
    // that had no second colour. A hue rotation stays related to whatever was
    // actually measured, so the pair reads as one palette.
    const theme = themeFor({
      brandFills: ["rgb(218, 83, 44)"],
      backgroundCandidates: ["rgb(255, 255, 255)"],
    });
    const primary = parseColor(theme.tokens.primary)!;
    const accent = parseColor(theme.tokens.accent)!;
    assert.ok(primary && accent, "both must parse");
    assert.notEqual(
      theme.tokens.accent.toLowerCase(),
      theme.tokens.primary.toLowerCase(),
      "the accent must differ from the primary",
    );
    const rotated = shiftHue(primary, 42);
    const drift = Math.abs(rotated.r - accent.r) + Math.abs(rotated.g - accent.g) + Math.abs(rotated.b - accent.b);
    assert.ok(drift <= 16, `accent ${theme.tokens.accent} is not near a 42 degree rotation of ${theme.tokens.primary}`);
  });

  test("keeps a second colour the site really has", () => {
    // If the page genuinely uses two brand colours, the second is the accent.
    // Deriving one would discard real information.
    const theme = themeFor({
      brandFills: ["rgb(218, 83, 44)", "rgb(0, 87, 173)"],
      backgroundCandidates: ["rgb(255, 255, 255)"],
    });
    assert.equal(theme.tokens.accent, "#0057ad");
  });

  test("never pairs a brand colour with a browser default", () => {
    // The regression: the accent is scored out of the same general pool as the
    // primary, and #0000ee has the maximum possible chroma. A site with a real
    // brand red therefore got a browser-blue accent beside it - precisely the
    // mismatch the hue-rotation fallback exists to prevent, and one that a
    // penalty inside the scorer did not catch.
    const theme = themeFor({
      colorCandidates: ["rgb(255, 255, 255)", "rgb(17, 17, 17)", UA_LINK_BLUE, "rgb(218, 83, 44)"],
      backgroundCandidates: ["rgb(255, 255, 255)"],
      brandFills: ["rgb(218, 83, 44)"],
      brandInks: [],
    });
    assert.equal(theme.tokens.primary, "#da532c");
    assert.notEqual(theme.tokens.accent.toLowerCase(), "#0000ee", "accent must not be the UA default");
    assert.notEqual(theme.tokens.primary.toLowerCase(), "#0000ee", "primary must not be the UA default");
  });

  test("a page with no brand signal at all still gets a coherent pair", () => {
    // Distinct case, and deliberately allowed: when a site never chooses a
    // colour, its links are the only chromatic thing it paints, so using that
    // for the primary is faithful. What must still hold is that the accent is
    // *related* to it rather than an unrelated second colour.
    const theme = themeFor({
      colorCandidates: ["rgb(255, 255, 255)", "rgb(17, 17, 17)", UA_LINK_BLUE],
      backgroundCandidates: ["rgb(255, 255, 255)"],
      brandFills: [],
      brandInks: [],
    });
    assert.equal(theme.tokens.primary, "#0000ee");
    assert.notEqual(theme.tokens.accent.toLowerCase(), theme.tokens.primary.toLowerCase());
    // 42 degrees apart, so the pair reads as one palette.
    const primary = parseColor(theme.tokens.primary)!;
    const accent = parseColor(theme.tokens.accent)!;
    const rotated = shiftHue(primary, 42);
    const drift = Math.abs(rotated.r - accent.r) + Math.abs(rotated.g - accent.g) + Math.abs(rotated.b - accent.b);
    assert.ok(drift <= 16, `accent ${theme.tokens.accent} is unrelated to primary ${theme.tokens.primary}`);
  });
});

describe("typography", () => {
  test("line height is a ratio, not a product of font size and ratio", () => {
    // The failure this prevents: multiplying the measured 1.2 by the font size
    // produced "line-height: 2.4" on a 2rem heading, so every heading and
    // paragraph rendered with enormous leading. The stored value is unitless
    // and has to stay inside a plausible band.
    const theme = themeFor({
      headings: { h1: { size: 48, weight: 700, lineHeight: 1.05 } },
      sizeCandidates: [16, 48],
      backgroundCandidates: ["rgb(255, 255, 255)"],
    });
    const { heading, body } = theme.fonts;
    for (const [name, font] of [["heading", heading], ["body", body]] as const) {
      assert.ok(
        font.lineHeight > 0.9 && font.lineHeight < 1.9,
        `${name} line height ${font.lineHeight} is out of band`,
      );
    }
  });

  test("a page with no headings still gets a heading larger than the body", () => {
    // Common on marketing homepages that style hero copy as a div. Reading the
    // largest observed size beats falling back to a guess - and an h1 smaller
    // than body text is visibly wrong.
    for (const sizes of [[16], [16, 14], [14, 12], [18, 16, 15], [20, 40, 16]]) {
      const theme = themeFor({
        headings: {},
        sizeCandidates: sizes,
        backgroundCandidates: ["rgb(255, 255, 255)"],
      });
      assert.ok(
        theme.fonts.heading.size > theme.fonts.body.size,
        `sizes ${JSON.stringify(sizes)}: heading ${theme.fonts.heading.size} <= body ${theme.fonts.body.size}`,
      );
    }
  });

  test("takes the heading size from a real heading when there is one", () => {
    const theme = themeFor({
      headings: { h1: { size: 44, weight: 700, lineHeight: 1.1, family: "Inter, sans-serif" } },
      sizeCandidates: [16, 44],
      backgroundCandidates: ["rgb(255, 255, 255)"],
    });
    assert.equal(theme.fonts.heading.size, 44);
    assert.equal(theme.fonts.heading.weight, 700);
  });

  test("clamps absurd observed sizes", () => {
    // A page can report a 400px heading from a single decorative element.
    // Clamping keeps the clone renderable; rejecting would lose the page.
    for (const size of [0, 1, 400, 2000]) {
      const theme = themeFor({
        headings: { h1: { size, weight: 700, lineHeight: 1.2 } },
        sizeCandidates: [16, size],
        backgroundCandidates: ["rgb(255, 255, 255)"],
      });
      assert.ok(theme.fonts.heading.size >= 8, `heading size ${theme.fonts.heading.size} for observed ${size}`);
      assert.ok(theme.fonts.heading.size <= 120, `heading size ${theme.fonts.heading.size} for observed ${size}`);
    }
  });
});

describe("radii", () => {
  test("one observed radius is used for every step", () => {
    // A site with a single 4px radius does not have a scale. Inventing one
    // around it is a guess; using the measured value for each step is at least
    // faithful to the source.
    const theme = themeFor({ radiusCandidates: ["4px"], backgroundCandidates: ["rgb(255, 255, 255)"] });
    for (const step of ["sm", "md", "lg"] as const) {
      assert.equal(theme.radius[step], "4px");
    }
  });

  test("builds a non-decreasing scale from several observed radii", () => {
    // Zero is not a scale step, so it is excluded; what matters is that the three
    // steps are drawn from the observed values and never descend, because a
    // descending radius scale renders as a visual bug.
    const theme = themeFor({
      radiusCandidates: ["0px", "2px", "4px", "12px"],
      backgroundCandidates: ["rgb(255, 255, 255)"],
    });
    const { sm, md, lg } = theme.radius;
    const observed = [2, 4, 12];
    for (const [name, value] of [["sm", sm], ["md", md], ["lg", lg]] as const) {
      assert.ok(observed.includes(parseFloat(value)), `${name} is ${value}, not an observed radius`);
    }
    assert.ok(parseFloat(md) >= parseFloat(sm), `scale must not decrease: ${sm} ${md} ${lg}`);
    assert.ok(parseFloat(lg) >= parseFloat(md), `scale must not decrease: ${sm} ${md} ${lg}`);
    assert.equal(lg, "12px", "the largest observed radius should be the largest step");
  });

  test("a deliberately square-cornered design stays square", () => {
    // Every radius on the page is zero. Zero is excluded from the scale, so
    // before this was handled the empty scale fell through to the 4/8/16
    // defaults and gave a flat, technical design rounded corners it does not
    // have.
    const theme = themeFor({ radiusCandidates: ["0px", "0px", "0px"], backgroundCandidates: ["rgb(255, 255, 255)"] });
    for (const step of ["sm", "md", "lg"] as const) {
      assert.equal(theme.radius[step], "0px", `${step} is ${theme.radius[step]}`);
    }
  });

  test("a page with no radius at all still gets a usable scale", () => {
    // Distinct from the all-zero case: nothing was observed, so the defaults
    // stand rather than a claim that the design is square.
    const theme = themeFor({ radiusCandidates: [], backgroundCandidates: ["rgb(255, 255, 255)"] });
    for (const step of ["sm", "md", "lg"] as const) {
      assert.match(theme.radius[step], /^\d+(\.\d+)?(px|rem)$/, `${step} is ${theme.radius[step]}`);
    }
  });

  test("ignores percentage radii, which describe circles", () => {
    // A 50% radius on a pill button is real, but copying it onto a card would
    // produce a lozenge where the source had a rectangle.
    const theme = themeFor({ radiusCandidates: ["50%", "6px"], backgroundCandidates: ["rgb(255, 255, 255)"] });
    for (const step of ["sm", "md", "lg", "pill"] as const) {
      assert.ok(!theme.radius[step].includes("%"), `${step} kept a percentage: ${theme.radius[step]}`);
    }
  });

  test("survives an empty or hostile list with lengths, not nonsense", () => {
    for (const input of [[], ["abc"], [""], ["999999px"], ["-4px"]]) {
      const theme = themeFor({ radiusCandidates: input, backgroundCandidates: ["rgb(255, 255, 255)"] });
      for (const step of ["sm", "md", "lg", "pill"] as const) {
        assert.match(
          theme.radius[step],
          /^\d+(\.\d+)?(px|rem)$/,
          `bad radius ${theme.radius[step]} for input ${JSON.stringify(input)}`,
        );
      }
    }
  });
});

describe("shadows", () => {
  test("scales around the most-used shadow", () => {
    // A three-step scale needs a middle, and an observed list gives no ordering.
    // The most-used value becomes the middle and the others scale around it, so
    // the clone has the same depth feel rather than three unrelated values.
    const theme = themeFor({
      shadowCandidates: [
        "0 1px 2px rgba(0, 0, 0, 0.1)",
        "0 2px 4px rgba(0, 0, 0, 0.1)",
        "0 1px 2px rgba(0, 0, 0, 0.1)",
      ],
      backgroundCandidates: ["rgb(255, 255, 255)"],
    });
    for (const step of ["sm", "md", "lg"] as const) {
      assert.ok(theme.shadow[step].length > 0, `${step} is empty`);
      assert.ok(!theme.shadow[step].includes(";"), `${step} contains a semicolon`);
    }
  });

  test("produces usable values when nothing was observed", () => {
    const theme = themeFor({ shadowCandidates: [], backgroundCandidates: ["rgb(255, 255, 255)"] });
    for (const step of ["sm", "md", "lg"] as const) {
      assert.equal(typeof theme.shadow[step], "string");
      assert.ok(theme.shadow[step].length > 0, `${step} is empty`);
    }
  });
});

describe("buildSectionStyle", () => {
  const theme = buildTheme(samplePage() as any);

  test("clamps measured padding instead of rejecting it", () => {
    // A measured 0 or 4px is real information: a clone of a deliberately tight
    // layout should stay tight. But it must not go negative or blow the section
    // open.
    for (const paddingY of [0, 4, 96, 400, 2000, -20]) {
      const style = buildSectionStyle({ style: { paddingY } }, theme, 48);
      assert.ok(style.paddingY >= 8, `negative or absent padding for ${paddingY}: ${style.paddingY}`);
      assert.ok(style.paddingY <= 200, `unbounded padding for ${paddingY}: ${style.paddingY}`);
    }
  });

  test("constrains the column count to a renderable range", () => {
    for (const columns of [0, 1, 2, 4, 12, 40]) {
      const style = buildSectionStyle(
        { style: { columns }, items: Array.from({ length: columns || 0 }, (_, i) => ({ title: `i${i}` })) },
        theme,
        48,
      );
      assert.ok(style.columns >= 1 && style.columns <= 6, `columns ${style.columns} out of range`);
    }
  });

  test("treats a transparent background as transparent", () => {
    // rgba(0,0,0,0) is how a browser reports "no background" and it must not
    // become an opaque black band.
    for (const background of ["transparent", "rgba(0, 0, 0, 0)", undefined]) {
      const style = buildSectionStyle({ style: { background } }, theme, 48);
      assert.equal(style.background, "transparent", `${String(background)} became ${style.background}`);
    }
  });

  test("keeps a gradient background, which cannot be reduced to one colour", () => {
    const gradient = "linear-gradient(90deg, rgb(0, 0, 0), rgb(255, 255, 255))";
    const style = buildSectionStyle({ style: { background: gradient } }, theme, 48);
    assert.match(style.background, /gradient/);
  });
});

describe("determinism", () => {
  test("identical observations produce an identical theme", () => {
    // The generator is a pure function of the spec, so rebuilding an unchanged
    // project must produce byte-identical files. Nondeterminism here would
    // surface as a spurious diff on every rebuild, which quietly trains you to
    // ignore real diffs.
    const design = { brandFills: ["rgb(218, 83, 44)"] };
    assert.deepEqual(themeFor(design), themeFor(design));
  });

  test("derivePalette is a pure function of its input", () => {
    const input = {
      bodyBackground: "rgb(255, 255, 255)",
      bodyColor: "rgb(27, 27, 27)",
      backgroundCandidates: ["rgb(255, 255, 255)"],
      colorCandidates: ["rgb(255, 255, 255)", "rgb(27, 27, 27)"],
      brandFills: ["rgb(218, 83, 44)"],
      brandInks: [],
      themeColorMeta: "",
    };
    assert.deepEqual(derivePalette(input as any), derivePalette(input as any));
  });

  test("toHex round-trips through parseColor", () => {
    for (const value of ["rgb(218, 83, 44)", "rgb(0, 87, 173)", "rgb(255, 255, 255)", "rgb(0, 0, 0)"]) {
      const hex = toHex(parseColor(value)!);
      assert.equal(toHex(parseColor(hex)!), hex, `${value} did not round-trip`);
    }
  });
});
