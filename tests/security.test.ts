/**
 * Security tests.
 *
 * The crawler is pointed at a URL a stranger typed, and that URL reaches DNS, a
 * browser, `fetch`, and eventually a filename. These are the checks standing
 * between those, so they are tested against the ways they are actually abused
 * rather than against the happy path.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  InvalidUrlError,
  assertSafeSlug,
  isSafeSlug,
  normaliseInput,
  safeAssetUrl,
  safeFileSegment,
  slugify,
} from "../src/lib/security";

describe("URL input", () => {
  test("adds a scheme when the user omits one", () => {
    assert.equal(normaliseInput("example.com").href, "https://example.com/");
    assert.equal(normaliseInput("https://example.com").href, "https://example.com/");
    assert.equal(normaliseInput("http://example.com").href, "http://example.com/");
  });

  test("strips the fragment, which never reaches the server", () => {
    assert.equal(normaliseInput("https://example.com/a#frag").href, "https://example.com/a");
  });

  test("trims a trailing slash but keeps a path", () => {
    assert.equal(normaliseInput("https://example.com/docs/").pathname, "/docs");
    assert.equal(normaliseInput("https://example.com/").pathname, "/");
  });

  test("rejects a non-http protocol", () => {
    // The classic SSRF pivots. file:// and javascript: are the ones that matter
    // most: file:// turns the crawler into a local file reader.
    for (const bad of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<h1>x</h1>",
      "ftp://example.com",
      "chrome://settings",
    ]) {
      assert.throws(
        () => normaliseInput(bad),
        (error: unknown) => error instanceof InvalidUrlError,
        `${bad} must be rejected`,
      );
    }
  });

  test("rejects embedded credentials", () => {
    // Without this, a URL like http://attacker.com@evil.com/ is ambiguous to
    // read and the wrong host is easy to connect to.
    assert.throws(() => normaliseInput("https://user:pass@example.com"), InvalidUrlError);
    assert.throws(() => normaliseInput("https://user@example.com"), InvalidUrlError);
  });

  test("rejects a bare hostname with no dot, and empty input", () => {
    assert.throws(() => normaliseInput("localhost"), InvalidUrlError);
    assert.throws(() => normaliseInput("   "), InvalidUrlError);
    assert.throws(() => normaliseInput(""), InvalidUrlError);
  });

  test("rejects an absurdly long URL", () => {
    assert.throws(() => normaliseInput(`https://example.com/${"a".repeat(4000)}`), InvalidUrlError);
  });

  test("collapses traversal in the path instead of carrying it through", () => {
    // The path is data, not a filesystem path, but a traversal that survived
    // would be confusing at best. URL parsing resolves it, and crucially the
    // host is untouched - the connection still goes to example.com.
    const parsed = normaliseInput("https://example.com/../../etc/passwd");
    assert.equal(parsed.pathname, "/etc/passwd");
    assert.equal(parsed.hostname, "example.com");
  });
});

describe("safeFileSegment", () => {
  test("turns a path into a single segment", () => {
    // This is the case a denylist got wrong: "/etc/passwd" became
    // "etc/passwd", which is still two segments and still escapes the
    // generated-projects directory once joined onto it.
    for (const bad of ["..", ".", "../..", "/etc/passwd", "a/b", "a\\b", "....//....//x"]) {
      const out = safeFileSegment(bad, "fallback");
      assert.ok(!out.includes("/"), `${JSON.stringify(bad)} kept a slash: ${out}`);
      assert.ok(!out.includes("\\"), `${JSON.stringify(bad)} kept a backslash: ${out}`);
      assert.notEqual(out, "..");
      assert.notEqual(out, ".");
    }
    assert.equal(safeFileSegment("/etc/passwd", "f"), "etc-passwd");
  });

  test("replaces whitespace and drops leading dots", () => {
    assert.equal(safeFileSegment("  hello world  "), "hello-world");
    assert.equal(safeFileSegment("...hidden"), "hidden");
  });

  test("falls back when nothing usable remains", () => {
    assert.equal(safeFileSegment("", "fallback"), "fallback");
    assert.equal(safeFileSegment("..", "fallback"), "fallback");
  });

  test("bounds the length", () => {
    assert.equal(safeFileSegment("x".repeat(500)).length, 60);
    assert.equal(safeFileSegment("x".repeat(500), "f", 10).length, 10);
  });

  test("neutralises characters that would break a shell command", () => {
    // The build step interpolates the project directory into a spawned
    // command, so the name must not be able to close an argument.
    const out = safeFileSegment("a;rm -rf /$(whoami)`id`&&echo");
    for (const ch of [";", "$", "`", "&", "|", "(", ")", " ", "\n"]) {
      assert.ok(!out.includes(ch), `segment kept ${JSON.stringify(ch)}: ${out}`);
    }
  });
});

describe("isSafeSlug / assertSafeSlug", () => {
  test("accepts what slugify produces", () => {
    // Section ids come from slugify(), so this is the contract that matters: a
    // heading-derived id is always lowercase alphanumerics and dashes.
    for (const input of ["Why Teams Switch!", "Section 1", "caf\u00e9", "  Padded  "]) {
      const slug = slugify(input);
      assert.ok(isSafeSlug(slug), `${JSON.stringify(input)} -> ${JSON.stringify(slug)} should be safe`);
    }
  });

  test("rejects anything that could address another path or a bad id", () => {
    for (const bad of ["", "..", "../x", "a/b", "a b", "a.b", "-lead", "A", "x".repeat(100), "a;b"]) {
      assert.ok(!isSafeSlug(bad), `${JSON.stringify(bad)} must be rejected`);
    }
  });

  test("assertSafeSlug throws with the offending name in the message", () => {
    assert.throws(() => assertSafeSlug("../etc", "section id"), /section id/);
  });
});

describe("safeAssetUrl", () => {
  test("resolves a relative reference against the page", () => {
    const url = safeAssetUrl("/img/a.png", "https://example.com/docs/page");
    assert.equal(url?.href, "https://example.com/img/a.png");
  });

  test("accepts a same-scheme absolute URL", () => {
    const url = safeAssetUrl("https://cdn.example.com/a.png", "https://example.com/");
    assert.equal(url?.hostname, "cdn.example.com");
  });

  test("rejects a non-http scheme however it is disguised", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:image/svg+xml,<svg onload=alert(1)>",
      "file:///etc/passwd",
      "vbscript:msgbox",
    ]) {
      assert.equal(safeAssetUrl(bad, "https://example.com/"), null, `${bad} must be rejected`);
    }
  });

  test("rejects an empty or whitespace reference", () => {
    assert.equal(safeAssetUrl("", "https://example.com/"), null);
    assert.equal(safeAssetUrl("   ", "https://example.com/"), null);
  });
});

describe("slugify", () => {
  test("produces a stable lowercase identifier", () => {
    assert.equal(slugify("Why Teams Switch!"), "why-teams-switch");
    assert.equal(slugify("  Multiple   Spaces  "), "multiple-spaces");
  });

  test("never returns a path or an empty string", () => {
    for (const input of ["///", "!!!", "", "   "]) {
      const out = slugify(input);
      assert.ok(out.length > 0, `${JSON.stringify(input)} produced an empty slug`);
      assert.ok(!out.includes("/"), `${JSON.stringify(input)} produced a slash: ${out}`);
    }
  });
});
