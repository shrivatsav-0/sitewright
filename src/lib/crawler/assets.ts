/**
 * Asset acquisition.
 *
 * Assets are downloaded, validated by content type and size, written into the
 * generated project's `public/` tree with collision-safe names, and returned
 * with their real dimensions. A failed download is never fatal: the caller
 * receives a `missing: true` reference and the generator substitutes a
 * styled placeholder, so a dead CDN cannot sink an otherwise good clone.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { config } from "../config";
import { createLogger } from "../logger";
import { assertPublicHost, safeAssetUrl } from "../security";
import type { AssetRef } from "../spec/schema";

const log = createLogger("crawler/assets");

const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "image/x-icon": ".ico",
  "image/vnd.microsoft.icon": ".ico",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
};

const MIME_BY_EXT: Record<string, AssetRef["kind"]> = {
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".avif": "image",
  ".gif": "image",
  ".svg": "svg",
  ".ico": "icon",
  ".mp4": "video",
  ".webm": "video",
  ".woff": "font",
  ".woff2": "font",
};

export interface RawAsset {
  url: string;
  alt?: string;
  width?: number;
  height?: number;
  intrinsicWidth?: number;
  intrinsicHeight?: number;
  kind?: AssetRef["kind"];
  svg?: string;
  /** Optional local directory for inline SVGs. */
  svgName?: string;
}

export interface AssetFetcherOptions {
  publicDir: string;
  baseUrl: string;
  maxAssets?: number;
}

export class AssetFetcher {
  private readonly maxAssets: number;
  private readonly seen = new Map<string, AssetRef>();
  private downloaded = 0;
  private missing = 0;

  constructor(private readonly opts: AssetFetcherOptions) {
    this.maxAssets = opts.maxAssets ?? config().crawl.maxAssets;
  }

  get stats() {
    return { downloaded: this.downloaded, missing: this.missing, unique: this.seen.size };
  }

  /**
   * Fetch a batch with bounded concurrency. Ordering is preserved so the
   * highest-priority assets (hero imagery, logos) are never starved by the
   * asset cap.
   */
  async fetchAll(assets: RawAsset[]): Promise<AssetRef[]> {
    const out: AssetRef[] = [];
    const queue = assets.filter((a) => a.url || a.svg).slice(0, this.maxAssets);
    const CONCURRENCY = 6;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (cursor < queue.length) {
        const item = queue[cursor++];
        try {
          out.push(await this.fetchOne(item));
        } catch (err) {
          log.debug("asset failed", { url: item.url, error: (err as Error).message });
          this.missing++;
          out.push({
            localPath: "",
            sourceUrl: item.url,
            alt: item.alt ?? "",
            missing: true,
            kind: item.kind ?? "image",
            ...(item.width ? { width: item.width } : {}),
            ...(item.height ? { height: item.height } : {}),
          });
        }
      }
    });
    await Promise.all(workers);
    return out;
  }

  private async fetchOne(asset: RawAsset): Promise<AssetRef> {
    const key = asset.url || `inline:${asset.svgName ?? hashOf(asset.svg ?? "")}`;
    const cached = this.seen.get(key);
    if (cached) return { ...cached, alt: asset.alt || cached.alt };

    // Inline SVG: store verbatim, sanitised of scripts and event handlers.
    if (asset.svg) {
      const safe = sanitiseSvg(asset.svg);
      if (!safe) {
        this.missing++;
        return { localPath: "", sourceUrl: undefined, alt: asset.alt ?? "", missing: true, kind: "svg" };
      }
      const name = safeFileName(asset.svgName ?? `icon-${hashOf(safe).slice(0, 8)}`, "svg", ".svg");
      const target = path.join(this.opts.publicDir, "assets", name);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, safe, "utf8");
      const ref: AssetRef = {
        localPath: `/assets/${name}`,
        alt: asset.alt ?? "",
        missing: false,
        kind: "svg",
        ...(asset.width ? { width: asset.width } : {}),
        ...(asset.height ? { height: asset.height } : {}),
      };
      this.seen.set(key, ref);
      this.downloaded++;
      return ref;
    }

    const url = safeAssetUrl(asset.url, this.opts.baseUrl);
    if (!url) {
      this.missing++;
      return { localPath: "", alt: asset.alt ?? "", missing: true, kind: asset.kind ?? "image" };
    }
    if (this.downloaded >= this.maxAssets) {
      this.missing++;
      return { localPath: "", sourceUrl: url.toString(), alt: asset.alt ?? "", missing: true, kind: asset.kind ?? "image" };
    }

    try {
      await assertPublicHost(url);
    } catch {
      this.missing++;
      return {
        localPath: "",
        sourceUrl: url.toString(),
        alt: asset.alt ?? "",
        missing: true,
        kind: asset.kind ?? "image",
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "user-agent": config().crawl.userAgent,
          accept: "image/avif,image/webp,image/png,image/jpeg,image/svg+xml,image/*,*/*;q=0.8",
        },
      });
    } catch (err) {
      clearTimeout(timer);
      this.missing++;
      return {
        localPath: "",
        sourceUrl: url.toString(),
        alt: asset.alt ?? "",
        missing: true,
        kind: asset.kind ?? "image",
      };
    }
    clearTimeout(timer);

    if (!res.ok) {
      this.missing++;
      return {
        localPath: "",
        sourceUrl: url.toString(),
        alt: asset.alt ?? "",
        missing: true,
        kind: asset.kind ?? "image",
      };
    }

    const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > config().crawl.maxAssetBytes) {
      this.missing++;
      return {
        localPath: "",
        sourceUrl: url.toString(),
        alt: asset.alt ?? "",
        missing: true,
        kind: asset.kind ?? "image",
        width: asset.width,
        height: asset.height,
      };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0) throw new Error("empty body");
    if (buf.byteLength > config().crawl.maxAssetBytes) throw new Error("asset too large");

    const ext = EXT_BY_MIME[mime] ?? path.extname(url.pathname).toLowerCase() ?? "";
    if (!ext || ext === ".php" || ext === ".aspx") throw new Error(`unsupported asset type ${mime}`);

    // Data-URI and blob payloads occasionally reach us as already-inline data.
    if (mime === "image/svg+xml" || ext === ".svg") {
      const safe = sanitiseSvg(buf.toString("utf8"));
      if (!safe) throw new Error("svg rejected by sanitiser");
      const name = safeFileName(baseName(url.pathname), "svg", ".svg");
      await this.write(path.join(this.opts.publicDir, "assets", name), safe);
      const ref: AssetRef = {
        localPath: `/assets/${name}`,
        sourceUrl: url.toString(),
        alt: asset.alt ?? "",
        missing: false,
        kind: "svg",
        ...(asset.width ? { width: asset.width } : {}),
        ...(asset.height ? { height: asset.height } : {}),
      };
      this.seen.set(key, ref);
      this.downloaded++;
      return ref;
    }

    const dims = await readImageSize(buf, ext);
    const name = safeFileName(baseName(url.pathname), "image", ext);
    await this.write(path.join(this.opts.publicDir, "assets", name), buf);
    const ref: AssetRef = {
      localPath: `/assets/${name}`,
      sourceUrl: url.toString(),
      alt: asset.alt ?? "",
      missing: false,
      kind: asset.kind ?? (MIME_BY_EXT[ext] ?? "image"),
      width: asset.width ?? dims?.width,
      height: asset.height ?? dims?.height,
      intrinsicWidth: dims?.width,
      intrinsicHeight: dims?.height,
    };
    this.seen.set(key, ref);
    this.downloaded++;
    return ref;
  }

  private async write(target: string, data: string | Buffer): Promise<void> {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, data);
  }
}

function baseName(p: string): string {
  return path.basename(p || "asset").replace(/\.[a-z0-9]{1,6}$/i, "");
}

/** Deterministic, collision-resistant, filesystem-safe asset filename. */
function safeFileName(stem: string, fallback: string, ext: string): string {
  const cleaned =
    stem
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || fallback;
  return `${cleaned}-${randomish(stem)}${ext}`;
}

function randomish(seed: string): string {
  return createHash("sha1").update(seed).digest("hex").slice(0, 6);
}

function hashOf(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/**
 * Remove scriptable content from an SVG before it lands in `public/`.
 * An SVG is a document, not an image, so it can carry `<script>`.
 */
export function sanitiseSvg(svg: string): string | null {
  if (!svg || svg.length > 400_000) return null;
  let out = svg;
  out = out.replace(/<script[\s\S]*?<\/script>/gi, "");
  out = out.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "");
  out = out.replace(/<iframe[\s\S]*?<\/iframe>/gi, "");
  out = out.replace(/<use[^>]+xlink:href\s*=\s*["']\s*(?!#)(https?:|\/\/|javascript:)[^"']*["'][^>]*>/gi, "");
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  out = out.replace(/(href|xlink:href)\s*=\s*["']\s*javascript:[^"']*["']/gi, "");
  if (!/^<svg[\s>]/i.test(out.trim())) return null;
  if (!/<\/svg>\s*$/i.test(out.trim())) {
    if (!/\/>\s*$/.test(out.trim()) && !/<\/svg>/i.test(out)) return null;
  }
  return out;
}

/** Minimal header parsers so we can preserve aspect ratio without a decoder. */
async function readImageSize(
  buf: Buffer,
  ext: string,
): Promise<{ width: number; height: number } | null> {
  try {
    if (ext === ".png" && buf.length > 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (ext === ".gif" && buf.length > 10) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (ext === ".webp" && buf.length > 30) {
      // VP8X / VP8L / VP8 all carry dimensions; VP8X is the container form.
      if (buf.toString("ascii", 12, 16) === "VP8X") {
        const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
        const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
        return { width: w, height: h };
      }
      return null;
    }
    if ((ext === ".jpg" || ext === ".jpeg") && buf.length > 4) {
      let offset = 2;
      while (offset < buf.length - 9) {
        if (buf[offset] !== 0xff) {
          offset++;
          continue;
        }
        const marker = buf[offset + 1];
        const len = buf.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
        }
        offset += 2 + len;
      }
    }
    if (ext === ".avif" || ext === ".mp4" || ext === ".webm") return null;
  } catch {
    return null;
  }
  return null;
}
