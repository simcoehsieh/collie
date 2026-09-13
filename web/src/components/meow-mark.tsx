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
// ── THE MARK IS THE HERD'S STATE, NOT JUST THE APP'S ─────────────────────────────────────────
// `state` is the second input and it is the one the header drives from the triage the dashboard
// already computes (lib/triage.ts). The operator then reads the herd off a 40px drawing in their
// peripheral vision instead of off a count they have to look at and parse, which is the thing this
// app is for. Four states, and each one spends a mechanism the mark already had:
//
//   idle      eyes forward, cursor solid in currentColor — the rest drawing, no animation at all
//   working   the eyes glance, the cursor blinks in --primary — exactly today's `loading`
//   blocked   the EARS FLATTEN and stay flattened, cursor solid in --status-blocked-mark
//   done      ONE slow blink, 900 ms, then rest — an acknowledgement, never a loop
//
// `loading` is kept and is an ALIAS OF `working`, so every existing call site (the boot splash, the
// idle lock, CollieHome's bloom and round) is byte-for-byte unchanged, and a caller that passes both
// gets working — a connection that is not answering outranks anything the herd has to say.
//
// WHY THOSE TWO NEW SIGNALS AND NOT A COLOUR SWAP. Flattened ears and a blink are things this
// particular drawing can do and a rectangle cannot; they are also the two states where a colour
// alone would be read as decoration. `done` does not loop BY CONSTRUCTION (one iteration, no fill),
// because a repeating acknowledgement stops being an acknowledgement and becomes a state.
//
// The cursor's blocked colour is `--status-blocked-mark` and not `--status-blocked`: the cursor is a
// filled rect ~3px wide at header size, and index.css's mark tokens exist for exactly that — the
// text half rasterises to an oxblood that disappears at this size.
//
// Under `prefers-reduced-motion` the COLOUR half of every state survives and the motion does not,
// which is the rule this file already kept for `loading` — and it is why `blocked` was given a
// colour as well as a movement.
//
//   <MeowMark size={132} />                            the mark
//   <MeowMark size={132} loading />                    while something is fetching
//   <MeowMark size={40} weight="header" />             below about 80px
//   <MeowMark size={40} state="blocked" />             an agent needs you
//
// A <style> inside an inline SVG is DOCUMENT-scoped, so the rules are shared by every instance on
// the page and everything per-instance is a custom property on the element. `weight` is accepted
// for the collie mark's contract; the cat has one geometry drawn with strokes that survive 40px
// (the thinnest line is 9/144 of the box, 2.5px at 40), so both weights draw the same thing.

import type { CSSProperties } from "react";

import type { CollieMarkProps } from "@/components/collie-mark";

// Every animation is named `cm-*` (the ramp's contract, see above) and every one of them is
// switched on by a STATE CLASS and by nothing else — `cm-live`, `cm-blocked`, `cm-done`. A bare
// `.mm-*` rule carrying an `animation` would be a drawing that moves at rest, which is the one thing
// this mark must never do; meow-mark.test.tsx pins that, by reading this string.
//
// `cm-ears` is six discrete frames (`steps(6)`) and `forwards`: the ears drop in six visible
// positions and STAY down, because blocked is a state and not an event. `cm-blink-once` runs a
// single iteration with no fill, so the eyes end open no matter when it is interrupted.
const STYLE =
  "@keyframes cm-blink{0%,49%{opacity:1}50%,100%{opacity:0}}" +
  "@keyframes cm-glance{0%,15%{transform:translateX(0)}35%,50%{transform:translateX(-4px)}70%,85%{transform:translateX(4px)}100%{transform:translateX(0)}}" +
  "@keyframes cm-ears{from{transform:scaleY(1)}to{transform:scaleY(.4)}}" +
  "@keyframes cm-blink-once{0%,30%{transform:scaleY(1)}50%{transform:scaleY(.08)}70%,100%{transform:scaleY(1)}}" +
  ".mm-cursor{fill:var(--cm-a1)}" +
  ".cm-live .mm-cursor{animation:cm-blink .6s step-end infinite}" +
  ".cm-live .mm-eyes{animation:cm-glance 2.4s ease-in-out infinite}" +
  ".cm-blocked .mm-ears{animation:cm-ears .3s steps(6) forwards}" +
  ".cm-done .mm-eyes{animation:cm-blink-once .9s ease-in-out 1}" +
  "@media (prefers-reduced-motion:reduce){.cm-live .mm-cursor,.cm-live .mm-eyes,.cm-blocked .mm-ears,.cm-done .mm-eyes{animation:none}}";

/** The four things the drawing can say. `loading` is an alias of `working`; see the header. */
export type MarkState = "idle" | "working" | "blocked" | "done";

/** The state class, or `""` for idle — which is the rest drawing and carries no class at all, so
 *  nothing is animating and there is nothing for the round's ramp to collect. */
const STATE_CLASS = {
  idle: "",
  working: "cm-live",
  blocked: "cm-blocked",
  done: "cm-done",
} satisfies Record<MarkState, string>;

/** The cursor's colour per state — the half a reduced-motion reader still gets, which is why
 *  `blocked` has one at all. `--status-blocked-mark`, not `--status-blocked`: this is a filled rect
 *  about 3px wide at header size, and index.css's mark tokens exist for exactly that. */
const STATE_ACCENT = {
  idle: "currentColor",
  working: "var(--primary)",
  blocked: "var(--status-blocked-mark)",
  done: "currentColor",
} satisfies Record<MarkState, string>;

const vars = (state: MarkState, paper: string): CSSProperties => {
  const set = {
    "--cm-paper": paper,
    "--cm-a1": STATE_ACCENT[state],
  };
  // SAFETY: every key is a CSS custom property and every value is a string; React passes unknown
  // style keys straight through. The cast exists only because CSSProperties has no `--*` index.
  return set as CSSProperties;
};

export type MeowMarkProps = CollieMarkProps & {
  /** What the herd is doing. Omitted is `idle`, the rest drawing. `loading` wins over it: a
   *  connection that is not answering outranks anything the herd has to say. */
  state?: MarkState;
};

export function MeowMark({
  size = 32,
  loading = false,
  state = "idle",
  paper = "var(--background)",
  title,
  className,
}: MeowMarkProps) {
  const showing: MarkState = loading ? "working" : state;
  const live = STATE_CLASS[showing];
  const classes = className === undefined ? live || undefined : (live + " " + className).trim();
  return (
    <svg
      width={size}
      height={size}
      className={classes}
      viewBox="18 18 144 144"
      role={title === undefined ? "presentation" : "img"}
      aria-label={title}
      style={{ display: "block", flex: "none", ...vars(showing, paper) }}
    >
      <style>{STYLE}</style>
      {/* Ears, then the crown of the head; the window is drawn OVER the head's lower half, and the
          eyes sit on the head just above the window's top edge — the cat is behind the terminal.
          The two ears are ONE group so `blocked` can flatten them together, and the origin is the
          group's own bottom edge — scaling toward the head is what reads as "flattened"; scaling
          about the centre would read as the ears shrinking. `fill-box` so the origin is the ears'
          bounding box and not the 144-unit viewBox, exactly as the eyes below already do. */}
      <g
        className="mm-ears"
        style={{ transformBox: "fill-box", transformOrigin: "center bottom" }}
      >
        <polygon points="52,60 60,22 84,54" fill="currentColor" />
        <polygon points="128,60 120,22 96,54" fill="currentColor" />
      </g>
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
