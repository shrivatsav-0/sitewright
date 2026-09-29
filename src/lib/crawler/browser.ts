/**
 * Playwright driver: navigation, cookie dismissal, capture, and cleanup.
 *
 * A single browser is launched per analysis and shared across every viewport,
 * because a cold Chromium start dominates the runtime of a whole run.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  type Browser as PlaywrightBrowser,
  type BrowserContext,
  type Page,
} from "playwright";
import { config } from "../config";
import { createLogger } from "../logger";
import { assertPublicHost, type NormalisedUrl } from "../security";
import { extractScriptSource } from "./script";
import type { ExtractedPage } from "./extract-script";

const log = createLogger("crawler/browser");

export interface ViewportSpec {
  name: string;
  width: number;
  height: number;
  deviceScaleFactor?: number;
  isMobile?: boolean;
}

export const VIEWPORTS: ViewportSpec[] = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 834, height: 1112 },
  { name: "mobile", width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 },
];

export interface Screenshot {
  viewport: string;
  /** Full-page PNG. */
  file: string;
  width: number;
  height: number;
  /** Above-the-fold PNG, useful as a compact reference for the model. */
  foldFile?: string;
}

export interface AnalysisResult {
  page: ExtractedPage;
  screenshots: Screenshot[];
  /** Per-section crops of the desktop capture, used for visual reference. */
  sectionShots: { index: number; file: string; width: number; height: number }[];
  consoleErrors: string[];
  failedRequests: string[];
  finalUrl: string;
  /** True when the browser had to block private-network subresources. */
  usedHttpsUpgrade: boolean;
  /** Absolute path of the directory holding the screenshots. */
  screenshotsDir: string;
  timings: { totalMs: number; perViewportMs: Record<string, number> };
}

/** Elements that routinely cover a page and get in the way of both capture and cloning. */
const NOISE_SELECTORS = [
  'iframe[src*="doubleclick"]',
  'iframe[title*="cookie" i]',
  '[id*="cookie-banner" i]',
  '[class*="cookie-banner" i]',
  '[class*="cookie-consent" i]',
  '[id*="onetrust" i]',
  '[class*="onetrust" i]',
  '[aria-modal="true"][role="dialog"]',
  '.intercom-launcher',
  '#hubspot-messages-iframe-container',
  '[class*="chat-widget" i]',
  '#back-to-top',
];

export class Crawler {
  private constructor(
    private browser: PlaywrightBrowser,
    private context: BrowserContext,
  ) {}

  static async launch(): Promise<Crawler> {
    const headless = process.env.PW_HEADFUL !== "1";
    const browser = await chromium.launch({
      headless,
      args: [
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--font-render-hinting=none",
      ],
    });
    const context = await browser.newContext({
      userAgent: config().crawl.userAgent,
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: true,
      javaScriptEnabled: true,
      // Block heavy third-party media: it slows capture and never matters for
      // a structural clone.
      serviceWorkers: "block",
    });
    context.setDefaultNavigationTimeout(config().crawl.navigationTimeoutMs);
    context.setDefaultTimeout(config().crawl.navigationTimeoutMs);
    return new Crawler(browser, context);
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }

  /**
   * Route guard. Runs inside the browser process for every request, so it also
   * covers subresources the page fetches on its own — the case a naive
   * "validate the input URL" check would miss.
   */
  private async installGuards(): Promise<{ blockedPrivate: boolean; blockedHeavy: number }> {
    let blockedPrivate = false;
    let blockedHeavy = 0;
    await this.context.route("**/*", async (route) => {
      const req = route.request();
      const type = req.resourceType();
      const url = req.url();
      if (type === "media" || type === "font") {
        // Fonts matter for typography fidelity; media never does.
        if (type === "media") {
          blockedHeavy++;
          return route.abort();
        }
      }
      if (!/^https?:/i.test(url)) return route.continue();
      try {
        const parsed = new URL(url);
        if (!config().crawl.allowPrivateHosts) {
          const host = parsed.hostname.replace(/^\[|\]$/g, "");
          const isPrivate =
            host === "localhost" ||
            host.endsWith(".local") ||
            /^127\./.test(host) ||
            /^10\./.test(host) ||
            /^192\.168\./.test(host) ||
            /^169\.254\./.test(host) ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(host);
          if (isPrivate) {
            blockedPrivate = true;
            return route.abort();
          }
        }
      } catch {
        return route.abort();
      }
      return route.continue();
    });
    return {
      get blockedPrivate() {
        return blockedPrivate;
      },
      get blockedHeavy() {
        return blockedHeavy;
      },
    } as { blockedPrivate: boolean; blockedHeavy: number };
  }

  async analyse(target: NormalisedUrl, outDir: string): Promise<AnalysisResult> {
    const t0 = Date.now();
    await fsp.mkdir(outDir, { recursive: true });
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];

    let finalUrl = target.href;
    const pageData: ExtractedPage[] = [];
    const screenshots: Screenshot[] = [];
    const sectionShots: AnalysisResult["sectionShots"] = [];
    const perViewportMs: Record<string, number> = {};

    const guards = await this.installGuards();

    for (const vp of VIEWPORTS) {
      const vt0 = Date.now();
      const page = await this.context.newPage();
      try {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        page.on("console", (msg) => {
          if (msg.type() === "error" && consoleErrors.length < 40) {
            const text = msg.text();
            // Third-party noise we cannot fix and does not affect the clone.
            if (/favicon|analytics|gtag|doubleclick|ERR_BLOCKED_BY_CLIENT/i.test(text)) return;
            consoleErrors.push(text.slice(0, 300));
          }
        });
        page.on("requestfailed", (req) => {
          if (failedRequests.length < 40) {
            failedRequests.push(`${req.resourceType()} ${req.url().slice(0, 180)}`);
          }
        });

        await this.goto(page, target.href, vp);

        // Let late-mounting content settle: frameworks frequently append
        // sections after hydration.
        await page
          .waitForLoadState("networkidle", { timeout: 8_000 })
          .catch(() => log.debug("networkidle never settled", { viewport: vp.name }));
        await this.dismissNoise(page);
        await this.autoScroll(page);
        // Scroll back to the top so the full-page shot starts correctly.
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(600);

        // The extraction always runs at desktop width so the spec describes a
        // single canonical layout; mobile only informs the responsive profile.
        if (vp.name === "desktop") {
          finalUrl = page.url();
          const data = (await page.evaluate(extractScriptSource())) as ExtractedPage;
          pageData.push(data);

          for (const s of data.sections.slice(0, 8)) {
            const shot = await this.cropSection(page, s.selector, s.index, outDir);
            if (shot) sectionShots.push(shot);
          }
        }

        const full = path.join(outDir, `original-${vp.name}.png`);
        const fold = path.join(outDir, `original-${vp.name}-fold.png`);
        const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
        // Guard against pathological pages producing enormous images.
        const capped = Math.min(scrollHeight, 24_000);
        await page.screenshot({ path: full as `${string}.png`, fullPage: true, animations: "disabled" });
        await page.screenshot({ path: fold as `${string}.png`, fullPage: false, animations: "disabled" });
        screenshots.push({
          viewport: vp.name,
          file: path.basename(full),
          foldFile: path.basename(fold),
          width: vp.width,
          height: Math.min(capped, 30_000),
        });
        log.debug("captured viewport", {
          viewport: vp.name,
          width: vp.width,
          scrollHeight,
          ms: Date.now() - vt0,
        });
      } catch (err) {
        log.warn("viewport capture failed", { viewport: vp.name, error: (err as Error).message });
        if (vp.name === "desktop") throw err;
      } finally {
        await page.close().catch(() => {});
      }
      perViewportMs[vp.name] = Date.now() - vt0;
    }

    if (!pageData.length) {
      throw new Error("The page could not be captured at desktop width.");
    }

    return {
      page: pageData[0],
      screenshots,
      sectionShots,
      consoleErrors,
      failedRequests,
      finalUrl,
      usedHttpsUpgrade: guards.blockedPrivate,
      screenshotsDir: outDir,
      timings: { totalMs: Date.now() - t0, perViewportMs },
    };
  }

  private async goto(page: Page, href: string, vp: ViewportSpec): Promise<void> {
    await assertPublicHost(new URL(href));
    const primary = async () => {
      const response = await page.goto(href, {
        waitUntil: "domcontentloaded",
        timeout: config().crawl.navigationTimeoutMs,
      });
      if (response && !response.ok() && response.status() >= 400) {
        throw new Error(`The site responded with HTTP ${response.status()}.`);
      }
    };
    try {
      await primary();
    } catch (err) {
      // http:// sites frequently redirect to https://; retry once explicitly
      // so the user gets a working clone rather than a confusing failure.
      if (href.startsWith("http://") && !(err as Error).message.includes("HTTP 4")) {
        const upgraded = href.replace(/^http:/, "https:");
        log.info("retrying over https", { from: href, to: upgraded });
        await page.goto(upgraded, { waitUntil: "domcontentloaded", timeout: config().crawl.navigationTimeoutMs });
        return;
      }
      throw err;
    }
    void vp;
  }

  private async dismissNoise(page: Page): Promise<void> {
    await page
      .addStyleTag({
        content: NOISE_SELECTORS.join(",") + "{display:none !important;visibility:hidden !important;}",
      })
      .catch(() => {});
    // Click the most common consent acceptors, best-effort.
    const buttons = [
      'button:has-text("Accept all")',
      'button:has-text("Accept All Cookies")',
      'button:has-text("I agree")',
      'button:has-text("Got it")',
      'button:has-text("Allow all")',
    ];
    for (const sel of buttons) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 400 })) {
          await el.click({ timeout: 1200 });
          await page.waitForTimeout(300);
          break;
        }
      } catch {
        /* consent UI is optional */
      }
    }
  }

  /** Trigger lazy-loaded content so a full-page screenshot is not full of blanks. */
  private async autoScroll(page: Page): Promise<void> {
    await page
      .evaluate(async () => {
        const step = Math.max(400, Math.floor(window.innerHeight * 0.85));
        const max = document.documentElement.scrollHeight;
        for (let y = 0; y < max; y += step) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 140));
        }
        window.scrollTo(0, 0);
      })
      .catch(() => {});
  }

  private async cropSection(
    page: Page,
    selector: string,
    index: number,
    outDir: string,
  ): Promise<{ index: number; file: string; width: number; height: number } | null> {
    if (!selector) return null;
    try {
      const locator = page.locator(selector).first();
      const box = await locator.boundingBox({ timeout: 2_000 });
      if (!box || box.height < 80 || box.width < 80) return null;
      if (box.height > 4_000) return null; // too tall to be a useful reference
      const file = path.join(outDir, `section-${String(index).padStart(2, "0")}.png`);
      await locator.screenshot({ path: file as `${string}.png`, animations: "disabled", timeout: 4_000 });
      return {
        index,
        file: path.basename(file),
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
    } catch {
      return null;
    }
  }
}

export function screenshotsDir(projectDir: string): string {
  return path.join(projectDir, "screenshots");
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
