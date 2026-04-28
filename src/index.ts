// vite-plugin-splice
// ─────────────────────────────────────────────────────────────────────────
// Trim web fonts to only the glyphs your site actually renders. Wraps
// HarfBuzz (via `subset-font` / `harfbuzzjs`) in a Vite plugin so subsetting
// runs as part of `vite build` instead of being a manual CLI step.
//
// What it does, per build:
//   1. For each FontTarget in `options.fonts`, read the source font from disk
//   2. Build the character set (text + unicode ranges, unioned)
//   3. Call subset-font (HarfBuzz WASM) to produce a subset woff2 buffer
//   4. Emit the buffer as a Vite asset → ends up in dist/ with a hashed name
//   5. Optionally inject @font-face + <link rel="preload"> into every HTML output
//
// Dev mode: a Vite middleware intercepts requests for the same subset URLs
// that the production build would emit (e.g. /_astro/{family}-{weight}-splice.woff2)
// and produces the subset on the fly, cached in memory for the dev session.
// This means @font-face declarations referencing the subset URL work
// identically in `vite dev` and `vite build` — no 404s, no separate dev
// configuration, fonts render correctly in both modes.

import { promises as fs } from 'node:fs'
import { resolve } from 'node:path'
import subsetFont from 'subset-font'
import type { Plugin, ResolvedConfig } from 'vite'

// ── Types ────────────────────────────────────────────────────────────────

export interface FontTarget {
  /** CSS font-family name. Used in the generated @font-face declaration. */
  family: string

  /** font-weight (100..900). Default: 400. */
  weight?: number

  /** font-style. Default: 'normal'. */
  style?: 'normal' | 'italic'

  /** Path to source font file. Resolved relative to Vite's `root`.
   *  Supports any format subset-font accepts (.ttf, .otf, .woff, .woff2). */
  src: string

  /** Explicit characters to include in the subset.
   *  Unioned with `unicodes` if both are provided. */
  text?: string

  /** Explicit unicode-range strings, e.g. ['U+0020-007E', 'U+00A0-00FF']. */
  unicodes?: string[]

  /** Output filename (relative to Vite's asset dir). Default:
   *  `${family}-${weight}-splice.woff2` (lowercased, spaces → hyphens). */
  outputName?: string
}

export interface SpliceOptions {
  /** One entry per (family, weight, style) you want to subset. */
  fonts: FontTarget[]

  /** Inject <link rel="preload" as="font" type="font/woff2" crossorigin>
   *  for each subset asset into every HTML output. Default: true. */
  preload?: boolean

  /** Emit a @font-face block in <head> for each subset font. Default: true.
   *  Disable if you write your own @font-face declarations and just want
   *  the subset assets emitted to disk. */
  injectFontFace?: boolean
}

// ── Internal state ───────────────────────────────────────────────────────

interface ProcessedFont {
  target: FontTarget
  /** Buffer returned by subset-font, ready to emit as an asset. */
  buffer: Buffer
  /** Filename inside the bundle (e.g. `assets/fonts/AmpleSoftPro-600-subset.woff2`).
   *  Set by generateBundle() once Vite assigns a final path. */
  emittedFileName?: string
}

// ── Plugin factory ───────────────────────────────────────────────────────

export default function splice(options: SpliceOptions): Plugin {
  const {
    fonts,
    preload = true,
    injectFontFace = true,
  } = options

  let config: ResolvedConfig
  let processed: ProcessedFont[] = []

  // Dev-mode in-memory cache: URL pathname → subset Buffer. Populated on
  // first request for that URL during the dev session, served instantly
  // from memory thereafter. Cleared on dev-server restart.
  const devCache = new Map<string, Buffer>()

  return {
    name: 'vite-plugin-splice',

    configResolved(c) {
      config = c
    },

    /** Dev-only: intercept requests for splice subset URLs (the same paths
     *  the production build emits) and produce the subset on the fly.
     *  Without this, @font-face declarations pointing at /_astro/*-splice.woff2
     *  would 404 in `vite dev`. With it, dev and prod behave identically
     *  from the consumer's perspective. */
    configureServer(server) {
      const urlMap = new Map<string, FontTarget>()
      for (const target of fonts) {
        // Match what generateBundle emits: assetsDir + defaultOutputName.
        // Vite's dev server doesn't have config.build.assetsDir applied to
        // requests (assets are at /@fs/ during dev), so accept either the
        // hard-coded prod path (/_astro/*) or any path ending in the
        // subset filename for flexibility.
        const filename = defaultOutputName(target)
        urlMap.set(`/_astro/${filename}`, target)
        urlMap.set(`/${filename}`, target)
      }

      server.middlewares.use(async (req, res, next) => {
        const url = (req.url || '').split('?')[0]
        const target = urlMap.get(url)
        if (!target) return next()

        // Memo cached subset to avoid re-subsetting on every page reload.
        let buffer = devCache.get(url)
        if (!buffer) {
          try {
            const srcPath = resolve(config.root, target.src)
            const sourceBuffer = await fs.readFile(srcPath)
            const text = buildSubsetText(target)
            if (text.length === 0) return next()
            buffer = await subsetFont(sourceBuffer, text, { targetFormat: 'woff2' })
            devCache.set(url, buffer)
            // eslint-disable-next-line no-console
            console.log(
              `[vite-plugin-splice] dev-subset ${target.family} (${target.weight ?? 400}): ` +
              `${formatBytes(sourceBuffer.length)} → ${formatBytes(buffer.length)} ` +
              `(cached for session)`
            )
          } catch (err) {
            return next(err as Error)
          }
        }

        res.setHeader('Content-Type', 'font/woff2')
        res.setHeader('Content-Length', String(buffer.length))
        // No long cache in dev — restart server, font may have changed.
        res.setHeader('Cache-Control', 'no-cache')
        res.end(buffer)
      })
    },

    /** Read + subset every font once per build. Runs before generateBundle
     *  so emit calls have buffers ready. */
    async buildStart() {
      processed = []
      for (const target of fonts) {
        const srcPath = resolve(config.root, target.src)
        let sourceBuffer: Buffer
        try {
          sourceBuffer = await fs.readFile(srcPath)
        } catch (err) {
          this.error(
            `[vite-plugin-splice] could not read font at "${srcPath}" ` +
            `(target family "${target.family}"): ${(err as Error).message}`
          )
        }

        const text = buildSubsetText(target)
        if (text.length === 0) {
          this.error(
            `[vite-plugin-splice] target family "${target.family}" has no ` +
            `characters to include — set "text" and/or "unicodes"`
          )
        }

        let subsetBuffer: Buffer
        try {
          subsetBuffer = await subsetFont(sourceBuffer, text, {
            targetFormat: 'woff2',
          })
        } catch (err) {
          this.error(
            `[vite-plugin-splice] subset failed for "${target.family}": ` +
            `${(err as Error).message}`
          )
        }

        const inSize = sourceBuffer.length
        const outSize = subsetBuffer.length
        const pct = Math.round((1 - outSize / inSize) * 100)
        this.info(
          `[vite-plugin-splice] ${target.family} (${target.weight ?? 400}): ` +
          `${formatBytes(inSize)} → ${formatBytes(outSize)} (-${pct}%, ` +
          `${[...new Set(text)].length} unique glyphs)`
        )

        processed.push({ target, buffer: subsetBuffer })
      }
    },

    /** Emit each subset buffer into the bundle as a Vite asset. emitFile
     *  with a `fileName` (not `name`) gives a deterministic path so we can
     *  reference it directly in the injected HTML — Vite still inlines a
     *  content hash if asset hashing is enabled at the config level. */
    generateBundle() {
      for (const p of processed) {
        const fileName = `${config.build.assetsDir}/${defaultOutputName(p.target)}`
        this.emitFile({
          type: 'asset',
          fileName,
          source: p.buffer,
        })
        p.emittedFileName = fileName
      }
    },

    /** Inject @font-face + preload links into every HTML output that this
     *  Vite build produces. Runs after assets are emitted, so the URLs we
     *  inject are valid by the time the HTML is written to disk. */
    transformIndexHtml: {
      order: 'post' as const,
      handler() {
        if (processed.length === 0) return undefined
        const tags: any[] = []

        if (injectFontFace) {
          tags.push({
            tag: 'style',
            attrs: { 'data-vite-plugin-splice': '' },
            children: processed.map(fontFaceCSS).join('\n'),
            injectTo: 'head' as const,
          })
        }

        if (preload) {
          for (const p of processed) {
            if (!p.emittedFileName) continue
            tags.push({
              tag: 'link',
              attrs: {
                rel: 'preload',
                as: 'font',
                type: 'font/woff2',
                href: '/' + p.emittedFileName,
                crossorigin: 'anonymous',
              },
              injectTo: 'head' as const,
            })
          }
        }

        return { html: '', tags }
      },
    },
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function buildSubsetText(target: FontTarget): string {
  const parts: string[] = []
  if (target.text) parts.push(target.text)
  if (target.unicodes) {
    for (const range of target.unicodes) parts.push(unicodeRangeToChars(range))
  }
  // Dedupe characters — passing duplicates to subset-font is wasted work.
  return [...new Set(parts.join(''))].join('')
}

/** Parse "U+0020-007E" or "U+00A0" into a string of those characters.
 *  Tolerant of mixed case ('U+0020' and 'u+0020' both work). */
function unicodeRangeToChars(range: string): string {
  const m = range.match(/^U\+([0-9A-Fa-f]+)(?:-([0-9A-Fa-f]+))?$/)
  if (!m) return ''
  const start = parseInt(m[1], 16)
  const end = m[2] ? parseInt(m[2], 16) : start
  let result = ''
  for (let cp = start; cp <= end; cp++) {
    try { result += String.fromCodePoint(cp) } catch { /* skip invalid */ }
  }
  return result
}

function defaultOutputName(target: FontTarget): string {
  if (target.outputName) return target.outputName
  const fam = target.family.toLowerCase().replace(/\s+/g, '-')
  const w = target.weight ?? 400
  return `${fam}-${w}-splice.woff2`
}

function fontFaceCSS(p: ProcessedFont): string {
  const { target, emittedFileName } = p
  return `@font-face {
  font-family: '${target.family}';
  src: url('/${emittedFileName}') format('woff2');
  font-weight: ${target.weight ?? 400};
  font-style: ${target.style ?? 'normal'};
  font-display: swap;
}`
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
