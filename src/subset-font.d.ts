// Local type declarations for `subset-font` (v2.x).
// The package ships untyped; these mirror the public API documented at
// https://github.com/papandreou/subset-font#api as of subset-font@2.5.0.

declare module 'subset-font' {
  export interface VariationAxisRange {
    min?: number
    max?: number
    default?: number
  }

  export interface SubsetFontOptions {
    /** Output format. Default: same as input format detected by fontverter. */
    targetFormat?: 'sfnt' | 'truetype' | 'woff' | 'woff2'
    /** Extra `name` table entries to retain (HarfBuzz drops most by default). */
    preserveNameIds?: number[]
    /** Pin or restrict variation axes for variable fonts. */
    variationAxes?: Record<string, number | VariationAxisRange>
    /** Equivalent of `hb-subset --no-layout-closure`. */
    noLayoutClosure?: boolean
  }

  /**
   * Subset a font to only the characters in `text`, optionally converting
   * to a different format (e.g. ttf → woff2).
   *
   * @param originalFont source font as a Buffer (.ttf/.otf/.woff/.woff2)
   * @param text         characters to retain in the subset
   * @param options      see SubsetFontOptions
   * @returns subset font as a Buffer
   */
  export default function subsetFont(
    originalFont: Buffer | Uint8Array,
    text: string,
    options?: SubsetFontOptions,
  ): Promise<Buffer>
}
