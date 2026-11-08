// FORK: what this build was told about the machine it serves, from `~/.config/collie/branding/`
// (web/branding.ts, read at build time and baked in through vite's `define` as `__BRAND__`).
//
// A module rather than a bare global so a test can `vi.mock("@/lib/brand")` for the branded case:
// `define` replaces the identifier at compile time, which is exactly what makes it impossible to
// stub afterwards. Components read `BRAND`, never `__BRAND__`.

export interface BrandInfo {
  /** The label under the home screen icon and the header's brand line; null = stock "Collie". */
  readonly shortName: string | null;
  /** Leave the multiplexer's own logo off the header's "on <mux>" line. */
  readonly hideMux: boolean;
}

export const BRAND: BrandInfo = __BRAND__;

/** The word the header prints over "on <mux>". A name, not a translation. */
export const BRAND_WORD = BRAND.shortName ?? "Collie";

/** The product's name as a word in prose — "Collie", "Collie's", "two Collies" — never `collie`
 *  (a command), `COLLIE_` (an env var) or `X-Collie-` (a header): those are what the operator types. */
const PRODUCT_WORD = /(?<![-\w])Collie(?=s?\b)/g;

/**
 * FORK: the product's name in user-facing text, as this install calls it. A branded build says
 * "Meow" wherever upstream's copy says "Collie"; the stock build returns the text unchanged.
 * Commands, paths, env vars and headers keep `collie`, because those are what gets typed.
 */
export function rebrand(text: string, word: string | null = BRAND.shortName): string {
  return word === null ? text : text.replace(PRODUCT_WORD, word);
}
