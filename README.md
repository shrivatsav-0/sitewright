# Sitewright

A URL in, a real website out. Point it at a page and it returns a **standalone,
buildable, editable reconstruction** — not a screenshot, not an iframe, not a
proxy. The output is a real Next.js project measured from the source, authored
by a model, validated by a real build, and repairable with natural language.

```
URL ──► extract ──► observe ──► interpret ──► spec ──► generate ──► build ──► preview
                     ▲                                          │ validate │
                     └────────────────── repair ────────────────┘
```

## What it does

1. **Extract & photograph** — a deterministic in-page script (no model
   involved) records the page's geometry, text, colours, fonts, radii, shadows
   and assets into a compact observation payload, and a headless browser saves
   screenshots — one per viewport plus a crop of each measured section. Raw HTML
   is never sent to the model.
2. **Interpret** — a model reads the *observations* and answers two narrowly
   scoped questions: what is each band on the page, and where should the copy
   go. With vision enabled the fold screenshot and the largest section crops
   are attached as reference images, so the photos are used before anything is
   generated. Vision is best-effort: if the current free pool has no model
   that can accept images, the step runs on text rather than failing. Measured
   values always win over model guesses.
3. **Spec** — the merge is validated into a typed `WebsiteSpec` (the contract
   every other stage reads and writes).
4. **Generate** — the spec is rendered into a self-contained Next.js project:
   components, theme CSS, assets, page. Deterministic: the same spec produces
   byte-identical files.
5. **Build** — a real `next build` proves the output compiles.
6. **Repair** — if the build fails, the model gets the *error log only*, the
   diagnosis is bounded (never an infinite loop), and a targeted fix is
   applied. Regeneration happens only when a repair is not possible.
7. **Preview** — the built project runs as its own `next start` on a port from
   a configured range; an honest demonstration of the real artifact. The panel
   embeds it in a scrollable, viewport-sized frame with an "open in new tab"
   link, so a tall page is never stuck showing only its first ~20%.

You can then **modify** a generated site in plain English —
"make the hero taller", "use a two-column layout for the features" — and the
modifier produces a targeted patch against the spec. Patches are validated and
applied deterministically; the project is rebuilt and re-previewed.

An installation exists here:
- `src/lib/` — the pipeline (extractor, analyzer, prompts, spec, generator,
  validator, modifier, preview, store).
- `src/app/` — the control panel (API routes + a small UI).
- `scripts/` — CLI (`cli.ts`), site benchmark (`bench-sites.ts`), extractor
  build (`build-extract.mjs`), environment doctor (`doctor.ts`).
- `tests/` — unit tests plus a live e2e suite for the panel API.
- `generated/` — every project produced on this machine. Each is a
  self-contained Next.js app (`npm install && npm run build && npm start`
  inside one reproduces it independently), and `npm run cli -- preview <id>`
  starts it on a preview port.

## Quick start

```bash
npm install
npm run doctor          # checks node, playwright, model discovery
npm run cli -- generate https://news.ycombinator.com
npm run cli -- list
npm run cli -- preview <project-id>
```

Open the generated site, or the control panel:

```bash
npm run dev             # control panel on http://localhost:4310
```

The panel can start a run from a URL, stream progress over SSE, show the spec,
apply natural-language modifications, and start/stop previews. A run that
fails gets a **↻ Retry** button next to its status, which re-queues the same
URL as a fresh run.

## Model with the model

```bash
npm run cli -- modify <project-id> "make the hero section taller"
npm run cli -- show <project-id>
npm run cli -- models   # what this machine can actually use, right now
```

## Design rules

- **Deterministic where it matters.** Extraction, measurement, spec-to-file
  rendering, patch application and validation are pure functions of their
  input. Only the *interpretation* steps call a model, and the model never
  sees site HTML — it sees compact observations and answers structured
  questions.
- **Free-first, never hardcoded.** The set of free models rotates, so the
  catalogue is discovered at startup and re-queried on a TTL. The configured
  primary is preferred; on a transient error the step falls back to another
  currently-available free model and logs which model was used. Set
  `AI_FREE_ONLY=1` for a hard guarantee that no pay-per-token model is ever
  called (it is enforced before configured-model resolution, so a paid
  `AI_MODEL` is rejected too).
- **Bounded everywhere.** Build repair is limited to a few attempts, malformed
  model output is retried within a hard cap, and every retry budget is
  explicit in the config. There is no unbounded loop in the pipeline.
- **Measured content is authoritative.** Copy, colours, spacing, images come
  from the measurements unless the page simply does not provide them; the
  model only labels and decides semantics.
- **No iframes, no proxies, no screenshots.** The output is a standalone
  reconstruction with locally downloaded assets that degrade gracefully.

## Security model

The pipeline treats pages, model output, generated code and URLs as untrusted.
See `docs/architecture.md` for the full treatment; the executive summary:

- URL parsing and project ids are validated at every boundary
  (`normaliseInput`, `safeProjectId`, `safeFileSegment`).
- Every crawled or model-authored href passes a scheme **allowlist**
  (`safeHref`); unparseable or script-bearing schemes become inert `#`.
- Colours, fonts, shadows and section styles pass declaration-level
  sanitisation before being written into CSS or JSX (`safeColor`,
  `safeValue`), so hostile tokens cannot escape a custom property.
- The generated project never evaluates crawled markup; content is data
  inside a validated spec.
- `FormBlock` and every other component carry **no event handlers** — the
  output is Server Components only, which also prevents script injection
  through interactive handlers.
- These properties are pinned by `tests/` (unit) and stressed by `npx tsx
  scripts/bench-sites.ts` (end to end across three structurally different
  sites: news aggregator, documentation portal, government portal).

## Testing

```bash
npm run build:extract   # regenerate the in-page extractor (pickle check)
npm run test            # unit suite (fast, offline)
npm run test:e2e        # panel API against a running `npm run dev`
npm run bench           # HN / MDN / NASA end-to-end (minutes, needs provider)
```

`tests/` asserts security boundaries, measurement rules, the spec schema, the
patch protocol, generator output determinism and the theme derivation. The
bench is the honest answer to "does it work": three structurally different
sites, each extracted, interpreted, generated, built and (if needed)
repaired.

## Status

MVP. The pipeline produces buildable reconstructions of all three benchmark
sites. Known trade-offs — documented in `docs/architecture.md` — include
bounded extraction depth (links/lists on very dense pages are sampled), a
single model pass per section (no batched refinement), and preview ports
allocated from a local range.