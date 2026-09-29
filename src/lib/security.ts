/**
 * Input validation and SSRF guardrails.
 *
 * The agent fetches a URL that a human typed, and then runs AI-authored code
 * against the result. Both are treated as untrusted:
 *   - URLs are parsed and checked against private/loopback/link-local ranges
 *     before the crawler or the asset downloader will touch them.
 *   - Everything derived from a URL (project id, directory name, filenames)
 *     passes through a strict slug/segment filter, so no path traversal or
 *     shell metacharacter can reach the filesystem or a child process.
 *   - Every shell invocation uses `spawn` with an argument array — never a
 *     shell string — so a crafted filename cannot become a command.
 */

import dns from "node:dns/promises";
import net from "node:net";
import { config } from "./config";

export class InvalidUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUrlError";
  }
}

export interface NormalisedUrl {
  href: string;
  origin: string;
  hostname: string;
  port: string;
  pathname: string;
  /** Absolute base for resolving relative links. */
  base: string;
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** Add a scheme when the user typed `example.com`. */
export function normaliseInput(input: string): NormalisedUrl {
  const raw = (input ?? "").trim();
  if (!raw) throw new InvalidUrlError("Enter a website URL.");
  if (raw.length > 2048) throw new InvalidUrlError("That URL is too long.");

  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new InvalidUrlError(`"${raw}" is not a valid URL.`);
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new InvalidUrlError(`Only http and https URLs are supported (got ${url.protocol}).`);
  }
  if (!url.hostname || !url.hostname.includes(".")) {
    throw new InvalidUrlError(`"${url.hostname}" does not look like a public hostname.`);
  }
  if (url.username || url.password) {
    throw new InvalidUrlError("URLs containing credentials are not accepted.");
  }

  url.hash = "";
  return {
    href: url.toString(),
    origin: url.origin,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/, ""),
    base: url.toString(),
  };
}

function ipIsPrivate(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast/reserved
    return false;
  }
  if (v === 6) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true;
    if (low.startsWith("fe80")) return true;
    if (/^f[cd]/.test(low)) return true; // unique local
    if (low.startsWith("::ffff:")) return ipIsPrivate(low.slice(7));
    return false;
  }
  return true;
}

/**
 * Resolve the hostname and refuse anything that lands inside private space.
 * DNS rebinding is not fully preventable here, but this stops the obvious
 * `http://127.0.0.1/`, `http://169.254.169.254/` and `http://localhost/` cases.
 */
export async function assertPublicHost(url: URL): Promise<void> {
  if (config().crawl.allowPrivateHosts) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (ipIsPrivate(host)) throw new InvalidUrlError(`Refusing to fetch private address ${host}.`);
    return;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new InvalidUrlError(`Refusing to fetch internal hostname ${host}.`);
  }
  let records: { address: string }[];
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    throw new InvalidUrlError(`Could not resolve host "${host}".`);
  }
  for (const r of records) {
    if (ipIsPrivate(r.address)) {
      throw new InvalidUrlError(
        `Host "${host}" resolves to the private address ${r.address}; refusing to continue.`,
      );
    }
  }
}

export async function assertUrlIsPublic(href: string): Promise<void> {
  await assertPublicHost(new URL(href));
}

/** Only ever used for asset fetches, which are strictly http(s). */
export function safeAssetUrl(raw: string, base: string): URL | null {
  // An empty reference resolves against the base to the page URL itself, which
  // would queue a download of the site's HTML as though it were an image. A
  // blank `src` means "no asset", so it has to be rejected before the parser
  // gets a chance to be helpful about it.
  const ref = (raw ?? "").trim();
  if (!ref) return null;
  try {
    const u = new URL(ref, base);
    if (!ALLOWED_PROTOCOLS.has(u.protocol)) return null;
    if (u.protocol === "data:" || u.protocol === "blob:") return null;
    return u;
  } catch {
    return null;
  }
}

/**
 * The URL schemes a link on a real page may legitimately use.
 *
 * This is an allowlist, which is the only form of this check that stays
 * correct. A denylist of the script-bearing schemes - the obvious first
 * implementation, and the one this file used to have - is incomplete by
 * construction: `file:` reads local files, `blob:` and `filesystem:` reach
 * in-memory and origin-relative handles, and browsers keep adding handlers.
 * None of those have to execute script to be wrong in a generated page.
 */
const ALLOWED_HREF_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:", "sms:"]);

/**
 * Reduce an href read off a crawled page to something safe to render.
 *
 * Section links, item links, nav links and footer links all pass through here
 * on their way into generated JSX. Two things are worth noting about where the
 * check lives. It is a function, not a type, because the hrefs arrive as
 * untyped JSON from the browser extractor, so nothing downstream of here can
 * rely on a type for the guarantee. And it is duplicated in no other module:
 * the three emitters that write hrefs all import this one, because a private
 * copy per emitter is a copy that eventually drifts and leaves one path
 * unsanitised.
 *
 * Relative links, fragments and query-only references have no scheme and are
 * returned unchanged. Everything unrecognised becomes "#", which renders a valid
 * inert anchor rather than a broken one.
 */
export function safeHref(href: string): string {
  const h = (href ?? "").trim();
  if (!h) return "#";
  // "#" and "/" cannot introduce a scheme. "//host/path" is protocol-relative
  // and inherits the page scheme, which is already http or https.
  if (h.startsWith("#") || h.startsWith("/") || h.startsWith("?")) return h.slice(0, 300);
  let scheme: string;
  try {
    scheme = new URL(h).protocol;
  } catch {
    // Not parseable as an absolute URL, so it cannot carry a scheme.
    return h.slice(0, 300);
  }
  if (!ALLOWED_HREF_SCHEMES.has(scheme)) return "#";
  return h.slice(0, 300);
}

const SLUG_SAFE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isSafeSlug(value: string): boolean {
  return SLUG_SAFE.test(value);
}

export function assertSafeSlug(value: string, what = "identifier"): string {
  if (!isSafeSlug(value)) {
    throw new InvalidUrlError(`Unsafe ${what}: ${JSON.stringify(value).slice(0, 80)}`);
  }
  return value;
}

/** URL -> stable, filesystem-safe project id. */
export function projectIdFor(href: string): string {
  const host = new URL(href).hostname.replace(/^www\./, "");
  const slug = slugify(host).slice(0, 40).replace(/-+$/, "") || "site";
  return `${slug}-${shortHash(href)}`;
}

/**
 * A stable, DOM-safe identifier derived from arbitrary text.
 *
 * Never returns an empty string. Headings are frequently punctuation-only or
 * non-Latin, and a slug of "" is not a valid `id` attribute, so a section
 * would end up with no anchor at all and the generated markup would fail
 * validation. Falling back to a hash of the input keeps such sections
 * addressable and keeps the result deterministic across runs.
 */
export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56)
    .replace(/-+$/g, "");
  if (base) return base;
  // Nothing survived normalisation: a stable short id is better than none.
  return `s-${shortHash(input ?? "")}`;
}

export function shortHash(input: string): string {
  // FNV-1a: stable across processes, unlike Math.random-based ids.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, "0").slice(0, 7);
}

/**
 * The only characters allowed in a generated filename or directory name.
 *
 * A denylist was used here originally, which failed in two ways at once. It had
 * no global flag, so only the *first* dangerous character was stripped and
 * "/etc/passwd" became "etc/passwd" - still two path segments, and this value is
 * joined onto the generated-projects directory. And shell metacharacters
 * (; $ ` & |) were never on the list, so a hostile host name could close an
 * argument in the command used to build the project.
 *
 * A whitelist cannot fail that way. Anything outside this set is not a plausible
 * filename, and for a project id the only loss is cosmetic punctuation in a
 * directory name.
 */
const FILENAME_SAFE = /[^A-Za-z0-9._-]+/g;

/** Filesystem-safe single path segment derived from untrusted text. */
export function safeFileSegment(input: string, fallback = "file", max = 60): string {
  const cleaned = (input ?? "")
    // Unsafe characters become a single dash. Substituting "/etc/passwd" turns
    // the slashes into dashes, so a leading dash has to be trimmed afterwards or
    // the result reads like a command-line flag.
    .replace(FILENAME_SAFE, "-")
    .replace(/-{2,}/g, "-")
    .replace(/\.{2,}/g, ".")
    // A leading dot hides the file, and "." and ".." are the only names that
    // mean something other than themselves.
    .replace(/^[-.]+/, "")
    .slice(0, max)
    // Trimming again, because the slice can land mid-token and leave a trailing
    // dash or dot behind.
    .replace(/[-.]+$/, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned;
}
