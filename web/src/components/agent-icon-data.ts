// Per-agent brand marks for AgentIcon. Most are a 24×24 single-path glyph of the agent's official
// logo paired with the brand's tile color. Sources (all verified against each project's own
// favicon/site): Claude + Codex(OpenAI) via Simple Icons (CC0); pi via Simple Icons / pi.dev
// favicon (#09090b tile); opencode via opencode.ai's site mark (#080808 tile, theme_color); omp via
// omp.sh/favicon.svg (#0f0a14 tile, and the one path mark whose official paint is a gradient —
// `grad`). To refresh: re-run the fetch in CHANGELOG and replace the `d` strings.
//
// ANTIGRAVITY IS THE ARTWORK ITSELF, not a path, and that is a fork change. Upstream carried a
// hand-drawn triangle "A" in white on Google blue with no source cited beside it — every other
// entry names one — and it is not the mark: the real one is a rounded ARCH with a four-colour
// gradient on a transparent ground. There is no official SVG to take a path from (antigravity.google
// is a JS shell serving a raster favicon), so the choice was to trace it by hand — which is how the
// wrong mark got there in the first place — or to embed Google's own artwork. This embeds it:
// `apple-touch-icon.png` from antigravity.google, cropped to its ink, squared, resized to 80px and
// re-encoded as WebP (3.0 kB; the base64 is ~4.1 kB). Rendered through SVG `<image>` inside the same
// tile every path mark uses, so the padding, the role and the label are unchanged, and `img-src
// 'self' data:` already allows it (bridge/server.ts's CSP).
//
// Orca solves this differently and it is worth knowing why Collie does not copy it: its agent
// catalogue carries `faviconDomain: "antigravity.google"` and fetches the favicon at runtime. That
// needs a third-party image host in the CSP, tells that host which agents you run, and shows nothing
// offline — three prices this app does not pay for an icon.

/** What every brand has, whatever it draws inside it. */
interface BrandTile {
  /** Tile background — the agent's official brand color. */
  bg: string;
}

/**
 * A brand whose mark is Google's/the project's own ARTWORK rather than a path we could take from a
 * vector source. One field, and it is a `data:` URI so the mark ships with the bundle and works
 * offline — see the header for why this is not a favicon fetch.
 */
interface ImageBrand extends BrandTile {
  kind: "image";
  src: string;
}

export interface PathBrand extends BrandTile {
  /** Absent means "path", so every entry that predates images is untouched. */
  kind?: "path";
  /** Mark color, chosen for contrast on `bg`. Ignored when `grad` is set — it is then the colour a
   *  future flattening would take, which for omp is the gradient's mid stop. */
  fg: string;
  /** Stops of the mark's own gradient, top-left → bottom-right, evenly spaced, for a brand whose
   *  official mark IS a gradient (omp). Not a contrast device: flat `#9B4DFF` on omp's tile measures
   *  4.56:1 and would read fine. It is fidelity — flattening ships a mark omp itself never paints.
   *
   *  Two stops minimum, by type: one stop (or none) is a gradient that paints nothing, and a mark
   *  referencing it goes invisible on every surface at once. Absent is how a brand says "flat". */
  grad?: readonly [string, string, ...string[]];
  /** "fill" for solid silhouettes, "stroke" for outlined marks (opencode). */
  mode: "fill" | "stroke";
  /** 24×24 path data. */
  d: string;
}

export type AgentBrand = ImageBrand | PathBrand;

/** antigravity.google's own apple-touch-icon, cropped to its ink and re-encoded — see the header. */
const ANTIGRAVITY_MARK =
  "data:image/webp;base64,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";

// A Map, not an object literal: the key is Herdr's agent string, so an object lookup would answer
// for inherited names ("constructor", "toString") with something that is not a brand at all.
export const AGENT_BRANDS = new Map<string, AgentBrand>([
  ["claude", { bg: "#D97757", fg: "#FFFFFF", mode: "fill", d: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" }],
  ["codex", { bg: "#000000", fg: "#FFFFFF", mode: "fill", d: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" }],
  ["pi", { bg: "#09090B", fg: "#FFFFFF", mode: "fill", d: "M0 0v24h6v-6h6v-6H6V6h6v6h6V0Zm18 12v12h6V12Z" }],
  ["opencode", { bg: "#080808", fg: "#FFFFFF", mode: "stroke", d: "M8.75 8.75V2.75H21.25V15.25H15.25M15.25 8.75H2.75V21.25H15.25V8.75Z" }],
  // The mark is transparent artwork meant to sit on white, which is what the tile gives it.
  ["agy", { kind: "image", bg: "#FFFFFF", src: ANTIGRAVITY_MARK }],
  ["antigravity", { kind: "image", bg: "#FFFFFF", src: ANTIGRAVITY_MARK }],
  // omp (oh-my-pi): the π from omp.sh/favicon.svg, its 64×64 mark rescaled ×0.6 and centred to fill
  // 24×24 (the tile adds its own padding) — the same path, not a redrawing. Gradient stops are that
  // favicon's, and match the TUI's own welcome mark.
  [
    "omp",
    {
      bg: "#0F0A14",
      fg: "#9B4DFF",
      mode: "fill",
      grad: ["#ED4ABF", "#9B4DFF", "#5AD8E6"],
      d: "M1.2 0h21.6v4.8h-6v19.2h-4.8V4.8H8.4v13.2H3.6V4.8H1.2z",
    },
  ],
]);
