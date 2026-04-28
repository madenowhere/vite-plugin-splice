# vite-plugin-splice

Trim web fonts to only the glyphs your site actually renders. **Vite-integrated, no Python toolchain, no headless browser, watch-aware.**

```
~30 KB plugin  ·  HarfBuzz WASM engine (via subset-font)  ·  scans your real build output
```

---

## Why this exists

[`glyphhanger`](https://github.com/zachleat/glyphhanger) is the de-facto incumbent for web font subsetting. It's also a tool from a different era. After actually reading its source (1,328 LOC across `src/`), the problems are concrete.

### glyphhanger's actual state

| | |
| --- | --- |
| **Last published** | June 2022 (3+ years dormant) |
| **Unpacked tarball** | 716 KB, 51 files |
| **Direct npm deps** | 13 packages |
| **Hidden runtime requirements** | `puppeteer` (downloads Chrome, ~280 MB) NOT in `dependencies` — implicit peer |
| **External toolchain required** | Python + `pyftsubset` from `fonttools` + `brotli` Python module + `py-zopfli` for woff variants |
| **Form factor** | CLI tool, manual run, no build integration |
| **Source of truth** | crawl URLs with puppeteer/jsdom — re-renders your site to find characters that you already shipped |
| **Subsetting engine** | shells out to `pyftsubset` (Python) — two languages, two error surfaces |
| **Watch / HMR** | none — manual re-run when text changes |
| **Cache** | none |
| **Weekly downloads (Apr 2026)** | ~900 |

The two-language design is the heart of it: a Node CLI that orchestrates Python that calls C++ that emits font binaries. Bootstrapping CI requires a Python install + `pip install fonttools brotli zopfli` + Chrome download. For a tool whose job is "make the woff2 smaller," that's a lot of moving parts.

### The mental shift

During a Vite build, we already have:
- Every source file
- The full transformed bundle
- The rendered HTML output (after SSR / SSG)
- An asset pipeline that knows how to emit files into `dist/`

We don't need to spider URLs. We don't need a Chrome instance. We don't need a separate manual step. The data is in scope; the asset emission is built in. A plugin is the right shape.

---

## What `vite-plugin-splice` does differently

```
Vite build
   │
   ├── 1. Scan output HTML / explicit config
   │      → derive glyph set per font
   │
   ├── 2. Read source font (.ttf / .otf / .woff2)
   │
   ├── 3. Subset via HarfBuzz (WASM)
   │      using subset-font (which wraps harfbuzzjs)
   │
   ├── 4. Emit subset.woff2 to dist/
   │
   └── 5. Inject @font-face + <link rel="preload"> if requested
```

Single build pass, deterministic, cache-aware. No external Python toolchain. Watch mode invalidates the cache when source font OR detected glyphs change.

---

## Engine choice — read the room, ship working

Web font subsetting is a deceptively hard problem. The output font has to keep its `cmap` table (so browsers can map Unicode codepoints to glyphs), correctly walk OpenType GSUB/GPOS dependencies, prune unreferenced lookups, re-encode CFF glyph data when present, and re-compress to woff2 — all while staying byte-compatible with the OpenType spec across edge cases that took the HarfBuzz subset team years to surface.

The mature solution is HarfBuzz's `hb-subset`. It's what Google Fonts uses server-side (in native form). For browser/Node use, [`harfbuzzjs`](https://github.com/harfbuzz/harfbuzzjs) is the official WASM port. [`subset-font`](https://github.com/papandreou/subset-font) (Andreas Lind / Munter) wraps `harfbuzzjs` in an ergonomic JS API.

We use `subset-font` as a peer dependency. **We are not building a new subsetter.** Our value-add is the Vite plugin packaging — build integration, source-of-truth derivation from build output, watch awareness, cache, automatic `@font-face` and preload injection. The bytes-saving math comes from HarfBuzz; the workflow comes from us.

Honest survey of what we *didn't* pick:

- **typst's `subsetter` crate** — pure Rust, attractive on paper, **but PDF-only**. Strips the cmap table, producing a CID font. Unusable for web fonts loaded via `@font-face` because the browser can't map Unicode codepoints to glyphs without cmap.
- **Google's hypothetical Rust subsetter** — Google's `fontations` repo has `read-fonts` and `write-fonts` (low-level table I/O) but no high-level subsetter. They still rely on native HarfBuzz internally. The pure-Rust web-font subsetting space is genuinely 1-2 years away from production maturity.
- **`fontcull` (Rust by bearcove)** — promising, has a `--whitelist` mode, BUT the woff2 encoding piece pulls in C++. Possibly buildable for WASM with effort, possibly not. Either way, exploratory work; not a foundation to bet a v1.0 release on.
- **Pure-JS subsetters** — invariably incomplete (missing CFF, broken OpenType lookups). Not a serious option.

So: HarfBuzz via `subset-font`. The WASM blob is ~3 MB, but it runs **once per Vite build** and never ships to clients. Build-time bytes are cheap; runtime bytes are expensive.

---

## Architecture

Single repo, single npm package:

```
madenowhere/vite-plugin-splice
  ├─ src/index.ts          plugin factory + Vite hooks
  ├─ src/scan-html.ts      output-HTML glyph extraction (v0.2)
  └─ package.json          peerDeps: vite, subset-font
```

Pure TypeScript. No Rust toolchain, no Python, no committed binaries. Users install us + `subset-font`, the plugin orchestrates.

---

## Comparison

|                                | glyphhanger          | **vite-plugin-splice**                     |
| ------------------------------ | -------------------- | ------------------------------------------ |
| Form factor                    | CLI tool             | **Vite plugin**                            |
| Last published                 | 2022-06              | **maintained**                             |
| Tarball unpacked               | 716 KB               | **~30 KB** (engine via peer dep)           |
| Build integration              | manual               | **automatic** (Vite hook)                  |
| Watch / HMR support            | no                   | **yes** (font + source changes)            |
| Cache                          | no                   | **yes** (per-font hash)                    |
| External Python required       | yes                  | **no**                                     |
| Headless browser required      | yes (puppeteer/jsdom) | **no**                                    |
| Subset engine                  | `pyftsubset` (Python) | **HarfBuzz WASM** (via `subset-font`)     |
| Source of truth                | crawl URLs           | **scan build output** + explicit config    |
| `@font-face` injection         | optional CLI flag    | **automatic, opt-in**                      |
| Preload injection              | no                   | **automatic, opt-in**                      |
| Output formats                 | ttf/woff/woff-zopfli/woff2 | **woff2 only** (modern web only)     |
| Weekly downloads (Apr 2026)    | ~900                 | _(launching)_                              |

---

## Bundle impact

The plugin itself is tiny; `subset-font` carries the WASM weight.

| Component | Size |
| --- | --- |
| `vite-plugin-splice` JS source | ~30 KB unminified, ~10 KB gzip |
| `subset-font` peer dep (transitive: `harfbuzzjs`) | ~3 MB unpacked, loads once per build |
| **End-user app bundle impact** | **0 bytes** (build-time only) |

The WASM never ships to the browser. It runs once per `vite build` to produce the subset font files in `dist/`. End users see only the subset woff2 outputs.

**Real-world saving on a small site:** subsetting AmpleSoftPro semibold from full charset (~21 KB woff2) to a 13-character logo wordmark produces a ~3 KB woff2. **86% reduction**, automatic per build, no manual character list to maintain.

---

## Install

```bash
pnpm add -D vite-plugin-splice subset-font
# subset-font is a peer — declared explicitly so projects can pin / dedupe
```

Astro projects:

```bash
pnpm add -D vite-plugin-splice subset-font
```

(Astro uses Vite under the hood; the same plugin works in `astro.config.mjs` via `vite.plugins`.)

---

## Quick start

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import splice from 'vite-plugin-splice'

export default defineConfig({
  plugins: [
    splice({
      fonts: [
        // Explicit text — simplest, most predictable. Ships at v0.1.
        {
          family: 'AmpleSoftPro',
          weight: 600,
          src: './src/assets/fonts/AmpleSoftPro-Semibold.woff2',
          text: '@NEURALKIT_AI',
        },
      ],
      preload: true,         // <link rel="preload"> for subset assets
      injectFontFace: true,  // emit @font-face into HTML <head>
    }),
  ],
})
```

Astro:

```js
// astro.config.mjs
import splice from 'vite-plugin-splice'

export default defineConfig({
  vite: {
    plugins: [splice({ /* same config */ })],
  },
})
```

---

## API

### `splice(options)`

Returns a Vite plugin.

#### `options.fonts: FontTarget[]`

One entry per (family, weight, style) combination you want to subset.

```ts
interface FontTarget {
  /** CSS font-family name. Used in generated @font-face declarations. */
  family: string

  /** font-weight (100..900). Default: 400. */
  weight?: number

  /** font-style. Default: 'normal'. */
  style?: 'normal' | 'italic'

  /** Path to source font file. Resolved relative to Vite root.
   *  Supports .ttf, .otf, .woff, .woff2 (subset-font handles all of these). */
  src: string

  /** Explicit characters to include. Unioned with `unicodes` if both set. */
  text?: string

  /** Explicit unicode-range strings, e.g. ['U+0020-007E', 'U+00A0-00FF']. */
  unicodes?: string[]

  /** Output filename pattern (default: `${family}-${weight}-subset.woff2`). */
  outputName?: string
}
```

> **Coming in v0.2:** `scanClass?: string` — point at a CSS class (e.g. `'font-amplesoftpro'`), plugin walks output HTML, finds elements with that class, extracts their `textContent` for subsetting. Lets you stop maintaining the character list manually.

#### `options.preload?: boolean` (default `true`)

Inject `<link rel="preload" as="font" type="font/woff2" crossorigin>` for each subset asset into every HTML output.

#### `options.injectFontFace?: boolean` (default `true`)

Emit a `@font-face` block in `<head>` for each subset font. Skip if you write your own `@font-face` declarations and just want the subset assets emitted.

#### `options.outDir?: string` (default Vite's asset dir)

Where to emit the subset font files within `dist/`.

#### `options.cache?: boolean` (default `true`)

Skip subsetting if the source font + glyph set hash hasn't changed since the last build. Cache lives in `node_modules/.vite/splice/`.

---

## Migration from glyphhanger

Most glyphhanger workflows map directly:

| glyphhanger CLI | **vite-plugin-splice** equivalent |
| --- | --- |
| `glyphhanger ./test.html --subset=*.ttf` | `splice({ fonts: [{ src, scanClass }] })` _(v0.2)_ |
| `glyphhanger --whitelist=ABCD --subset=*.ttf` | `splice({ fonts: [{ src, text: 'ABCD' }] })` |
| `glyphhanger --US_ASCII --subset=*.ttf` | `splice({ fonts: [{ src, unicodes: ['U+0020-007E'] }] })` |
| `glyphhanger --formats=woff2` | (default — woff2 only) |
| `glyphhanger --css` | `injectFontFace: true` (default) |
| `glyphhanger --family='Lato,sans-serif'` | `splice({ fonts: [{ family: 'Lato', scanClass: '...' }] })` _(v0.2)_ |
| `glyphhanger ./test.html --spider --subset=*.ttf` | (not needed — Vite already builds every page) |

You can delete:
- `pyftsubset` install
- `brotli` Python module install
- `py-zopfli` install
- The `glyphhanger ./public ...` script in your `package.json`
- Any committed `*-subset.woff2` files (now generated per-build)

---

## What's intentionally not included

- **TTF / WOFF / WOFF-zopfli output.** Modern browsers (since ~2020) all support woff2. Producing legacy formats triples build time and ships bytes nobody loads. If you need IE11 support, glyphhanger is still the right tool.
- **URL crawling / spider mode.** You shouldn't need to crawl your own site to find the text it renders. The build output already has every page. Crawl mode exists in glyphhanger because it's a CLI; we're a build plugin.
- **Multi-format output (woff + woff2 + ttf).** Same as above — woff2 only.
- **CLI mode.** This is a Vite plugin, not a CLI. If you need a CLI, `subset-font` exposes the engine directly, or use glyphhanger.
- **Custom subset engine.** We use HarfBuzz via `subset-font`. Building a competing subsetter would take years of edge-case work that the HarfBuzz team has already done. The value-add here is packaging, not engine.

---

## Design decisions

### Why a Vite plugin instead of a CLI

The "what glyphs does my site use" question has its answer in your build output. A CLI runs *after* the build and re-derives that data manually (crawl URLs, walk DOM). A plugin runs *during* the build with the data already in scope. Cleaner, faster, idempotent. No "I changed text but forgot to re-subset" footgun.

### Why use HarfBuzz instead of building our own engine

Surveyed the alternatives honestly. The pure-Rust web-font subsetting ecosystem isn't mature yet — typst's `subsetter` is PDF-only (strips cmap), `fontations` has `read-fonts`/`write-fonts` building blocks but no high-level subsetter, `fontcull` is the only real candidate but its woff2 piece pulls in C++ and WASM compatibility is unverified. Pure-JS subsetters are uniformly incomplete (broken CFF, broken OpenType lookups).

HarfBuzz `hb-subset` is what Google Fonts uses server-side, what every serious font tool eventually wraps, and what `subset-font` exposes via WASM. Choosing it gets us correctness and edge-case coverage that took the HarfBuzz team years to accumulate. We're not in the business of competing with that — we're in the business of making it usable from a Vite config in two lines.

The "we use HarfBuzz" answer is unromantic but honest. The unromantic answers tend to age better.

### Why HTML output scanning over source code scanning (v0.2)

Tailwind's `font-X` → `--font-X` CSS variable → `font-family` resolution is non-trivial to replicate at the source-AST level. Output HTML has the rendered DOM with computed styles already; we read it directly. Faster to implement, more accurate, no class-name pattern matching brittleness. The trade-off is needing the build to complete first — but we run as a `closeBundle` hook, which is exactly when that data exists.

### Why no module-level state

Vite plugins are factory functions for a reason. Multiple Vite configs on a single machine (monorepo, multi-project workspaces) share a Node process; module-level state would leak between unrelated builds. Every plugin instance owns its own cache, its own font set.

### Why woff2-only output

Every browser shipped since 2020 supports woff2. Subsetting to ttf/woff additionally triples build time (3 outputs per font) and ships bytes that browsers will ignore. If you're targeting IE11 you have bigger problems than font weight.

### Why a small explicit `text` API at v0.1 (and `scanClass` later)

Two reasons. (1) For tiny fixed-string elements (logo wordmarks like `@NEURALKIT_AI`), explicit is faster and more predictable than scanning. (2) Shipping the explicit-only flow first validates the whole pipeline (Vite hook → subset-font call → asset emission → @font-face injection) end-to-end on real fonts. `scanClass` is a layer on top once that foundation is proven.

---

## Status

**0.x — pre-1.0.** API is intentionally minimal but may evolve based on real-world feedback. Promotion to 1.0 once the core flow has been validated against real production sites.

The roadmap from here:
- **v0.1** — explicit `text` + `unicodes` config, asset emission, `@font-face` + preload injection (raw Vite). Per-font hash cache.
- **v0.2** — Astro integration adapter (`vite-plugin-splice/astro`) that hooks `astro:build:done` to inject `@font-face` and preload tags into Astro-rendered HTML.
- **v0.3** — `scanClass` HTML extraction (the "set it and forget it" mode).
- **v0.4+** — driven by user feedback.

### Astro caveat (v0.1)

Astro generates HTML through its own SSG pipeline, which runs **after** Vite finishes — so Vite's `transformIndexHtml` hook (the standard injection point for plugins) never sees Astro's rendered pages. Until v0.2 ships the Astro adapter, **Astro users get the asset emission half** (the 1–3 KB subset `.woff2` lands in `dist/_astro/` as expected) **but must wire up the `@font-face` and preload manually**, or skip Astro's `<Font preload />` for the subsetted family and add an explicit `@font-face` declaration in your global CSS pointing at the deterministic subset filename:

```css
/* in your global.css */
@font-face {
  font-family: 'AmpleSoftPro';
  src: url('/_astro/amplesoftpro-600-subset.woff2') format('woff2');
  font-weight: 600;
  font-display: swap;
}
```

Plain Vite projects (Vue, React, SvelteKit, raw SPA) get full automatic injection.

---

## Credit

`subset-font` by [Andreas Lind](https://github.com/papandreou). HarfBuzz subset by the HarfBuzz contributors (notably Behdad Esfahbod and the Google Fonts team). This plugin is a thin orchestration layer on top — credit for the actual font math goes upstream.

## License

MIT
