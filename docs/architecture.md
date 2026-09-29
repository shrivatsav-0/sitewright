# Architecture

Sitewright turns a URL into a standalone, buildable website reconstruction.
This document describes the pipeline, the data contract, and the security
boundaries. It is written to be read alongside the code: every stage named
here has a module path.

## The pipeline

```
                       ┌────────────── deterministic ──────────────┐
 URL ─► extract ─► observe ─► interpret ─► spec ─► generate ─► validate
   │    crawler         analyzer     analyzer   generator  validator │
   │    extract-script                 (!)         │            │    │
   v                                       model   v            v    v
 reuse / URLs                          [compact      ]      repair loop  preview
 downstream link queue                  observations]         (bounded)   next start
```

Strict ordering matters. Each stage consumes the previous stage's *output
artifact*, not its internals:

| Stage | Module | Input artifact | Output artifact | Model involved? |
|---|---|---|---|---|
| Extract | `src/lib/crawler/` | URL | `<html>` + in-page record | no |
| Observe | `src/lib/analyzer/normalize.ts` | in-page record | `PageDigest` (colours, fonts, radii, shadows, sections, counts) | no |
| Interpret | `src/lib/analyzer/synthesize.ts`, `src/lib/analyzer/plan.ts` | `PageDigest` + sample screenshots | validated `WebsiteSpec` | yes (two narrow questions) |
| Generate | `src/lib/generator/` | `WebsiteSpec` | files in `generated/<id>/` | page composition on request |
| Validate | `src/lib/validator/build.ts` | files | pass/fail + diagnostics | repair: yes |
| Repair | `src/lib/validator/build.ts` | diagnostics | targeted fix or full regenerate | bounded |
| Preview | `src/lib/preview/server.ts` | built output | real `next start` on a range port | no |

### Extract (no model)

`extract-script.ts` is compiled by `scripts/build-extract.mjs` into
`extract-page.js`, an injectable script that runs inside the target page. It
records what a browser actually computed: the visible text and geometry of
every body element, computed colours and fonts, background fills, borders,
radii, shadows, each link's href and label, asset URLs and dimensions, and the
`<meta>` tags (`theme-color`, canonical URL, title, description). Everything
is weighted and capped before leaving the browser, so the payload is compact.

**The single most important invariant of the system: the model never sees the
page's HTML.** It sees the digest, which is the author's intent as computed by
a browser, stripped of markup. This is what makes the reconstruction faithful
and the model's word cheap (it interprets, never transcribes).

### Observe (no model)

`normalize.ts` turns the record into a `PageDigest`:

- `derivePalette` (in `color.ts`) picks tokens in order of trust:
  `<meta theme-color>` → fills on the page's own chrome → ink on that chrome
  → the general colour soup. The browser default link blue is penalised out
  of the primary and removed from the accent pool entirely, because it is not
  a design choice. See `tests/theme.test.ts` for the rules and the failures
  they prevent.
- Font sizes/weights/line-heights come from computed styles; a page with no
  `<h1>` uses its largest *observed* rendered size for the heading.
- Radii and shadows are observed scales, clamped to a usable band; a page
  that is deliberately square stays square.
- Section geometry (padding, columns, alignment, background) is measured per
  candidate band, and `buildSectionStyle` maps it into the `SectionStyle` the
  generator consumes.
- `contrastReport` records whether the chosen text/background pair is
  readable, so the panel can be honest about a low-contrast clone instead of
  silently shipping one.

### Interpret (model, free-first)

Two calls, never transcription:

1. `sitePlanUser` — "here are the page's sections and the page's tone, style
   and title; decide what each section *is*." When vision is enabled
   (`AI_USE_VISION`, default on), the fold screenshot and the largest per-section
   crops (`AI_MAX_SECTION_IMAGES`, default 2) are attached as reference images,
   so the model sees the actual photos before anything is generated — bounded,
   never the raw HTML. The prompt names the exact vocabulary (`NAV_VARIANTS`,
   `FOOTER_VARIANTS`, `SECTION_KINDS`) so the model cannot invent enums that
   fail validation.
2. `pageUser` — "given the measured sections and the plan, choose the copy
   and layout for each." On request, `composePage` can have the model author
   `app/page.tsx`; otherwise a deterministic composition is used. Measured
   text is authoritative; the model only fills in what measurement did not
   capture (a hero heading with no text node, say).

Both go through `src/lib/ai/`:

- `models.ts` discovers the catalogue from the provider **at startup and on a
  TTL**, prefers the configured primary, and falls back to another currently
  available free model on transient errors. Which model served each step is
  logged and stored in the project record's `modelTrail`. No model id is
  ever hardcoded.
- When a step attaches screenshots, `completeWithFallback` restricts the
  rotation to models that report image support (`resolveVisionPlan`), so a
  text-only endpoint never receives image content. If the current pool has no
  vision-capable model at all, the images are dropped for that step and the
  run continues on text; if every apparently image-capable model is rejected
  by the provider in practice ("No endpoints found that support image
  input"), the step retries once without its images. Vision is best-effort —
  a rotating free tier must never hard-fail the pipeline.
- `structured` wraps the completion with output schema parsing and bounded
  retries for malformed output.

### Spec (the contract)

`WebsiteSpec` (`src/lib/spec/schema.ts`) is the single typed artifact every
stage reads and writes. Section kinds are a fixed enum
(`SECTION_KINDS`), nav/footer variants are enums, and `coerceKind` is a total
function: layout words are stripped, then the longest table key is matched at
the edges (never mid-string), so "features grid" reliably becomes
`features`. The modifier's patch protocol (`src/lib/modifier/schema.ts`) is
its own discriminated union with per-op documentation in the schema file.

### Generate (deterministic)

`generator/sections.ts` and `generator/chrome.ts` are `String.raw` templates
that emit the generated project's `components/`. The generated files are
Self-contained: they import only `../lib/*` and `next`/`react`, never the
tool that produced them. `theme.ts` emits `globals.css` (tailwind v4 + the
measured custom properties with the font import correctly ordered before
`@import "tailwindcss"`). Assets are downloaded by `crawler/assets.ts` and
referenced by local path with `onError` fallbacks.

Determinism is tested: identical spec → byte-identical files.

### Validate & repair (bounded)

`validator/build.ts` runs the generated project's `next build`. The nested
compiler is spawned with a **sanitised environment** (`childEnv` in
`src/lib/child-env.ts`): a build must never inherit the hosting process's own
Next-internal state (`NEXT_RUNTIME`, `NEXT_PRIVATE_*`, `NODE_CHANNEL_*`,
`NODE_ENV=development`). When the panel — a `next dev` process — spawned the
build with its raw environment, the nested build misrouted and died during
prerendering of the pages-router `/404` with `<Html> should not be imported
outside of pages/_document.` on files that build cleanly from a shell. The
same sanitisation applies to the `next start` used for previews.

On failure it extracts *diagnostics only* (not source) and calls the model
for a targeted repair, applied as a patch. The budget is config-driven and
bounded (`AI_MAX_STRUCTURE_ATTEMPTS`, default 3 combined build+repair rounds).
If the budget runs out the project is left `failed` with the last error; there
is no loop in which the pipeline can spin.

### Preview

`preview/server.ts` starts each site as its own `next start` on a port from
`PREVIEW_PORT_START..END` (default 4320–4339), tracks handles, and can stop or
invalidate them. The preview is the *built artifact*, not a render inside the
panel. The panel embeds it in a viewport-sized frame (~70dvh at most) so a
tall page is not cut off at its first ~20%: the frame fills the available
height and scrolls, and an "open ↗" link opens the full site in a real browser
tab.

## Control panel

`src/app/` is a thin Next.js app over the pipeline:

- `POST /api/projects {url}` validates the URL (400 on bad input), creates a
  project id, detaches `runPipeline`, returns 202.
- `GET /api/projects/[id]/events` streams SSE progress. The emitter
  (`src/lib/store/pipeline.ts`) keeps full per-project history so a
  reconnecting client replays the run from the start. If there is no live
  emitter and no persisted record, the stream closes with a terminal
  `notfound` frame rather than hanging; if a persisted record exists but the
  process that ran it is gone, it closes with `failed` (interrupted).
- `GET/POST/DELETE /api/projects/[id]/preview` manages the preview server
  lifecycle. POST 404s for unknown ids; GET is a status probe.
- `POST /api/projects/[id]/modify {request}` runs the natural-language
  modifier against the spec, rebuilds, and reattaches the preview.
- `GET /api/models` answers with the live-discovered catalogue, health
  included, so the choice of model is visible rather than implicit.

`page.tsx`/`panel-ui.tsx` are deliberately small — the panel is a control
surface, not the product.

## Data flow and trust boundaries

The system has exactly three places where untrusted data becomes trusted:

1. **URL → project id.** `normaliseInput` parses and validates the URL,
   `safeProjectId` restricts the id charset (`[A-Za-z0-9._-]`, no `..`),
   `safeFileSegment` does the same for asset filenames. Directory traversal
   and shell metacharacters cannot cross this boundary.
2. **Page/model → spec.** Every href read off the page or written by the
   model passes `safeHref` (`src/lib/security.ts`), a scheme allowlist
   (`http`, `https`, `mailto`, `tel`, `sms` plus `/`, `#`/`?`-relative).
   `setLinks` *and* `setLink` in the modifier both apply it — they used to
   disagree, and the narrower operation was the way through. Colours, fonts,
   radii, shadows and styles pass `safeColor`/`safeValue` before being
   embedded in CSS/JSX, so a token cannot close a custom-property declaration
   or a template literal.
3. **Spec → generated code.** The generated site treats the spec as data
   (an object literal in `lib/site-spec.ts`, recovered by `renderSpecModule`)
   and renders no `dangerouslySetInnerHTML`, no iframes, no remote scripts,
   no event handlers. A hostile heading round-trips as a string.

These three boundaries are what `tests/security.test.ts`, `tests/patch.test.ts`
and `tests/generator.test.ts` pin.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | control panel on `:4310` |
| `npm run build` | production build of the panel |
| `npm run cli -- generate <url>` | run the pipeline from a terminal |
| `npm run cli -- modify <id> "<request>"` | natural-language edit |
| `npm run cli -- preview <id>` / `list` / `show` / `rm` | project lifecycle |
| `npm run cli -- models` | live model catalogue |
| `npm run doctor` | environment + provider check |
| `npm run build:extract` | regenerate `extract-page.js` from source |
| `npm run test` | offline unit suite |
| `npm run test:e2e` | panel API against a running dev server |
| `npm run bench` | HN / MDN / NASA end-to-end |

## Provenance

Generated projects live in `generated/<slug>-<timestamp>-<hash>/` with their
own `package.json`, so `npm install && npm run build && npm run preview:<id>`
inside one reproduces the artifact independently of this repository. The
spec, the model trail, the measured tokens and the build result are all
recorded per project (`lib/site-spec.ts`, `spec.json`, `record.json`).

## Known limits (honest)

- Extraction is bounded: dense pages (very long link lists) are sampled into
  the top counts — the digest can under-report `listItems`/`links` versus the
  live DOM.
- Section recognition is a single pass; mixed-purpose bands can classify to
  `unknown` (rendered as a generic block rather than discarded).
- The page-composition step defaults to the deterministic projection; the
  model-authored `page.tsx` path is opt-in per run.
- The preview port range is fine for local use; a multi-machine deployment
  would need to externalise it.