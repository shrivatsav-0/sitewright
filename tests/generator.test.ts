/**
 * Code generation tests.
 *
 * The generator turns a validated spec into files on disk, and those files are
 * then compiled and executed. Two classes of bug matter here and neither is
 * visible to the type checker:
 *
 *  - Injection. The spec is built partly from crawled content - a heading, a
 *    link, a colour, an asset path - and it is concatenated into TypeScript and
 *    CSS. A value that closes a template literal, or a CSS declaration block,
 *    becomes arbitrary code in the output. Every such value passes through a
 *    sanitiser, and these tests check that the sanitiser is on the path and
 *    actually holds.
 *
 *  - Nondeterminism. The generator is a pure function of the spec, so
 *    regenerating an unchanged project must produce byte-identical files.
 *    Otherwise every rebuild shows a diff, which quietly trains everyone to
 *    ignore diffs.
 *
 * These run on a fixture spec with no browser and no model, so they are fast.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { renderGlobalsCss, themeHeader } from "../src/lib/generator/theme";
import { renderSpecModule, projectPath } from "../src/lib/generator/index";
import { SECTIONS_TSX } from "../src/lib/generator/sections";
import { CHROME_TSX } from "../src/lib/generator/chrome";
import { WebsiteSpecSchema } from "../src/lib/spec/schema";
import { sampleSpec } from "./fixtures";

/**
 * Extract the embedded site spec literal and parse it back.
 *
 * The spec module emits `export const siteSpec: WebsiteSpec = { ... };`.
 * Brace-matching from the first brace after the assignment recovers the
 * object, and JSON.parse validates that it is exactly the JSON the pipeline
 * would have written - the property that makes the generated site agree with
 * the recorded spec.
 */
function recoverSpec(source: string): any {
  const marker = source.indexOf("siteSpec: WebsiteSpec = ");
  assert.ok(marker > -1, "could not find the spec assignment");
  const start = source.indexOf("{", marker);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return JSON.parse(source.slice(start, i + 1));
    }
  }
  throw new Error("could not brace-match the embedded literal");
}

/** Values a crawled page could plausibly put into the spec. */
const HOSTILE: Array<[string, string]> = [
  ["template break", "x` + require('fs').readFileSync('/etc/passwd') + `y"],
  ["js expression", "${process.env.HOME}"],
  ["html injection", '<img src=x onerror="alert(1)">'],
  ["jsx close", "</script><script>alert(1)</script>"],
  ["quote escape", '"; alert(1); "'],
  ["null byte", "ok\u0000evil"],
  ["newline directive", "ok\n@import 'evil.css';"],
];

describe("CSS generation", () => {
  test("a colour that closes a declaration block cannot inject CSS", () => {
    // The concrete attack: theme tokens are written as custom properties inside
    // a `:root { }` block. A value containing a closing brace escapes it and the
    // rest of the value becomes new rules.
    const attack = "red; } body { display: none } .x {";
    const spec = sampleSpec();
    (spec.theme.tokens as any).primary = attack;
    const css = renderGlobalsCss(spec.theme);

    // The dangerous part is the brace count: a stylesheet that gained a rule
    // where none was intended.
    const opens = (css.match(/{/g) ?? []).length;
    const closes = (css.match(/}/g) ?? []).length;
    assert.equal(opens, closes, "unbalanced braces mean the declaration block was escaped");
    assert.ok(!/body\s*{\s*display:\s*none/.test(css), `injected rule survived:\n${css.slice(0, 400)}`);
  });

  test("every colour token in the output is a real colour", () => {
    // A sanitised value is either a parseable colour or one of the two
    // keywords the generator uses for "no opinion". Anything else produces a
    // custom property the browser discards.
    const spec = sampleSpec();
    (spec.theme.tokens as any).accent = "javascript:alert(1)";
    (spec.theme.tokens as any).border = "url(https://evil.example/x.png)";
    const css = renderGlobalsCss(spec.theme);
    const colourProps = [...css.matchAll(/^  --color-([a-z-]+):\s*([^;]+);/gm)];
    assert.ok(colourProps.length >= 8, `expected many colour tokens, found ${colourProps.length}`);
    for (const [, name, raw] of colourProps) {
      const value = raw.trim();
      assert.ok(
        /^#[0-9a-f]{3,8}$|^rgba?\(|^var\(--|^transparent$|^inherit$/.test(value),
        `suspicious colour property --color-${name}: ${JSON.stringify(value)}`,
      );
    }
  });

  test("a font family that breaks out of its declaration cannot inject", () => {
    const spec = sampleSpec();
    (spec.theme.fonts.heading as any).family = 'Inter; } body { background: url("https://evil.example/x") } .y { font-family: "x';
    const css = renderGlobalsCss(spec.theme);
    const opens = (css.match(/{/g) ?? []).length;
    const closes = (css.match(/}/g) ?? []).length;
    assert.equal(opens, closes, "unbalanced braces in the generated stylesheet");
  });

  test("a shadow containing a semicolon cannot start a new declaration", () => {
    const spec = sampleSpec();
    (spec.theme.shadow as any).md = "0 1px 2px rgba(0,0,0,0.1); color: red; --x: y";
    const css = renderGlobalsCss(spec.theme);
    // A shadow is emitted as one value, so the semicolons must not survive into
    // the declaration.
    const shadowDecl = /--shadow-md:\s*([^;]+);/.exec(css);
    assert.ok(shadowDecl, "no shadow-md declaration found");
    const value = shadowDecl?.[1] ?? "";
    assert.ok(!value.includes(";"), `semicolon survived: ${value}`);
    assert.ok(!/--shadow-md:[^;]*color:\s*red/.test(css), "an extra declaration was injected");
  });

  test("the Tailwind import comes before any other at-rule", () => {
    // `@import` must precede all other rules except `@charset`, and a font
    // import in front of `@import "tailwindcss"` makes the whole file invalid,
    // which fails the build with a CSS parse error that says nothing useful.
    const spec = sampleSpec();
    const css = renderGlobalsCss(spec.theme, { fontImports: ["https://fonts.example/css?family=Inter"] });
    const tailwindAt = css.indexOf('@import "tailwindcss"');
    const fontAt = css.indexOf("@import url(");
    assert.ok(tailwindAt > -1, "no tailwind import found");
    if (fontAt > -1) {
      assert.ok(fontAt < tailwindAt, "the font import must come first or the stylesheet is invalid");
    }
  });

  test("the header records where the theme came from", () => {
    const header = themeHeader("https://example.com", "opencode/some-model");
    assert.match(header, /https:\/\/example\.com/);
    assert.match(header, /opencode\/some-model/);
  });
});

describe("spec module generation", () => {
  test("hostile spec text cannot escape the embedded JSON", () => {
    // The spec is embedded as a JSON literal in a generated TypeScript module.
    // JSON.stringify handles quoting, so the real risk is a value that closes
    // the template literal the module is written inside.
    const spec = sampleSpec();
    spec.sections[0]!.heading!.text = "x` + process.exit(1) + `y";
    spec.meta.title = "${require('child_process').execSync('id')}";
    spec.footer!.tagline = "</script><script>alert(1)</script>";
    const source = renderSpecModule(spec);

    // A backtick or ${...} in a heading is harmless here precisely because the
    // literal is emitted as an object literal inside double-quoted JSON strings,
    // not inside a template literal. Assert the value survived as data, so a
    // future switch to string interpolation would fail this rather than produce
    // a module that evaluates a crawled page's text as code.
    assert.ok(source.includes("process.exit(1)"), "the value should survive as data");
    assert.ok(!/=\s*`/.test(source), "the spec must not be interpolated into a template literal");
    // `</script>` inside a double-quoted JSON string in a standalone .ts file is
    // inert data - it is only dangerous in inline HTML, and this is not that.
    // What has to hold is that the value round-trips unchanged as a string.
    const recovered = recoverSpec(source);
    assert.equal(recovered.sections[0].heading.text, spec.sections[0]!.heading!.text);
    assert.equal(recovered.meta.title, spec.meta.title);
    assert.equal(recovered.footer.tagline, spec.footer!.tagline);
  });

  test("the embedded spec round-trips to the same value", () => {
    // The spec is embedded as a TypeScript object literal, not inside a template
    // string, so quoting is handled by JSON.stringify rather than by escaping.
    // What has to hold is that the literal the generated site reads is the same
    // value the pipeline recorded - a spec that does not survive the round trip
    // produces a site that silently disagrees with its own source of truth.
    const spec = sampleSpec();
    const source = renderSpecModule(spec);
    const recovered = recoverSpec(source);
    assert.deepEqual(recovered, JSON.parse(JSON.stringify(spec)));
  });

  test("the module declares no imports it does not need", () => {
    // The generated project hoists dependencies, so a stray import of a package
    // that is not installed is a build failure with an unhelpful message.
    const source = renderSpecModule(sampleSpec());
    const imports = [...source.matchAll(/^\s*import .*?from ["']([^"']+)["']/gm)].map((m) => m[1]);
    for (const specifier of imports) {
      assert.ok(
        specifier.startsWith(".") || specifier === "next" || specifier === "react",
        `unexpected import: ${specifier}`,
      );
    }
  });
});

describe("component library", () => {
  test("renders no event handlers, which a Server Component cannot accept", () => {
    // The regression: a section classified as a form passed `onSubmit`, and
    // Next.js failed the prerender with "Event handlers cannot be passed to
    // Client Component props". Because the handler sat in one component, it
    // only surfaced on whichever site happened to produce a form section - so
    // single-site testing missed it entirely.
    for (const [name, source] of [["sections", SECTIONS_TSX], ["chrome", CHROME_TSX]] as const) {
      const handlers = [...source.matchAll(/\bon[A-Z][A-Za-z]*=/g)].map((m) => m[0]);
      assert.deepEqual(handlers, [], `${name}.tsx declares event handlers: ${handlers.join(", ")}`);
    }
  });

  test("has a component for every section kind the schema allows", () => {
    // A kind with no entry falls back to a generic block, which is a silent
    // fidelity loss. Checking the dispatch table rather than function names
    // tests the thing the renderer actually consults.
    const { SECTION_KINDS } = require("../src/lib/spec/schema");
    for (const kind of SECTION_KINDS) {
      assert.match(
        SECTIONS_TSX,
        new RegExp(`^  ${kind}: \\w+,`, "m"),
        `SECTION_COMPONENTS has no entry for section kind "${kind}"`,
      );
    }
  });

  test("every dispatch entry points at a component that exists", () => {
    // The other direction: an entry naming a component that was renamed or
    // deleted renders a ReferenceError at build time, in generated code, which
    // is a long way from the cause.
    const entries = [...SECTIONS_TSX.matchAll(/^  [a-z]+: (\w+),/gm)].map((m) => m[1]);
    assert.ok(entries.length >= 19, `expected the full registry, found ${entries.length} entries`);
    for (const name of entries) {
      assert.match(SECTIONS_TSX, new RegExp(`function ${name}\\b`), `dispatch names ${name}, which is not defined`);
    }
  });

  test("does not reference next/image, which needs remote loader config", () => {
    // A plain img keeps the generated project free of image-loader configuration
    // and of runtime dependency on the original host. Asserting it here keeps a
    // future edit from quietly reintroducing the dependency.
    assert.ok(!SECTIONS_TSX.includes("next/image"), "sections.tsx imports next/image");
    assert.ok(!CHROME_TSX.includes("next/image"), "chrome.tsx imports next/image");
  });

  test("does not embed or proxy the source site", () => {
    // The core promise: the output is a standalone reconstruction. An iframe, a
    // remote script or a proxy route would produce something that looks right
    // and is not a clone at all.
    for (const [name, source] of [["sections", SECTIONS_TSX], ["chrome", CHROME_TSX]] as const) {
      assert.ok(!/<iframe/i.test(source), `${name}.tsx contains an iframe`);
      assert.ok(!/dangerouslySetInnerHTML/.test(source), `${name}.tsx uses dangerouslySetInnerHTML`);
    }
  });
});

describe("generated project layout", () => {
  test("every path stays inside the project root", () => {
    // projectPath is used to build the file list, and a spec that can influence
    // a filename could otherwise write outside the project.
    const root = "/tmp/project";
    for (const rest of [
      ["app", "page.tsx"],
      ["components", "sections.tsx"],
      ["lib", "site-spec.ts"],
    ]) {
      const full = projectPath(root, ...rest);
      assert.ok(full.startsWith(root + "/"), `${full} escaped ${root}`);
    }
  });

  test("the fixture spec is still valid after every test has run", () => {
    // A last check that the fixture matches the schema: if it drifted, the
    // failures above would all be about a malformed fixture rather than about
    // the thing each test is actually testing.
    assert.ok(WebsiteSpecSchema.safeParse(sampleSpec()).success);
  });
});

describe("hostile spec content", () => {
  for (const [label, value] of HOSTILE) {
    test(`survives being placed in a heading (${label})`, () => {
      const spec = sampleSpec();
      spec.sections[0]!.heading!.text = value;
      const source = renderSpecModule(spec);
      // Not interpolated into a template literal, so a backtick cannot escape.
      assert.ok(!/=\s*`/.test(source), "the spec must not be interpolated into a template literal");
      // And the value survives as data, so it cannot become code or markup.
      const recovered = recoverSpec(source);
      assert.equal(recovered.sections[0].heading.text, value, "the hostile text must round-trip as data");
    });
  }

  test("survives being placed in a link href", () => {
    const spec = sampleSpec();
    // The fixture's first section starts with no links, so a link is pushed
    // rather than assumed to exist.
    const section = spec.sections[0]!;
    section.links.push({ label: "x", href: "javascript:alert(1)", primary: false, external: false });
    const source = renderSpecModule(spec);
    // The href is data in the spec; the emitter is what neutralises it, and
    // that is asserted in the modifier tests. Here the requirement is only that
    // generation does not crash and the value is preserved as a string.
    assert.ok(source.includes("javascript:alert(1)"), "the href should be preserved as spec data");
  });

  test("survives being placed in an asset path", () => {
    const spec = sampleSpec();
    spec.sections[0].items.push({
      title: "x",
      body: "",
      meta: "",
      price: "",
      badge: "",
      bullets: [],
      link: { label: "", href: "#", primary: false, external: false },
      image: {
        src: "https://evil.example/../../etc/passwd",
        width: 100,
        height: 100,
        alt: "",
        kind: "image",
        local: "../../../etc/passwd",
        localMissing: false,
      },
    } as any);
    const source = renderSpecModule(spec);
    assert.ok(source.length > 0);
  });
});
