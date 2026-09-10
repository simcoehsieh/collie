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
