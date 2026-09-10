// FORK: the mark inside the app — a cat peeking over a terminal window, the same drawing as the
// home screen icon in branding/cat/favicon.svg with its paper rect dropped so it sits on any ground.
//
// This file stands IN FOR <CollieMark/> (components/collie-mark.tsx) everywhere the app draws its
// own mark. That file is generated upstream and pinned by a hash test, so it is not edited; this one
// takes the same props and keeps the same three things its hosts and their tests read off the DOM:
//
//   • it is the one `<svg>` with a `<style>` child (src/test/collie-mark.ts finds it that way);
//   • `cm-live` is the class that means "loading", and it is the only thing that starts motion;
//   • `--cm-paper` and `--cm-a1` are custom properties on the element — the knockout colour and
//     the accent — because the bloom is a COLOUR as well as a speed: under `prefers-reduced-motion`
//     nothing moves, and the cursor's accent is what still says "working".
//
// The animation names keep the `cm-` prefix ON PURPOSE. components/collie-home.tsx collects every
// animation under the mark whose name starts with `cm-` and ramps its playback rate during a
// "round" (the raised-cosine spin). Naming them anything else would leave that ramp with nothing to
// drive and the round would be a no-op — not an error, just a feature that quietly stopped.
//
// What moves while loading: the cursor bar blinks (0.6 s, the rate a real terminal cursor blinks
// at) and the eyes glance slowly from side to side. At rest the cursor is solid and the eyes look
// straight ahead — a still drawing, no animation running at all, exactly as the collie mark rests.
//
//   <MeowMark size={132} />                            the mark
//   <MeowMark size={132} loading />                    while something is fetching
//   <MeowMark size={40} weight="header" />             below about 80px
//
// A <style> inside an inline SVG is DOCUMENT-scoped, so the rules are shared by every instance on
// the page and everything per-instance is a custom property on the element. `weight` is accepted
// for the collie mark's contract; the cat has one geometry drawn with strokes that survive 40px
// (the thinnest line is 9/144 of the box, 2.5px at 40), so both weights draw the same thing.

import type { CSSProperties } from "react";

import type { CollieMarkProps } from "@/components/collie-mark";

const STYLE =
  "@keyframes cm-blink{0%,49%{opacity:1}50%,100%{opacity:0}}" +
  "@keyframes cm-glance{0%,15%{transform:translateX(0)}35%,50%{transform:translateX(-4px)}70%,85%{transform:translateX(4px)}100%{transform:translateX(0)}}" +
  ".mm-cursor{fill:var(--cm-a1)}" +
  ".cm-live .mm-cursor{animation:cm-blink .6s step-end infinite}" +
  ".cm-live .mm-eyes{animation:cm-glance 2.4s ease-in-out infinite}" +
  "@media (prefers-reduced-motion:reduce){.cm-live .mm-cursor,.cm-live .mm-eyes{animation:none}}";

const vars = (loading: boolean, paper: string): CSSProperties => {
  const set = {
    "--cm-paper": paper,
    "--cm-a1": loading ? "var(--primary)" : "currentColor",
  };
  // SAFETY: every key is a CSS custom property and every value is a string; React passes unknown
  // style keys straight through. The cast exists only because CSSProperties has no `--*` index.
  return set as CSSProperties;
};

export type MeowMarkProps = CollieMarkProps;

export function MeowMark({
  size = 32,
  loading = false,
  paper = "var(--background)",
  title,
  className,
}: MeowMarkProps) {
  const live = loading ? "cm-live" : "";
  const classes = className === undefined ? live || undefined : (live + " " + className).trim();
  return (
    <svg
      width={size}
      height={size}
      className={classes}
      viewBox="18 18 144 144"
      role={title === undefined ? "presentation" : "img"}
      aria-label={title}
      style={{ display: "block", flex: "none", ...vars(loading, paper) }}
    >
      <style>{STYLE}</style>
      {/* Ears, then the crown of the head; the window is drawn OVER the head's lower half, and the
          eyes sit on the head just above the window's top edge — the cat is behind the terminal. */}
      <polygon points="52,60 60,22 84,54" fill="currentColor" />
      <polygon points="128,60 120,22 96,54" fill="currentColor" />
      <path d="M56,70 a34,26 0 0 1 68,0" fill="currentColor" />
      <rect
        x="24"
        y="66"
        width="132"
        height="92"
        rx="14"
        fill="var(--cm-paper)"
        stroke="currentColor"
        strokeWidth="9"
      />
      <g className="mm-eyes" style={{ transformBox: "fill-box", transformOrigin: "center" }}>
        <ellipse cx="74" cy="62" rx="5" ry="7" fill="var(--cm-paper)" />
        <ellipse cx="106" cy="62" rx="5" ry="7" fill="var(--cm-paper)" />
      </g>
      <path
        d="M46,98 l14,12 l-14,12"
        stroke="currentColor"
        strokeWidth="9"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect className="mm-cursor" x="72" y="97" width="12" height="27" rx="2" />
    </svg>
  );
}
