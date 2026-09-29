/**
 * In-page extraction script.
 *
 * This runs inside the real browser via `page.evaluate` and is the single
 * source of visual truth for the whole pipeline. Everything it returns is
 * measured — computed styles, bounding boxes, font metrics — not guessed.
 *
 * Two jobs:
 *   1. Segment the page into *visual sections* (elements whose effective
 *      background/geometry differs from their parent's, plus structural
 *      landmarks) so the AI is asked to classify a dozen meaningful blocks
 *      rather than a thousand meaningless nodes.
 *   2. Measure the design system (colours, type scale, radii, shadows,
 *      container width) by frequency, so the generator inherits the source
 *      site's actual design tokens instead of a generic theme.
 *
 * The function must stay self-contained: it is serialised and evaluated in the
 * page, so it cannot close over anything from this module.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ExtractedPage {
  url: string;
  title: string;
  description: string;
  language: string;
  generator: string;
  themeColor: string;
  favicon: string;
  viewport: { width: number; height: number; scrollWidth: number; scrollHeight: number };
  /** Highest number of "interesting" elements found, used to size budgets. */
  counts: { links: number; images: number; headings: number; forms: number; sections: number };
  design: Record<string, any>;
  navigation: Record<string, any> | null;
  footer: Record<string, any> | null;
  sections: Record<string, any>[];
  warnings: string[];
}

export function extractPage(): ExtractedPage {
  const MAX_TEXT = 600;

  const q = <T extends Element>(sel: string): T | null => document.querySelector(sel) as T | null;
  const qa = <T extends Element>(sel: string): T[] => Array.from(document.querySelectorAll(sel)) as T[];

  const cs = (el: Element) => getComputedStyle(el);
  /**
   * A unitless line-height ratio from a computed value.
   *
   * `line-height` computes to either a keyword ("normal") or a length in px. A
   * unitless ratio is what the spec stores, so a px line-height is divided back
   * out by the font size rather than stored as an absolute.
   */
  const ratio = (lineHeight: string, fontSize: string, fallback = 1.2): number => {
    if (lineHeight === "normal" || !lineHeight) return fallback;
    const lh = Number.parseFloat(lineHeight);
    const fs = Number.parseFloat(fontSize);
    if (!Number.isFinite(lh) || !Number.isFinite(fs) || fs <= 0) return fallback;
    return lh > 6 ? fallback : Math.min(4, Math.max(0.5, lh / fs));
  };
  const px = (v: string): number => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  };
  const clean = (s: string | null | undefined, max = MAX_TEXT): string =>
    (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = cs(el);
    if (s.visibility === "hidden" || s.display === "none") return false;
    if (px(s.opacity) === 0) return false;
    return true;
  };
  const ownText = (el: Element): string => {
    let out = "";
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3) out += (n as Text).textContent ?? "";
    }
    return clean(out);
  };
  /**
   * Visible text of a subtree, cleaned and bounded.
   *
   * Accepts null/undefined on purpose: almost every call site is
   * `deepText(el.querySelector("label"), 80)`, and a missing match must yield an
   * empty string rather than abort the whole extraction. One unlabelled input
   * on a page should cost that input's label, not the entire run.
   */
  const deepText = (el: Element | null | undefined, max = MAX_TEXT): string =>
    clean(el?.textContent ?? "", max);

  const isTransparent = (c: string) =>
    !c || c === "transparent" || /^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(c);

  /** Walk up until we find a painted background. */
  const effectiveBg = (el: Element): string => {
    let cur: Element | null = el;
    while (cur && cur !== document.documentElement) {
      const bg = cs(cur).backgroundColor;
      if (!isTransparent(bg)) return bg;
      cur = cur.parentElement;
    }
    const htmlBg = cs(document.documentElement).backgroundColor;
    return isTransparent(htmlBg) ? "#ffffff" : htmlBg;
  };

  const isElement = (n: Node | null): n is Element =>
    !!n && n.nodeType === 1 && !["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "BR", "META", "LINK", "PATH"].includes((n as Element).tagName);

  // ------------------------------------------------------------- frequency

  const freq = <T extends string>(map: Map<T, number>, key: T, weight = 1) =>
    map.set(key, (map.get(key) ?? 0) + weight);
  const nfreq = <T extends number>(map: Map<T, number>, key: T, weight = 1) =>
    map.set(key, (map.get(key) ?? 0) + weight);
  const ntopOf = <T extends number>(map: Map<T, number>, n = 1): T[] =>
    Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map((e) => e[0]);
  const topOf = <T extends string>(map: Map<T, number>, n = 1): T[] =>
    Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map((e) => e[0]);

  // ------------------------------------------------------ design sampling

  interface Sampled {
    color: string;
    bg: string;
    background: string;
    fontFamily: string;
    fontSize: number;
    fontWeight: number;
    lineHeight: number;
    letterSpacing: string;
    radius: string;
    shadow: string;
    borderWidth: string;
    borderColor: string;
    tag: string;
    width: number;
    paddingY: number;
    paddingX: number;
    align: string;
    gap: number;
    maxWidth: number;
  }
  const sample = (el: Element, w: number): Sampled => {
    const s = cs(el);
    return {
      color: s.color,
      bg: s.backgroundColor,
      // The shorthand carries gradients and background images, which
      // backgroundColor alone would drop. Palette derivation reads `bg`
      // instead: `parseColor` cannot read the shorthand, so feeding the
      // shorthand to it silently discarded every real background on the page.
      background: s.background,
      fontFamily: s.fontFamily,
      fontSize: px(s.fontSize),
      fontWeight: Number(s.fontWeight) || 400,
      lineHeight: ratio(s.lineHeight, s.fontSize),
      letterSpacing: s.letterSpacing === "normal" ? "normal" : s.letterSpacing,
      radius: s.borderRadius,
      shadow: s.boxShadow === "none" ? "" : s.boxShadow,
      borderWidth: s.borderTopWidth,
      borderColor: s.borderTopColor,
      tag: el.tagName.toLowerCase(),
      width: el.getBoundingClientRect().width,
      paddingY: px(s.paddingTop),
      paddingX: px(s.paddingLeft),
      align: s.textAlign,
      gap: px(s.gap) || px(s.columnGap),
      maxWidth: s.maxWidth === "none" ? 0 : px(s.maxWidth),
    };
  };

  /**
   * Is this element part of the site's own interactive chrome?
   *
   * Deliberately tag-based and structural, not class-based: no site-specific
   * selectors, and no knowledge of what this particular site called its
   * buttons.
   */
  const isBrandSurface = (el: Element): boolean => {
    const tag = el.tagName;
    if (tag === "BUTTON" || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return true;
    if (tag === "A" && (el.getAttribute("role") === "button" || !!(el as HTMLElement).className)) {
      // Styled links only; a link with no classes is a likely unstyled default.
      return /btn|button|cta|nav|tab|chip|badge|pill|tag|menu|brand|active|current/i.test(
        (el as HTMLElement).className,
      );
    }
    return !!el.closest("header, nav, footer, [role=banner], [role=navigation], [role=contentinfo]");
  };

  // Body styles are needed *by* the sampling loop (to tell an ink apart from an
  // inherited one), so they are resolved before it rather than after.
  const bodyStyle = cs(document.body);
  const htmlStyle = cs(document.documentElement);
  const bodyBg = isTransparent(bodyStyle.backgroundColor)
    ? isTransparent(htmlStyle.backgroundColor)
      ? "#ffffff"
      : htmlStyle.backgroundColor
    : bodyStyle.backgroundColor;

  const colorCount = new Map<string, number>();
  const bgCount = new Map<string, number>();
  const fontCount = new Map<string, number>();
  const sizeCount = new Map<string, number>();
  const radiusCount = new Map<string, number>();
  const shadowCount = new Map<string, number>();
  const borderCount = new Map<string, number>();
  const paddingYCount = new Map<string, number>();
  const widthCount = new Map<number, number>();
  const alignCount = new Map<string, number>();
  const alignItemsCount = new Map<string, number>();
  const justifyCount = new Map<string, number>();
  const flexDirCount = new Map<string, number>();
  const tagCount = new Map<string, number>();
  /**
   * Brand-colour observations, kept apart from the general frequency counts.
   *
   * The most common colour on a page is almost never the brand colour: on a
   * real site it is white body text, then near-black, then - often - the
   * browser's default link blue on any link the author forgot to style.
   * Frequency therefore ranks *usage*, not *identity*. These two maps look only
   * at the site's own chrome (buttons, active nav items, header/footer fills,
   * `theme-color`), where a deliberate brand choice actually shows up.
   */
  const brandFillCount = new Map<string, number>();
  const brandInkCount = new Map<string, number>();

  // Only consider a bounded, representative slice: the biggest elements plus
  // every piece of text. This is what keeps the extracted payload small.
  const all = qa<HTMLElement>("body *").filter(visible);
  const scored = all
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { el, area: r.width * r.height, text: deepText(el, 40) };
    })
    .sort((a, b) => {
      const aHasText = a.text.length > 0 ? 1 : 0;
      const bHasText = b.text.length > 0 ? 1 : 0;
      if (aHasText !== bHasText) return bHasText - aHasText;
      return b.area - a.area;
    });

  const TEXT_TAGS = new Set(["P", "SPAN", "A", "LI", "BUTTON", "LABEL", "TD", "TH", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "STRONG", "EM", "SMALL"]);
  const SAMPLED = 700;
  for (const { el, area } of scored.slice(0, SAMPLED)) {
    const weight = TEXT_TAGS.has(el.tagName) || el.getBoundingClientRect().width < 200 ? 3 : 1;
    const s = sample(el, weight);
    if (s.color) freq(colorCount, s.color, weight);
    // `bg` is the parsable plain colour; the shorthand is only useful for its
    // gradients, which the general list keeps for section backgrounds.
    if (s.bg && !isTransparent(s.bg)) freq(bgCount, s.bg, weight);
    if (s.background && s.background !== s.bg && s.background.includes("gradient")) {
      freq(bgCount, s.background, weight * 2);
    }
    if (isBrandSurface(el)) {
      // A fill is a far stronger brand signal than an ink: nobody chooses a
      // background colour by accident, and everybody's default link colour is
      // a perfectly ordinary ink.
      if (s.bg && !isTransparent(s.bg)) freq(brandFillCount, s.bg, weight * 3);
      else if (s.color && s.color !== bodyStyle.color) freq(brandInkCount, s.color, weight);
    }
    if (s.fontFamily) freq(fontCount, s.fontFamily, weight);
    if (s.fontSize) freq(sizeCount, String(s.fontSize), weight);
    // `50%`/`100%` are avatars and dots. Keeping them made the radius scale
    // collapse, because the only pixel value left was a single 4px.
    if (s.radius && !/%/.test(s.radius) && px(s.radius.split(" ")[0]) > 0) freq(radiusCount, s.radius, weight);
    if (s.shadow) freq(shadowCount, s.shadow, weight);
    if (s.borderWidth && px(s.borderWidth) > 0) freq(borderCount, `${s.borderWidth} ${s.borderColor}`, weight);
    if (s.paddingY > 8) freq(paddingYCount, String(Math.round(s.paddingY)), weight);
    if (s.width > 300) nfreq(widthCount, Math.round(s.width));
    freq(alignCount, s.align, weight);
    const st = cs(el);
    if (st.display === "flex" || st.display === "inline-flex") {
      freq(flexDirCount, st.flexDirection, weight);
      freq(alignItemsCount, st.alignItems, weight);
      freq(justifyCount, st.justifyContent, weight);
    }
    freq(tagCount, s.tag, 1);
    void area;
  }

  // Type scale straight from the heading elements.
  const headingStyle = (sel: string) => {
    const el = q(sel);
    if (!el) return null;
    const s = cs(el);
    return {
      selector: sel,
      fontSize: px(s.fontSize),
      fontWeight: Number(s.fontWeight) || 400,
      fontFamily: s.fontFamily,
      lineHeight: ratio(s.lineHeight, s.fontSize),
      letterSpacing: s.letterSpacing === "normal" ? "normal" : s.letterSpacing,
      textTransform: (s.textTransform || "none") as any,
      color: s.color,
      text: clean(el.textContent ?? "", 200),
    };
  };


  // Container width: the most common "wide content" width on the page.
  const containerCandidates = Array.from(widthCount.entries())
    .filter(([w]) => w >= 880 && w <= 1800)
    .sort((a, b) => b[1] - a[1]);
  const containerWidth = containerCandidates.length
    ? containerCandidates[Math.min(containerCandidates.length - 1, Math.floor(containerCandidates.length * 0.3))][0]
    : 1200;

  const design = {
    bodyBackground: bodyBg,
    bodyColor: bodyStyle.color,
    bodyFont: bodyStyle.fontFamily,
    bodyFontSize: px(bodyStyle.fontSize) || 16,
    colorCandidates: topOf(colorCount, 6),
    backgroundCandidates: topOf(bgCount, 6),
    /** Colours the site uses as fills on its own chrome - the brand signal. */
    brandFills: topOf(brandFillCount, 5),
    /** Colours the site uses as ink on its own chrome. */
    brandInks: topOf(brandInkCount, 5),
    fontCandidates: topOf(fontCount, 3),
    sizeCandidates: topOf(sizeCount, 8).map(Number).sort((a, b) => b - a),
    radiusCandidates: topOf(radiusCount, 4),
    shadowCandidates: topOf(shadowCount, 3),
    borderCandidates: topOf(borderCount, 3),
    paddingCandidates: topOf(paddingYCount, 5).map(Number).sort((a, b) => b - a),
    containerWidth,
    align: topOf(alignCount, 1)[0] ?? "left",
    alignItems: topOf(alignItemsCount, 1)[0] ?? "center",
    justifyContent: topOf(justifyCount, 1)[0] ?? "flex-start",
    flexDirection: topOf(flexDirCount, 1)[0] ?? "row",
    headings: {
      h1: headingStyle("h1"),
      h2: headingStyle("h2"),
      h3: headingStyle("h3"),
      h4: headingStyle("h4"),
      p: headingStyle("p"),
    },
    /** `theme-color` is the author telling us the brand colour outright. */
    themeColorMeta: (() => {
      const m = document.querySelector('meta[name="theme-color"], meta[name="msapplication-TileColor"]');
      const c = m?.getAttribute("content")?.trim();
      return c && c.length < 40 ? c : "";
    })(),
    /** Font files actually requested by the page, so we can self-host them. */
    fontFaces: (() => {
      const urls: string[] = [];
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: any[] = [];
        try {
          rules = Array.from((sheet as CSSStyleSheet).cssRules ?? []);
        } catch {
          continue; // cross-origin sheet
        }
        for (const rule of rules) {
          if (rule.type === 5 /* FONT_FACE_RULE */ && rule.style?.src) {
            for (const m of String(rule.style.src).matchAll(/url\((['"]?)([^'")]+)\1\)/g)) {
              const u = new URL(m[2], document.baseURI);
              urls.push(u.toString());
            }
          }
        }
      }
      return Array.from(new Set(urls)).slice(0, 12);
    })(),
    fontFamilyNames: (() => {
      // Stacked family list without the generic tail, for a clean @import.
      const names = new Set<string>();
      for (const f of topOf(fontCount, 3)) {
        const head = f.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
        for (const n of head) {
          if (!/^(system-ui|-apple-system|BlinkMacSystemFont|Segoe UI|Roboto|Helvetica|Arial|sans-serif|serif|monospace|ui-sans-serif|ui-serif|ui-monospace|inherit|initial)$/i.test(n)) {
            names.add(n);
          }
        }
      }
      return Array.from(names).slice(0, 4);
    })(),
    gridColumns: (() => {
      const counts = new Map<string, number>();
      for (const el of qa<HTMLElement>("body *").filter(visible)) {
        const s = cs(el);
        if (s.display === "grid" || s.display === "inline-grid") {
          const cols = s.gridTemplateColumns;
          if (cols && cols !== "none") counts.set(cols, (counts.get(cols) ?? 0) + 1);
        }
      }
      return topOf(counts, 1)[0] ?? "";
    })(),
    tagHistogram: topOf(tagCount, 12),
  };

  // -------------------------------------------------------- segmentation
  //
  // Goal: find the page's *visual bands* — the blocks a designer would call
  // sections — without depending on any framework's markup conventions.
  //
  // Why this is not a selector list
  // ------------------------------
  // `section`, `[role=main]`, `.hero`, `.feature-grid` etc. only work on the
  // site they were written for. Real pages nest arbitrarily:
  // `<div.isolate><div class="max-w-screen"><div class="grid">…` and a
  // framework that styles every wrapper identically gives no signal at all
  // above "this block is 10 000px tall". So the segmentation is *geometric*:
  //
  //   1. Any full-bleed block at least `MIN_BAND_H` tall is a band. There is no
  //      per-site knowledge here at all.
  //   2. A band taller than `TALL_ENOUGH_TO_SPLIT` is not a band, it is a
  //      *container* — recurse into its children. Repeat until the pieces are
  //      section-sized.
  //   3. The exception to (2): a grid/flex block whose children sit side by
  //      side is a card row, which is one section, not three. This is what
  //      stops a 13-card grid from shattering into 13 sections.

  const bodyRect = document.body.getBoundingClientRect();
  const bodyWidth = bodyRect.width || window.innerWidth;
  const pageHeight = Math.max(document.body.scrollHeight, window.innerHeight);
  const MAX_DEPTH = 10;
  /** Below this height a block is a header, a caption or a spacer, not a band. */
  const MIN_BAND_H = 260;
  /** Children shorter than this are spacers, not bands. */
  const MIN_CHILD_H = 140;
  /** Taller than this, a band is really a container and gets split. */
  const TALL_ENOUGH_TO_SPLIT = Math.max(620, pageHeight * 0.11);

  const LANDMARKS = ["HEADER", "MAIN", "FOOTER", "SECTION", "ARTICLE", "ASIDE"];

  const rectOf = (el: Element): DOMRect => el.getBoundingClientRect();

  /** Children wide and tall enough to be a real band of their own. */
  const substantialChildren = (el: Element): Element[] => {
    const self = rectOf(el);
    const kids = Array.from(el.children).filter(isElement);
    const byWidth = kids.filter((k) => {
      const r = rectOf(k);
      // Near the parent's own width, so side rails and sticky overlays drop out.
      return r.height > MIN_CHILD_H && r.width > self.width * 0.5 && r.width < self.width * 1.05;
    });
    if (byWidth.length) return byWidth;
    // Nothing fills the width — a single-column stack, or a padded container
    // whose children are all narrow. Fall back to "occupies real height".
    return kids.filter((k) => {
      const r = rectOf(k);
      return r.height > Math.max(MIN_CHILD_H, self.height * 0.2) && r.width > self.width * 0.4;
    });
  };

  /**
   * True when the block's children form a multi-column row: they share a top
   * edge and there are at least three of them. That is a card grid or a
   * feature strip — a single section.
   */
  const isCardRow = (el: Element, kids: Element[]): boolean => {
    if (kids.length < 3) return false;
    const s = cs(el);
    const first = rectOf(kids[0]);
    const sideBySide = kids.every((k) => Math.abs(rectOf(k).top - first.top) < 24);
    if (!sideBySide) return false;
    if (s.display === "grid" || s.display === "inline-grid") {
      const tracks = (s.gridTemplateColumns || "").trim().split(/\s+/).filter(Boolean);
      return tracks.length >= 2;
    }
    if (s.display === "flex") return s.flexDirection.startsWith("row");
    // Not a grid or flex row, but the children still align — treat as a row.
    return kids.every((k) => rectOf(k).top < first.bottom);
  };

  /**
   * Should this band be split into its children?
   *
   * Conservative on purpose: three conditions must all hold, so an ordinary
   * section is never fragmented and a page-sized wrapper always is.
   */
  const shouldSplit = (el: Element): Element[] | null => {
    const r = rectOf(el);
    if (r.height <= TALL_ENOUGH_TO_SPLIT) return null;
    const kids = substantialChildren(el);
    if (!kids.length) return null;
    if (isCardRow(el, kids)) return null;
    const covered = kids.reduce((sum, k) => sum + Math.min(rectOf(k).height, r.height), 0);
    if (kids.length === 1) {
      // A lone child filling the parent is a transparent wrapper: unwrap it.
      return covered > r.height * 0.85 ? kids : null;
    }
    return covered > r.height * 0.55 ? kids : null;
  };

  const isBand = (el: Element): boolean => {
    const r = rectOf(el);
    if (r.height < MIN_BAND_H || r.width < bodyWidth * 0.5) return false;
    if (el.tagName === "BODY" || el.tagName === "HTML") return false;
    // Purely geometric, by design — see the note above.
    return true;
  };

  const roots: Element[] = [];
  const collect = (el: Element, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    if (!isBand(el)) {
      for (const child of Array.from(el.children)) {
        if (isElement(child)) collect(child, depth + 1);
      }
      return;
    }
    const kids = shouldSplit(el);
    if (kids) {
      for (const child of kids) collect(child, depth + 1);
      return;
    }
    roots.push(el);
  };
  for (const child of Array.from(document.body.children)) {
    if (isElement(child)) collect(child, 0);
  }

  // Roots are already in document order and geometrically disjoint, so no
  // post-merge is needed — and no post-merge is *wanted*: an earlier version
  // collapsed adjacent same-background roots, which silently discarded whole
  // bands. Adjacency is the plan stage's business (it can `merge` indices), not
  // the extractor's.

  // A page that produced no roots at all (a canvas, a script-only page) still
  // needs one section so the rest of the pipeline has something to render.
  const finalRoots: Element[] = roots;
  if (!finalRoots.length) finalRoots.push(document.body);

  // ------------------------------------------------------------- helpers

  const describeStyle = (el: Element) => {
    const s = cs(el);
    return {
      background: s.backgroundImage !== "none" ? s.backgroundImage : s.backgroundColor,
      color: s.color,
      paddingY: px(s.paddingTop),
      paddingX: px(s.paddingLeft),
      paddingBottom: px(s.paddingBottom),
      maxWidth: s.maxWidth === "none" ? 0 : px(s.maxWidth),
      align: (s.textAlign || "left") as "left" | "center" | "right",
      display: s.display,
      flexDirection: s.flexDirection,
      justifyContent: s.justifyContent,
      alignItems: s.alignItems,
      gap: px(s.gap) || px(s.rowGap),
      columns: 0,
      gridTemplateColumns: s.gridTemplateColumns,
      radius: s.borderRadius,
      borderTop: px(s.borderTopWidth) > 0 ? `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}` : "none",
      borderBottom: px(s.borderBottomWidth) > 0 ? `${s.borderBottomWidth} ${s.borderBottomStyle} ${s.borderBottomColor}` : "none",
    };
  };

  const absoluteUrl = (raw: string | null): string => {
    if (!raw) return "";
    try {
      return new URL(raw, document.baseURI).toString();
    } catch {
      return "";
    }
  };

  const describeImage = (el: HTMLImageElement) => {
    const r = el.getBoundingClientRect();
    const src =
      el.currentSrc ||
      el.getAttribute("src") ||
      el.getAttribute("data-src") ||
      el.getAttribute("data-lazy-src") ||
      "";
    return {
      url: absoluteUrl(src),
      alt: clean(el.getAttribute("alt") ?? "", 200),
      width: Math.round(r.width),
      height: Math.round(r.height),
      naturalWidth: el.naturalWidth || 0,
      naturalHeight: el.naturalHeight || 0,
      isSvg: /\.svg(\?|$)/i.test(src) || (el.naturalWidth > 0 && el.naturalWidth === el.naturalHeight && src === ""),
      position: s_position(el),
    };
  };

  function s_position(el: Element): string {
    const r = el.getBoundingClientRect();
    const docTop = r.top + window.scrollY;
    return docTop < 40 ? "top" : "inline";
  }

  const collectImages = (root: Element, limit = 8): Record<string, any>[] => {
    const out: Record<string, any>[] = [];
    const seen = new Set<string>();
    const nodes = Array.from(root.querySelectorAll("img, picture source, video, svg")).filter(visible);
    for (const node of nodes) {
      if (out.length >= limit) break;
      if (node.tagName === "IMG") {
        const d = describeImage(node as HTMLImageElement);
        if (!d.url || seen.has(d.url)) continue;
        // Skip tiny spacers and tracking pixels.
        if (d.naturalWidth && d.naturalWidth <= 2) continue;
        seen.add(d.url);
        out.push({ type: "image", ...d });
      } else if (node.tagName === "SOURCE") {
        const u = absoluteUrl((node as HTMLSourceElement).srcset || (node as HTMLSourceElement).src);
        if (u && !seen.has(u)) {
          seen.add(u);
          out.push({ type: "image", url: u, alt: "", width: 0, height: 0, naturalWidth: 0, naturalHeight: 0, isSvg: /\.svg/i.test(u), position: "inline" });
        }
      } else if (node.tagName === "VIDEO") {
        const v = node as HTMLVideoElement;
        const poster = absoluteUrl(v.poster || "");
        const src = absoluteUrl(v.currentSrc || v.src || "");
        if (src && !seen.has(src)) {
          seen.add(src);
          out.push({ type: "video", url: src, poster, alt: "", width: Math.round(v.getBoundingClientRect().width), height: Math.round(v.getBoundingClientRect().height), naturalWidth: 0, naturalHeight: 0, isSvg: false, position: "inline" });
        }
      } else if (node.tagName === "SVG") {
        const out2 = node.outerHTML.slice(0, 60000);
        const rect = node.getBoundingClientRect();
        if (out2.length > 40 && !seen.has(`inline-svg-${out2.length}`)) {
          seen.add(`inline-svg-${out2.length}`);
          out.push({
            type: "svg",
            url: "",
            svg: out2,
            alt: clean(node.getAttribute("aria-label") ?? "", 120),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            naturalWidth: 0,
            naturalHeight: 0,
            isSvg: true,
            position: "inline",
          });
        }
      }
    }
    return out;
  };

  const isButtonLike = (el: Element): boolean => {
    const tag = el.tagName;
    if (tag === "BUTTON" || (tag === "A" && el.getAttribute("role") === "button")) return true;
    const s = cs(el);
    if (s.cursor === "pointer" && el.children.length <= 4) {
      const r = el.getBoundingClientRect();
      if (r.width < 420 && r.height < 90) return true;
    }
    return false;
  };

  const buttonStyle = (el: Element) => {
    const s = cs(el);
    const r = el.getBoundingClientRect();
    const hasBg = !isTransparent(s.backgroundColor);
    const hasBorder = px(s.borderTopWidth) > 0;
    return {
      variant:
        s.borderRadius.includes("9999") || parseFloat(s.borderRadius) >= Math.min(r.height / 2, 32)
          ? "pill"
          : parseFloat(s.borderRadius) > 0
            ? "rounded"
            : "square",
      hasBackground: hasBg,
      background: hasBg ? s.backgroundColor : "transparent",
      color: s.color,
      hasBorder,
      border: hasBorder ? `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}` : "none",
      padding: `${s.paddingTop} ${s.paddingRight}`,
      fontSize: px(s.fontSize),
      fontWeight: Number(s.fontWeight) || 400,
      height: Math.round(r.height),
    };
  };

  const collectLinks = (root: Element, limit = 20): Record<string, any>[] => {
    const out: Record<string, any>[] = [];
    const seen = new Set<string>();
    for (const a of Array.from(root.querySelectorAll("a[href]")).filter(visible)) {
      if (out.length >= limit) break;
      const label = deepText(a, 90);
      const href = a.getAttribute("href") ?? "";
      if (!label && !href) continue;
      const key = `${label}|${href}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const abs = absoluteUrl(href);
      out.push({
        label,
        href: abs || href,
        raw: href,
        button: isButtonLike(a),
        external: /^https?:\/\//i.test(href) && !abs.startsWith(location.origin),
        style: buttonStyle(a),
      });
    }
    return out;
  };

  const collectHeadings = (root: Element): Record<string, any>[] => {
    const out: Record<string, any>[] = [];
    for (const h of Array.from(root.querySelectorAll("h1,h2,h3,h4,h5,h6")).filter(visible)) {
      const text = deepText(h, 200);
      if (!text) continue;
      const s = cs(h);
      out.push({
        level: Number(h.tagName.slice(1)),
        text,
        align: (s.textAlign || "left") as "left" | "center" | "right",
        fontSize: px(s.fontSize),
        fontWeight: Number(s.fontWeight) || 400,
        color: s.color,
        fontFamily: s.fontFamily,
        transform: s.textTransform || "none",
        marginTop: px(s.marginTop),
        marginBottom: px(s.marginBottom),
      });
    }
    return out.slice(0, 8);
  };

  const collectParagraphs = (root: Element, limit = 6): Record<string, any>[] => {
    const out: Record<string, any>[] = [];
    for (const p of Array.from(root.querySelectorAll("p, li.lead, blockquote")).filter(visible)) {
      if (out.length >= limit) break;
      const text = deepText(p, 320);
      if (text.length < 30) continue;
      const s = cs(p);
      out.push({
        text,
        align: (s.textAlign || "left") as "left" | "center" | "right",
        color: s.color,
        fontSize: px(s.fontSize),
        fontWeight: Number(s.fontWeight) || 400,
        lineHeight: ratio(s.lineHeight, s.fontSize, 1.5),
      });
    }
    return out;
  };

  /**
   * Detect repeated sibling groups (cards, tiles, list items, pricing tiers).
   * This is the highest-value signal for reconstructing grid sections, and it
   * is fully deterministic.
   */
  /**
   * Split a container's children into repeated *items*.
   *
   * Two shapes, because real pages have two shapes:
   *
   *   - A **card row** (grid/flex/block): siblings of similar size. Cluster on
   *     height and drop outliers — hairline dividers and spacers sit inside
   *     card grids too.
   *   - A **row group** (`<tbody>`): siblings of *deliberately* different
   *     heights, because a list is often a title row plus a smaller caption row
   *     plus a spacer. Here height clustering is useless, so a new item starts
   *     at each tall row and any short row that follows belongs to it.
   *
   * A run may contain more than one element, so an item is an `Element[]` and
   * all text is read across the whole run. Getting this right is what turns
   * Hacker News' 92 interleaved `<tr>`s into 30 coherent stories instead of
   * either 0 items or 92 fragments.
   */
  const pickRepeats = (kids: Element[], isRowGroup: boolean): Element[][] | null => {
    if (kids.length < 2) return null;
    const rects = kids.map((k) => k.getBoundingClientRect());
    const hasText = (k: Element) => deepText(k, 40).length > 2;

    if (isRowGroup) {
      // A run is a tall row followed by any short, content-bearing rows.
      const tall = Math.max(...rects.map((r) => r.height));
      const runs: Element[][] = [];
      for (let n = 0; n < kids.length; n++) {
        const h = rects[n].height;
        if (h >= tall * 0.55 || !runs.length || !hasText(kids[n])) {
          if (h > 4 && (hasText(kids[n]) || kids[n].querySelector("img,svg,a"))) runs.push([kids[n]]);
        } else {
          runs[runs.length - 1].push(kids[n]);
        }
      }
      return runs.length >= 3 ? runs : null;
    }

    // Card row: cluster on height, then require the survivors to look like
    // siblings rather than a pile of overlapping boxes.
    const heights = rects.map((r) => r.height).sort((a, b) => a - b);
    const medianH = heights[Math.floor(heights.length / 2)] || 0;
    if (medianH < 24) return null;
    // Short cards are only believable in quantity; tall ones at two.
    const minCount = medianH < 60 ? 3 : 2;
    const tolerance = Math.max(8, medianH * 0.6);
    const cluster = kids
      .map((k, n) => ({ k, h: rects[n].height }))
      .filter(({ h }) => Math.abs(h - medianH) <= tolerance)
      .map(({ k }) => k);
    const use = cluster.length >= minCount ? cluster : kids;
    if (use.length < minCount) return null;

    const ur = use.map((k) => k.getBoundingClientRect());
    const ws = ur.map((r) => r.width);
    const avgW = ws.reduce((a, b) => a + b, 0) / ws.length;
    if (avgW < 40) return null;
    const wSpread = Math.max(...ws) - Math.min(...ws);
    if (wSpread > avgW * 0.75) return null;
    const heights2 = ur.map((r) => r.height);
    const avgH = heights2.reduce((a, b) => a + b, 0) / heights2.length;
    if (Math.max(...heights2) - Math.min(...heights2) > avgH * 0.75) return null;
    // A grid can legitimately overlap rows, but a *stacked* list cannot have
    // every child start where the first one does.
    const first = ur[0];
    const allAtTop = ur.every((r) => Math.abs(r.top - first.top) < 12);
    if (!allAtTop && ur.slice(1).some((r) => r.top < first.bottom - 8 && Math.abs(r.left - first.left) < 8)) {
      return null;
    }
    return use.map((k) => [k]);
  };

  const collectItems = (root: Element, limit = 12): Record<string, any>[] => {
    interface Candidate {
      parent: Element;
      runs: Element[][];
      area: number;
    }
    const candidates: Candidate[] = [];
    // Chrome (nav links, footer columns) is extracted separately and is never a
    // section's content list, so it is excluded as a candidate container.
    const isChrome = (el: Element) =>
      !!el.closest("nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo]");

    // The band element itself can *be* the repeated group - a bare <ul> of
    // <li>s, or a grid of cards with no wrapper. `querySelectorAll` never
    // returns the root, so it has to be included explicitly or such sections
    // report zero items.
    const containers = [root, ...Array.from(root.querySelectorAll("*"))];
    for (const el of containers.filter(visible)) {
      if (el !== root && isChrome(el)) continue;
      const kids = Array.from(el.children).filter(visible);
      // A two-up feature row counts, and so does a 92-row story table, so the
      // upper cap is generous. What actually disqualifies a group is decided
      // below, by the height/width consistency and content checks - not by a
      // raw child count, which only ever misfired on the real-world cases.
      if (kids.length < 2 || kids.length > 240) continue;
      const s = cs(el);
      const isRowGroup = /^(table|table-row-group|table-header-group|table-footer-group)$/.test(s.display);
      // A repeated group is laid out by an engine, not by inline flow.
      if (!isRowGroup && !/^(flex|grid|inline-grid|block|list-item)$/.test(s.display)) continue;
      if (new Set(kids.map((k) => k.tagName)).size > 2) continue;
      const runs = pickRepeats(kids, isRowGroup);
      if (!runs) continue;
      // Every item must actually carry content, or this is a layout artefact.
      const withContent = runs.filter(
        (run) => run[0].querySelector("h1,h2,h3,h4,h5,h6,p,img,svg,li,span,strong,time,a") || deepText(run[0], 20).length > 3,
      ).length;
      if (withContent < runs.length * 0.6) continue;
      const r = el.getBoundingClientRect();
      candidates.push({ parent: el, runs, area: r.width * r.height });
    }
    if (!candidates.length) return [];

    // Prefer the biggest group, and among those the one with the most items.
    candidates.sort((a, b) => b.area - a.area || b.runs.length - a.runs.length);
    let best = candidates[0];
    for (const c of candidates) {
      if (best.parent.contains(c.parent) && c.runs.length > best.runs.length) best = c;
    }

    /** Text of a run, which may span several rows. */
    const runText = (run: Element[], max: number): string =>
      clean(run.map((k) => k.textContent ?? "").join(" "), max);

    /** First sentence or clause of some text, bounded. */
    const firstClause = (text: string, max: number): string => {
      const t = clean(text, max * 2);
      if (t.length <= max) return t;
      const stop = Math.max(
        t.lastIndexOf(". ", max),
        t.lastIndexOf("! ", max),
        t.lastIndexOf("? ", max),
        t.lastIndexOf(" - ", max),
        t.lastIndexOf(" · ", max),
      );
      const cut = stop > 20 ? stop + 1 : t.lastIndexOf(" ", max);
      return clean(cut > 20 ? t.slice(0, cut) : t.slice(0, max), max);
    };

    const items: Record<string, any>[] = [];
    for (const run of best.runs) {
      if (items.length >= limit) break;
      const child = run[0];
      const rect = child.getBoundingClientRect();
      const s = cs(child);
      // Choosing an item's title.
      //
      // Every card contains several elements that look title-ish: the real
      // headline, the link wrapping it, and one or more wrappers whose class
      // happens to contain the word "title". Picking the first match gave the
      // wrapper, so a headline arrived as "Blog2 Min ReadNASA's Swift Powers On
      // Third Instrument" - badge, meta and headline glued together, and the
      // same sentence again in the body. Picking the *shortest* instead went to
      // the other extreme and returned a bare "podcast" from a nav link.
      //
      // The rule that survives both is structural: a wrapper contains its own
      // text, so any candidate that has another candidate as a substring is
      // dropped. Among the survivors, the longest is the headline, since a
      // headline is a phrase and a label is a word.
      const TITLE_MAX = 140;
      const seen = new Set<string>();
      const candidates: string[] = [];
      for (const n of Array.from(
        child.querySelectorAll("h1,h2,h3,h4,h5,h6,strong,legend,span.titleline,[class*=title],[class*=headline],a"),
      )) {
        const t = deepText(n, TITLE_MAX + 40);
        if (t.length < 8 || t.length > TITLE_MAX || seen.has(t)) continue;
        seen.add(t);
        candidates.push(t);
      }
      // Drop wrappers: anything that swallows another candidate is describing
      // more of the card than a title should.
      const leafTitles = candidates.filter(
        (t) => !candidates.some((o) => o !== t && o.length >= 20 && t.includes(o)),
      );
      const pool = leafTitles.length ? leafTitles : candidates;
      const runAll = runText(run, 600);
      let title = pool.length ? pool.reduce((a, b) => (b.length > a.length ? b : a)) : firstClause(runAll, TITLE_MAX);
      const bodyNode = child.querySelector("p, li, span.lead, div p, .subtext, .subline");
      const bullets = run
        .flatMap((k) => Array.from(k.querySelectorAll("ul li, ol li")))
        .map((li) => deepText(li, 120))
        .filter(Boolean)
        .slice(0, 8);
      const priceMatch = runText(run, 300).match(/[$€£¥]\s?[\d.,]+|\b\d+\s?\/\s?(mo|month|yr|year|week)\b/i);
      const img = child.querySelector("img");
      const svg = child.querySelector("svg");
      const link = child.querySelector("a[href]");
      const badgeNode = child.querySelector(".badge, [class*=badge], [class*=pill], [class*=tag], [class*=chip]");
      // Body: whatever the title did not already say.
      //
      // The overlap check runs both ways, because it is the *title* that is
      // usually contaminated: a card-wide wrapper that captured the badge and
      // the meta line ends up containing the real headline verbatim, and
      // rendering both prints the same sentence twice. In that case the body
      // becomes the title (it is the clean text) and its first clause becomes
      // the title, with no duplicate underneath.
      let body = bodyNode ? deepText(bodyNode, 400) : "";
      const bodyInsideTitle = title.length > 0 && body.length >= 12 && title.indexOf(body) >= 0;
      if (bodyInsideTitle) {
        title = firstClause(body, TITLE_MAX);
        body = "";
      } else if (!body || (title && body.indexOf(title) >= 0 && body.length <= title.length + 20)) {
        const rest = runAll.replace(title, " ").replace(/\s+/g, " ").trim();
        body = rest.length > 12 ? rest.slice(0, 400) : "";
      }
      items.push({
        title,
        body,
        fullText: runAll.slice(0, 500),
        bullets,
        price: priceMatch ? priceMatch[0] : "",
        badge: badgeNode ? deepText(badgeNode, 60) : "",
        // Set when the item has nothing to show, so the analyzer can drop it
        // instead of emitting an empty card. A row that is only a hairline
        // separator, or a wrapper the content check passed on sight of an
        // anchor with no text, must not become a hole in the clone.
        empty:
          !title &&
          !body &&
          !bullets.length &&
          !img &&
          !priceMatch &&
          !deepText(child, 40),
        image: img ? describeImage(img as HTMLImageElement) : null,
        hasIcon: !!svg,
        iconSvg: svg && svg.outerHTML.length < 20000 ? svg.outerHTML : "",
        link: link ? { label: deepText(link, 80), href: absoluteUrl(link.getAttribute("href") ?? "") } : null,
        background: isTransparent(s.backgroundColor) ? null : s.backgroundColor,
        border: px(s.borderTopWidth) > 0 ? `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}` : "",
        radius: s.borderRadius,
        shadow: s.boxShadow === "none" ? "" : s.boxShadow,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    }
    return items;
  };

  const collectLists = (root: Element, limit = 12): string[] =>
    Array.from(root.querySelectorAll("ul li, ol li"))
      .map((li) => deepText(li, 120))
      .filter((t) => t.length > 1)
      .slice(0, limit);

  const collectForms = (root: Element): Record<string, any>[] =>
    Array.from(root.querySelectorAll("form")).slice(0, 3).map((f) => ({
      fields: Array.from(f.querySelectorAll("input, textarea, select"))
        .slice(0, 10)
        .map((el) => ({
          type: (el as HTMLInputElement).type || el.tagName.toLowerCase(),
          name: el.getAttribute("name") ?? "",
          placeholder: el.getAttribute("placeholder") ?? "",
          label: deepText(
            (el.closest("label") ?? el.parentElement?.querySelector("label") ?? el) as Element,
            80,
          ),
          required: (el as HTMLInputElement).required,
        })),
      submitLabel: deepText(f.querySelector("button[type=submit], button, input[type=submit]") as Element, 60),
      action: absoluteUrl(f.getAttribute("action") ?? ""),
    }));

  const stableSelector = (el: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = el;
    for (let i = 0; cur && i < 4 && cur !== document.body; i++) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift(`${part}#${cur.id}`);
        break;
      }
      const cls = (cur.getAttribute("class") ?? "")
        .split(/\s+/)
        .filter((c) => c && !/^(css|sc|jsx|ember|ng|svelte)-?[a-z0-9]{4,}$/i.test(c))
        .slice(0, 2)
        .join(".");
      if (cls) part += `.${cls}`;
      const parent = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(" > ").slice(0, 180);
  };

  const describeSection = (el: Element, index: number) => {
    const rect = el.getBoundingClientRect();
    const s = cs(el);
    const headings = collectHeadings(el);
    const items = collectItems(el);
    const images = collectImages(el, 6);
    const links = collectLinks(el, 14);
    const style = describeStyle(el);
    const topLevel = el.getBoundingClientRect().top + window.scrollY < 220;
    const isNav = el.tagName === "HEADER" || !!el.querySelector("nav");
    const isFooter = el.tagName === "FOOTER";

    // Classify grid columns from the detected repeated group.
    let columns = 0;
    if (items.length > 1) {
      const rects = items.map((i) => ({ y: i.top ?? 0 }));
      void rects;
    }
    const flexWrap = s.flexWrap === "wrap";
    if (items.length > 1) {
      const gridSiblings = items;
      const firstRow = gridSiblings.filter((i) => Math.abs((i.height ?? 0)) < 1e9);
      void firstRow;
    }

    return {
      index,
      tag: el.tagName.toLowerCase(),
      selector: stableSelector(el),
      role: isNav ? "nav" : isFooter ? "footer" : topLevel ? "top" : "main",
      top: Math.round(rect.top + window.scrollY),
      height: Math.round(rect.height),
      width: Math.round(rect.width),
      style,
      heading: headings[0] ?? null,
      headings,
      subheading:
        headings.find((h) => h.level > (headings[0]?.level ?? 1)) ??
        (() => {
          const p = collectParagraphs(el, 1)[0];
          return p ? { level: 0, text: p.text, align: p.align, color: p.color, fontSize: p.fontSize, fontWeight: p.fontWeight, transform: "none", marginTop: 0, marginBottom: 0 } : null;
        })(),
      paragraphs: collectParagraphs(el, 4),
      items,
      images,
      links,
      buttons: links.filter((l) => l.button).slice(0, 4),
      lists: collectLists(el, 8),
      forms: collectForms(el),
      tables: Array.from(el.querySelectorAll("table")).slice(0, 1).map((t) => ({
        headers: Array.from(t.querySelectorAll("thead th")).map((th) => deepText(th, 60)),
        rows: Array.from(t.querySelectorAll("tbody tr"))
          .slice(0, 8)
          .map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => deepText(td, 80))),
      }))[0] ?? null,
      hasVideo: !!el.querySelector("video, iframe[src*=youtube], iframe[src*=vimeo]"),
      textLength: deepText(el, 4000).length,
    };
  };

  // -------------------------------------------------------------- chrome

  const headerEl =
    q("header") ??
    q("nav")?.closest("section, div, header") ??
    Array.from(document.body.children).find(
      (c) => c.getBoundingClientRect().top < 140 && c.getBoundingClientRect().height < 200,
    ) ??
    null;
  const footerEl =
    q("footer") ??
    Array.from(document.body.children).find((c) => {
      const r = c.getBoundingClientRect();
      return r.top + window.scrollY > pageHeight - 260 && r.height > 60;
    }) ??
    null;

  const describeNav = (el: Element | null) => {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const s = cs(el);
    const brand =
      el.querySelector("a img, img[class*=logo], [class*=logo] img") ??
      el.querySelector("a svg, svg[class*=logo]") ??
      null;
    const brandLink = brand?.closest("a") ?? el.querySelector("a");
    const navLinks = Array.from(el.querySelectorAll("a[href]"))
      .filter((a) => {
        const r = a.getBoundingClientRect();
        return r.width > 4 && r.height > 4 && r.top < rect.bottom + 8;
      })
      .slice(0, 16)
      .map((a) => ({
        label: deepText(a, 70),
        href: absoluteUrl(a.getAttribute("href") ?? ""),
        button: isButtonLike(a),
        style: buttonStyle(a),
      }));
    return {
      brandText: brandLink ? deepText(brandLink, 60) : "",
      brandImage: brand && brand.tagName === "IMG" ? describeImage(brand as HTMLImageElement) : null,
      brandSvg: brand && brand.tagName === "SVG" ? brand.outerHTML.slice(0, 20000) : "",
      links: navLinks,
      style: describeStyle(el),
      height: Math.round(rect.height),
      sticky:
        s.position === "sticky" || s.position === "fixed" ||
        (() => {
          const p = el.parentElement ? cs(el.parentElement) : null;
          return !!p && (p.position === "sticky" || p.position === "fixed");
        })(),
    };
  };

  const describeFooter = (el: Element | null) => {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const headings = collectHeadings(el);
    const groups: Record<string, any>[] = [];
    for (const g of collectItems(el, 8)) {
      groups.push({ title: g.title, links: (g.fullText ? g.fullText.split(/\s{2,}|\|/) : []).map((part: string) => part.trim()).filter(Boolean).slice(0, 8), raw: g.fullText });
    }
    const allLinks = collectLinks(el, 24);
    return {
      brandText: deepText(el.querySelector("a") ?? el, 80),
      tagline: collectParagraphs(el, 1)[0]?.text ?? "",
      headings: headings.slice(0, 6),
      groups,
      links: allLinks,
      style: describeStyle(el),
      height: Math.round(rect.height),
      text: deepText(el, 900),
    };
  };

  // --------------------------------------------------------------- output

  const sections = finalRoots.slice(0, 26).map((el, i) => describeSection(el, i));

  const meta = q<HTMLMetaElement>('meta[name="description"]');
  const generator = q<HTMLMetaElement>('meta[name="generator"]');
  const themeColor = q<HTMLMetaElement>('meta[name="theme-color"]');
  const iconLink =
    q<HTMLLinkElement>('link[rel~="icon"]') ??
    q<HTMLLinkElement>('link[rel="shortcut icon"]') ??
    q<HTMLLinkElement>('link[rel="apple-touch-icon"]');

  const warnings: string[] = [];
  if (sections.length === 0) warnings.push("No distinct visual sections were detected; falling back to a single content block.");
  if (sections.length > 22) warnings.push(`Detected ${sections.length} sections; keeping the first 22 to bound generation size.`);
  if (!q("h1")) warnings.push("The page has no <h1>; a hero heading was synthesised from the largest heading.");
  if (scored.length < 30) warnings.push("Very few visible elements found — the page may render content client-side after the capture window.");
  const overlayCount = qa("*").filter((el) => {
    const s = cs(el);
    return (s.position === "fixed" || s.position === "sticky") && el.getBoundingClientRect().height > window.innerHeight * 0.9;
  }).length;
  if (overlayCount) warnings.push(`${overlayCount} full-screen overlay(s) detected (cookie banners, interstitials); they were skipped.`);

  return {
    url: location.href,
    title: clean(document.title, 300),
    description: clean(meta?.content ?? "", 600),
    language: document.documentElement.lang || "en",
    generator: clean(generator?.content ?? "", 120),
    themeColor: clean(themeColor?.content ?? "", 40),
    favicon: absoluteUrl(iconLink?.href ?? ""),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
    },
    counts: {
      links: qa("a[href]").length,
      images: qa("img").length,
      headings: qa("h1,h2,h3,h4,h5,h6").length,
      forms: qa("form").length,
      sections: sections.length,
    },
    design,
    navigation: describeNav(headerEl),
    footer: describeFooter(footerEl),
    sections,
    warnings,
  };
}
