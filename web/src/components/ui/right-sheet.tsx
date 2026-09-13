import * as React from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { t as translate } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

// A right-edge sheet, for reading a whole PAGE inside the app instead of leaving the PWA for it.
// Same no-deps approach as ui/sheet.tsx's two siblings — no Radix, no portals, renders nothing when
// closed, dismisses on backdrop tap or Escape — but on the horizontal axis, and with the three
// things a document reader needs that a row list did not.
//
// ── THE EXPORT IS `RightSheet`, NOT `SideSheet` ──────────────────────────────────────────────────
// `SideSheet` is already the LEFT drawer in ui/sheet.tsx. Two components with the same name in one
// ui/ folder is a rename waiting to happen, and the axis is the whole difference between them, so
// the axis is in the name. The file is `right-sheet.tsx` because that is where the integrator asked
// for it; the alternative — a third export inside ui/sheet.tsx, which is how the house added the
// second one — was rejected only because this component may not edit that file. It carries roughly
// twice the machinery of either sibling (gesture arbitration, an exit animation, safe-area work on
// two edges), so a file of its own is defensible on size alone if it ever comes up again.
//
// ── THE DRAG LIVES ON THE HEADER, AND THAT IS NOT A STYLE CHOICE ─────────────────────────────────
// The body of this sheet holds a cross-document iframe (a knowledge-base doc served same-origin but
// framed into an opaque origin, so the parent cannot script into it). Touch events that begin
// inside that iframe dispatch in the IFRAME's document and never reach us: BottomSheet's shape —
// `panel.addEventListener("touchstart", …)` — would attach a listener that simply never fires for
// any finger that lands on the page being read, which is nearly the whole panel. So the grab region
// is the header row, which is our own chrome, outside the frame. This is pinned by a test, because
// the failure is invisible in jsdom and only shows up on glass.
//
// ── GESTURE ARBITRATION: ONE DECISION PER GESTURE, LATCHED ───────────────────────────────────────
// The panel is over a document that scrolls vertically, and the header sits above it, so a finger
// on the header can plausibly mean either "drag me away" or "I meant to flick the page". The rule
// is that the FIRST movement out of the slop circle decides the axis for the whole gesture and the
// answer never changes afterwards (see `claimAxis`). Re-deciding per move is the ambush: a vertical
// flick that curves right at the end would yank the panel sideways under the thumb, and a rightward
// drag that wobbles vertical mid-travel would drop the panel back mid-flight. A tie (|dx| == |dy|)
// goes to the scroller, on the principle that the browser owns the axis it was already panning.
//
// ── THE LEFT EDGE: FULL-WIDTH ON A PHONE, INSET FROM `sm` UP ─────────────────────────────────────
// In a home-screen PWA a swipe from the physical left edge goes back in history, so a panel that
// reaches that edge cannot also be grabbed there and thrown away: the system wins. The first cut of
// this sheet therefore held a strip of backdrop back on every screen, which bought three things at
// once — the system gesture kept its zone, the strip was the tap-to-dismiss target, and it showed
// that a terminal was still behind.
//
// On a phone that strip is not a signal, it is an unfinished edge: 8% of 393px is a sliver, and
// what it uncovers is a wall of coloured terminal text a few millimetres from the words being read.
// So below `sm` the panel is `w-full` and the strip is gone. The cost is stated here because it is
// invisible from the code — there is no backdrop left to tap, and the left edge is the system's
// again, where a swipe NAVIGATES rather than closes. The three remaining ways out (the ✕, the
// header drag, Escape) all live on the panel's own chrome, which is the reason the drag was put on
// the header in the first place rather than on an edge.
//
// From `sm` up the inset stays, because at that size the strip is not a sliver: it is a legible
// piece of the terminal beside the document, on a screen with room for both.

/** Travel (px) below which a touch is a tap, not a drag; the same 6 both existing gestures use. */
export const SLOP = 6;
/** Rightward travel (px) past which a release dismisses instead of snapping back. */
export const DISMISS_PX = 90;
/** Rightward speed (px/ms) past which a release dismisses even on a short drag, a fling. */
export const FLING_PX_PER_MS = 0.6;
/** How long the panel takes to leave the screen after a dismissing release; matches `duration-200`. */
export const EXIT_MS = 200;

/** Trailing window (ms) the fling velocity is measured over — recent enough to read as "how fast now". */
const VELOCITY_WINDOW_MS = 80;

/**
 * What one touch gesture has been decided to be.
 *
 * `undecided` — still inside the slop circle, nothing claimed yet, the browser keeps its default.
 * `dismiss` — ours: the panel follows the finger and the browser's own scrolling is suppressed.
 * `declined` — not ours, for the rest of this gesture, whatever the finger does next.
 */
export type DragClaim = "undecided" | "dismiss" | "declined";

/**
 * The axis rule, pure so it is testable without simulating touch (the house split — see
 * `shouldOpen` in hooks/use-sheet-pull.ts and `isSwipeUp` in hooks/use-swipe.ts).
 *
 * `prior` is what this same gesture decided on an earlier move, and it is returned unchanged the
 * moment it is anything but `undecided`: THE LATCH IS THE POINT. Without it a sloppy diagonal keeps
 * changing its mind, and the panel jitters between following the finger and letting go.
 *
 * `dx`/`dy` are travel from the gesture's start point, so a rightward drag is positive `dx`.
 * A dominant rightward move claims the drag; everything else — leftward, vertical-dominant, and a
 * dead-even diagonal — declines.
 */
export function claimAxis(prior: DragClaim, dx: number, dy: number): DragClaim {
  if (prior !== "undecided") return prior;
  if (Math.abs(dx) <= SLOP && Math.abs(dy) <= SLOP) return "undecided";
  return dx > 0 && dx > Math.abs(dy) ? "dismiss" : "declined";
}

/**
 * Pure dismiss/snap-back decision for a release, shaped exactly like `shouldOpen` in
 * hooks/use-sheet-pull.ts because it is the same question on the other axis. `dx` is rightward
 * travel in px (0 for a leftward or absent drag); `velocity` is rightward px/ms over roughly the
 * last {@link VELOCITY_WINDOW_MS}.
 *
 * The travel threshold is the same 90px BottomSheet closes on, so the two sheets let go at the same
 * distance and the app has one dismiss gesture rather than two that feel slightly different. The
 * fling clause needs travel past pure noise (SLOP) so a stationary finger with jittery velocity near
 * zero travel can never trip it.
 */
export function shouldDismiss(dx: number, velocity: number): boolean {
  if (dx >= DISMISS_PX) return true;
  return dx > SLOP && velocity >= FLING_PX_PER_MS;
}

// Copied from ui/sheet.tsx rather than imported, because there it is module-private and this
// component may not edit that file. If a fourth sheet ever wants it, hoist it once (a shared
// hooks/use-dialog-focus.ts) instead of copying it a third time.
//
// Minimal modal focus handling (no deps, no full trap): on open move focus into the panel so
// keyboard / screen-reader users land inside the dialog; on close restore focus to whatever was
// focused before it opened. The panel must carry tabIndex={-1} to be a focus target.
function useDialogFocus(open: boolean, panelRef: React.RefObject<HTMLElement | null>) {
  React.useEffect(() => {
    if (!open) return;
    // SAFETY: `document.activeElement` is typed `Element | null`; the only thing read off it below
    // is the optional `focus()`, which is what makes it an HTMLElement in practice. The optional
    // call is what covers the case where it isn't one (an SVG element, say).
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      previouslyFocused?.focus?.();
    };
  }, [open, panelRef]);
}

interface RightSheetProps {
  open: boolean;
  onClose: () => void;
  /** Names the dialog (aria-labelledby). For the doc reader this is the document's own title. */
  title?: string;
  /**
   * A second, quieter line under the title — the caller shows the document's URL there, so the
   * operator can tell WHICH page they are reading without leaving the app to look at an address
   * bar they no longer have. Also becomes the dialog's `aria-describedby`, because "which document"
   * is exactly the thing a screen-reader user cannot get from the framed content: an opaque-origin
   * iframe contributes nothing to this document's accessibility tree.
   */
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
}

export function RightSheet({ open, onClose, title, subtitle, children, className }: RightSheetProps) {
  useLocale();
  const panelRef = React.useRef<HTMLDivElement>(null);
  const grabRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  const subtitleId = React.useId();
  // Per-frame gesture state in a ref, only the painted offset in state — BottomSheet's split, and
  // for its reason: `dx` changes on every touchmove and only `dragX` needs to cost a render.
  const drag = React.useRef<{
    startX: number;
    startY: number;
    claim: DragClaim;
    dx: number;
    samples: { t: number; x: number }[];
  }>({ startX: 0, startY: 0, claim: "undecided", dx: 0, samples: [] });
  const [dragX, setDragX] = React.useState(0);
  // The panel is on its way out but the caller still has us open: the render below paints the exit
  // transform, and the effect that watches this calls `onClose` once the animation has played.
  const [exiting, setExiting] = React.useState(false);
  useDialogFocus(open, panelRef);

  // `onClose` travels through a ref so the listener-attaching effect below depends on `open` alone,
  // the same shape hooks/use-sheet-pull.ts uses for its callbacks. Depending on `onClose` directly
  // (which is what ui/sheet.tsx does) means a caller who passes an inline arrow re-runs that effect
  // on every render — and this effect resets the drag offset, so a poll-driven re-render mid-drag
  // would snap the panel back to 0 under a finger that is still moving.
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  // Backdrop dismiss requires press AND release on the backdrop itself (the Radix
  // outside-pointerdown rule) — NOT just whatever the browser happens to synthesize a `click` on. A
  // long-press that opens this sheet has its finger still down at the moment the sheet mounts; the
  // browser's release click then lands on whatever is now under the finger, which is the backdrop —
  // and without this guard that click would immediately close the sheet it just opened. Arming only
  // on a backdrop `pointerdown` means a click that originated elsewhere never dismisses.
  const backdropArmed = React.useRef(false);
  React.useEffect(() => {
    if (open) backdropArmed.current = false;
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Drag-to-dismiss, attached to the HEADER (see the file header: a finger on the framed document
  // is invisible to us). The touchmove listener is NON-PASSIVE so `preventDefault()` can suppress
  // the browser's own horizontal overscroll once the gesture is ours — same reasoning as
  // ui/sheet.tsx's vertical drag, where the thing being suppressed is pull-to-refresh.
  React.useEffect(() => {
    const grab = grabRef.current;
    if (!open || !grab) return;
    // Every open starts from rest. `exiting` in particular survives the close it caused — the caller
    // is free to keep this component mounted with `open={false}` — and a re-open that inherited it
    // would paint the panel from the previous fling's off-screen transform.
    setDragX(0);
    setExiting(false);

    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      drag.current = {
        startX: t.clientX,
        startY: t.clientY,
        claim: "undecided",
        dx: 0,
        samples: [{ t: e.timeStamp, x: t.clientX }],
      };
    };
    const onMove = (e: TouchEvent) => {
      const d = drag.current;
      if (d.claim === "declined") return;
      const t = e.touches[0];
      if (!t) return;
      d.claim = claimAxis(d.claim, t.clientX - d.startX, t.clientY - d.startY);
      if (d.claim !== "dismiss") return;
      e.preventDefault();
      // Clamped at 0: dragging LEFT cannot pull the panel past its own edge and open a gap of
      // backdrop on the right where the screen ends.
      const off = Math.max(0, t.clientX - d.startX);
      d.dx = off;
      d.samples.push({ t: e.timeStamp, x: t.clientX });
      const cutoff = e.timeStamp - VELOCITY_WINDOW_MS;
      d.samples = d.samples.filter((s) => s.t >= cutoff);
      setDragX(off);
    };
    const onEnd = () => {
      const d = drag.current;
      const off = d.dx;
      const first = d.samples[0];
      const last = d.samples[d.samples.length - 1];
      const velocity = first && last && last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
      drag.current = { startX: 0, startY: 0, claim: "undecided", dx: 0, samples: [] };
      if (shouldDismiss(off, velocity)) setExiting(true);
      else setDragX(0);
    };

    grab.addEventListener("touchstart", onStart, { passive: true });
    grab.addEventListener("touchmove", onMove, { passive: false });
    grab.addEventListener("touchend", onEnd);
    grab.addEventListener("touchcancel", onEnd);
    return () => {
      grab.removeEventListener("touchstart", onStart);
      grab.removeEventListener("touchmove", onMove);
      grab.removeEventListener("touchend", onEnd);
      grab.removeEventListener("touchcancel", onEnd);
    };
  }, [open]);

  // THE APP'S FIRST EXIT ANIMATION, and it is deliberately limited to this one path. Both sheets in
  // ui/sheet.tsx `return null` the instant they close, which is right for a tap: a tap has no
  // momentum, so nothing is owed a follow-through. A FLING does — a panel thrown to the right that
  // vanishes in mid-air reads as a crash, not as a dismissal — so the drag path paints the panel
  // off-screen first and reports the close once it has landed. The ✕, the backdrop and Escape still
  // close instantly, so "renders nothing when closed" stays true of every other route out.
  //
  // A timer rather than `transitionend`: under `prefers-reduced-motion` there is no transition and
  // therefore no event, and a sheet that could never close because the operator turned animations
  // off is a worse bug than a 200ms timer that occasionally fires a frame late.
  React.useEffect(() => {
    if (!exiting) return;
    // Optional chaining is the jsdom guard here, not a `typeof` check: `matchMedia` is simply absent
    // on `window` in a test environment that hasn't polyfilled it, same as `navigator.vibrate` is
    // absent on iOS Safari in lib/haptics.ts.
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduced) {
      onCloseRef.current();
      return;
    }
    const id = window.setTimeout(() => onCloseRef.current(), EXIT_MS);
    return () => window.clearTimeout(id);
  }, [exiting]);

  if (!open) return null;

  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const panelStyle: React.CSSProperties = exiting
    ? {
        transform: "translateX(100%)",
        transition: reducedMotion ? "none" : `transform ${EXIT_MS}ms ease-out`,
      }
    : {
        transform: dragX ? `translateX(${dragX}px)` : undefined,
        // No transition while the finger drives it; a springy snap-back on a release that didn't
        // travel far enough.
        transition: drag.current.claim === "dismiss" ? "none" : "transform 0.2s ease-out",
      };

  return (
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
      aria-describedby={subtitle ? subtitleId : undefined}
    >
      {/* Backdrop FIRST, panel second: `flex-1` on the backdrop pushes the panel to the right edge,
          which is the mirror image of ui/sheet.tsx's SideSheet and needs no `justify-*`. It
          dismisses on tap but is hidden from assistive tech — the header ✕ is the accessible
          "Close", so the dialog isn't announced with a giant duplicate close target. Dismiss fires
          only when the pointer went DOWN on it too — see backdropArmed above.

          Its opacity does NOT track the drag. Doing that convincingly needs progress as a fraction
          of the panel's own width, which means a layout read inside a touchmove; and scaling it by
          DISMISS_PX instead would have the scrim fully lifted while three-quarters of the panel is
          still on screen. The panel following the thumb is already the whole signal. */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        className="flex-1 bg-black/50 duration-200 animate-in fade-in"
        onPointerDown={() => {
          backdropArmed.current = true;
        }}
        onClick={() => {
          if (!backdropArmed.current) return;
          backdropArmed.current = false;
          onClose();
        }}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        style={panelStyle}
        className={cn(
          // Same ground and same edge as both sheets in ui/sheet.tsx, for the same reason — one
          // panel surface app-wide, raised off the page (`--card`) rather than painted in the page's
          // own token, with `--rule` for the cut between REGIONS (DESIGN.md §4). `border-l` here
          // because the edge that faces the app is the left one.
          //
          // `w-full sm:w-[92%]`: full-bleed on a phone, inset from `sm` up so the leftmost strip of
          // glass stays iOS's back-swipe zone rather than ours (see the file header). The rounded
          // corner and the left rule are inset-only for the same reason they exist at all — they
          // mark the cut between this panel and the app behind it, and full-bleed there is no cut:
          // a `rounded-l-md` against the screen edge would only open two notches of backdrop at the
          // corners. `max-w-2xl` (672px) rather than BottomSheet's `max-w-screen-sm` (640px): that
          // cap is the argument that a sheet holding ROWS stops at the same content column every
          // route body uses, and this one holds a document — a page with its own tables and code
          // blocks wants a little more than a list of phone-width rows. It is still capped, because
          // uncapped 92% is 1257px of prose measure on a landscape 13-inch iPad, which nobody can
          // read; below `sm` the cap is slack anyway, since the viewport is narrower than it.
          //
          // `overflow-hidden` so the framed document is clipped by the panel's own rounded edge
          // instead of painting over it.
          "relative z-10 flex h-full w-full max-w-2xl flex-col overflow-hidden border-l-0 border-rule bg-card shadow-2xl",
          "sm:w-[92%] sm:rounded-l-md sm:border-l",
          "duration-200 animate-in slide-in-from-right",
          // TWO SAFE-AREA EDGES, AND THEY ARE NOT SPELLED THE SAME WAY ON PURPOSE.
          //
          // Bottom uses the `--safe-bottom` token, not `env()` directly: index.css gives that token
          // a 34px floor under `@media (display-mode: standalone)` because iOS 26 reports
          // `env(safe-area-inset-bottom) = 0` in this app's own home-screen install while still
          // placing content under the home indicator (measured on the operator's iPhone 15 Pro).
          //
          // Right uses `env(safe-area-inset-right)` directly, and it is the first use of that inset
          // anywhere in this repo — a new precedent, so: both existing sheets are anchored to an
          // edge whose inset they either handle (BottomSheet) or never touch (SideSheet's left).
          // A full-height panel flush against the RIGHT edge is the first thing here that occupies
          // the band a landscape iPhone reserves on that side, and without this its content runs
          // under the display's curve. There is no measured platform lie on this axis, so `env()`
          // needs no token to sit behind it.
          "[padding-right:env(safe-area-inset-right)] pb-[calc(var(--safe-bottom)_+_0.5rem)]",
          className,
        )}
      >
        {/* The header is BOTH chrome and the grab region — the only part of the panel whose touches
            we are guaranteed to see. `touch-action: pan-y` states the arbitration declaratively as
            well as in JS: the browser is told up front that horizontal is ours, so it never has to
            wait for a `preventDefault()` to decide whether to start its own pan. */}
        <div
          ref={grabRef}
          data-slot="right-sheet-grab"
          className="flex shrink-0 items-center gap-2 border-b border-rule bg-card/95 px-4 py-3 backdrop-blur-md [padding-top:calc(env(safe-area-inset-top)_+_0.75rem)] [touch-action:pan-y]"
        >
          {/* The transpose of BottomSheet's grab handle: a 4px-thick stadium, turned to stand along
              the axis this sheet is dragged on, so the affordance points the way the finger goes. */}
          <span aria-hidden="true" className="h-9 w-1 shrink-0 rounded-md bg-muted-foreground/40" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span id={title ? titleId : undefined} className="truncate text-sm font-semibold">
              {title}
            </span>
            {subtitle && (
              <span id={subtitleId} title={subtitle} className="truncate text-xs text-muted-foreground">
                {subtitle}
              </span>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            onClick={onClose}
            aria-label={translate("common.closeAria")}
          >
            <X className="size-4" />
          </Button>
        </div>
        {/* `overscroll-contain` so a scroll that bottoms out inside the document does not chain to
            the terminal mirror still sitting behind the backdrop. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
      </div>
    </div>
  );
}
