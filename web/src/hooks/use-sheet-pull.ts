import { useEffect, useRef, useState } from "react";

// Finger-tracked reveal for the pane-switcher handle. useSwipeUp (use-swipe.ts) only reads the
// start/end points and fires once on release, which reads as a swipe gesture, not a native sheet
// that follows the thumb. This hook reports every intermediate point so the caller can paint the
// sheet peeking up under the finger, then decides on release whether the drag crossed into "open"
// (far enough, or fast enough) the same way ui/sheet.tsx's drag-to-dismiss decides "close".

/** Upward travel (px) past which a release always opens, regardless of speed. */
export const OPEN_PX = 120;
/** Upward speed (px/ms) past which a release opens even on a short pull, a fling. */
export const FLING_PX_PER_MS = 0.6;
/** Travel (px) below which a touch is a tap, not a drag; mirrors ui/sheet.tsx's own SLOP. */
export const SLOP = 6;
/**
 * FORK: DOWNWARD travel (px) past which the gesture is a "put the dock away" pull rather than a
 * sheet pull. Fired once per gesture through `onPullDown`, after which that gesture is over for the
 * sheet: no peek, no open, no cancel. Well past SLOP so a wobbling thumb at rest never trips it.
 */
export const DOWN_PX = 40;

/**
 * FORK: UPWARD travel past which a gesture is a "bring it back" pull — the mirror of {@link DOWN_PX}
 * and the same number, because the two are one ladder and an asymmetric pair would mean the way back
 * is harder than the way out.
 *
 * It is NOT the sheet's own `OPEN_PX`, and it deliberately shadows it: a caller that wires
 * `onPullUp` is saying "up means something else right now" (agent-chat.tsx wires it only while
 * cinema mode is on), so the pane switcher must not also open behind it. A caller that leaves it
 * unset is untouched — the sheet keeps the whole upward half of the gesture, peek and all.
 */
export const UP_PX = DOWN_PX;

/** Pure: is `dy` (positive = up) a downward pull past {@link DOWN_PX}? Exported for the test. */
export function isPullDown(dy: number): boolean {
  return -dy >= DOWN_PX;
}

/** Pure: is `dy` (positive = up) an upward pull past {@link UP_PX}? Exported for the test. */
export function isPullUp(dy: number): boolean {
  return dy >= UP_PX;
}

/**
 * Pure open/cancel decision, exported on its own so it is unit-testable without simulating touch
 * events. `pull` is upward travel in px (0 for a downward or absent drag); `velocity` is the upward
 * px/ms over roughly the last 80ms of the gesture.
 */
export function shouldOpen(pull: number, velocity: number): boolean {
  if (pull >= OPEN_PX) return true;
  // A short, fast upward flick opens too, matching the fling most native sheets honour. A
  // measurement past pure noise (SLOP) is required so a stationary finger with jittery velocity
  // near zero pull can never trip it.
  return pull > SLOP && velocity >= FLING_PX_PER_MS;
}

/** Trailing window (ms) the velocity is measured over, recent enough to read as "how fast now". */
const VELOCITY_WINDOW_MS = 80;

/**
 * Given the handle's own distance from the viewport bottom (`anchor`, px) and the sheet's own
 * max-height (`sheetMax`, px, defaulting to 0.82 * innerHeight — BottomSheet's `max-h-[82dvh]`),
 * the most `pull` may report without the peeking panel's top edge overshooting that max-height.
 * Exported bare so the clamp is testable without a touch simulation: it's the one piece of the
 * anchor math with a wrong answer worth pinning on its own.
 */
export function maxPullForAnchor(anchor: number, sheetMax?: number): number {
  const cap = sheetMax ?? window.innerHeight * 0.82;
  return Math.max(0, cap - anchor);
}

interface UseSheetPullOptions {
  /** Fired on every tracked move once the drag has engaged, with the current upward pull in px. */
  onPull: (px: number) => void;
  /**
   * Fired once per gesture, on touchstart, with the handle's distance (px) from the viewport
   * bottom at that moment — `window.innerHeight - handleNode.getBoundingClientRect().top`. The
   * caller feeds this straight to `BottomSheet`'s `pullFrom` prop so the peeking panel's TOP edge
   * starts at the handle rather than at the screen's bottom edge, which is where a raw `pull` value
   * alone would put it (the handle sits above the composer, with the composer in between).
   */
  onAnchor: (px: number) => void;
  /** Fired on release when the drag crossed the open threshold ({@link shouldOpen}). */
  onOpen: () => void;
  /** Fired on release when it didn't; the caller resets its pull state back to 0. */
  onCancel: () => void;
  /**
   * Hard clamp on the reported pull. Defaults to `maxPullForAnchor(anchor)` — the sheet's own
   * 0.82 * innerHeight max-height, less whatever the anchor already spent — so `anchor + pull`
   * never overshoots the sheet's own ceiling regardless of how far the finger travels.
   */
  max?: number;
  /** FORK: fired once when the finger travels {@link DOWN_PX} DOWN from where it landed. */
  onPullDown?: () => void;
  /**
   * FORK: fired once when the finger travels {@link UP_PX} UP from where it landed — the mirror of
   * `onPullDown`. Wiring it CLAIMS the upward half of the gesture: `onPull`/`onOpen` never see it,
   * so a caller that still wants the sheet on an upward pull must leave this unset. Pass it
   * conditionally (`cond ? fn : undefined`) rather than branching inside it, so "is up spoken for
   * right now" is one readable expression at the call site.
   */
  onPullUp?: () => void;
}

interface UseSheetPullResult {
  ref: (node: HTMLElement | null) => void;
}

export function useSheetPull({
  onPull,
  onAnchor,
  onOpen,
  onCancel,
  max,
  onPullDown,
  onPullUp,
}: UseSheetPullOptions): UseSheetPullResult {
  const onPullDownRef = useRef(onPullDown);
  onPullDownRef.current = onPullDown;
  const onPullUpRef = useRef(onPullUp);
  onPullUpRef.current = onPullUp;
  // Callbacks travel through refs so the attach effect below runs once per DOM node rather than
  // re-binding listeners on every render, the same "read via ref, stay stable across renders"
  // shape hooks/use-spaces.ts uses for its own callbacks.
  const onPullRef = useRef(onPull);
  onPullRef.current = onPull;
  const onAnchorRef = useRef(onAnchor);
  onAnchorRef.current = onAnchor;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const maxRef = useRef(max);
  maxRef.current = max;
  // Set once per gesture (onStart), read by the clamp for the rest of it — the anchor cannot
  // change mid-drag, the handle isn't moving, only the finger is.
  const anchorRef = useRef(0);

  // A ref callback stored in state (not a plain useRef), because a plain ref gives the attach effect
  // below nothing to depend on, so it would run before the button exists and never re-run once it
  // does. State makes the node's arrival a render the effect can react to.
  const [node, setNode] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!node) return;

    let startY = 0;
    let engaged = false;
    // FORK: set once a DIRECTIONAL pull (down or up) has fired; the rest of that gesture belongs to
    // nobody — no peek, no open, no second fire in the other direction on the way back.
    let claimed = false;
    // Trailing samples for the velocity read, trimmed to the last VELOCITY_WINDOW_MS on each move.
    let samples: { t: number; y: number }[] = [];

    const clamp = (px: number) => {
      const cap = maxRef.current ?? maxPullForAnchor(anchorRef.current);
      return Math.min(Math.max(px, 0), cap);
    };

    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      startY = t.clientY;
      engaged = false;
      claimed = false;
      samples = [{ t: e.timeStamp, y: t.clientY }];
      // Measured once per gesture: the handle's own distance from the viewport bottom, so the
      // peek's top edge can start there instead of at the screen's bottom edge (BottomSheet's
      // `pullFrom`). The clamp above reads it back on every subsequent move.
      const anchor = window.innerHeight - node.getBoundingClientRect().top;
      anchorRef.current = anchor;
      onAnchorRef.current(anchor);
    };

    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      const dy = startY - t.clientY; // positive = moved up
      if (!engaged && Math.abs(dy) > SLOP) engaged = true;
      if (!engaged) return;

      // Non-passive listener: suppress the browser's own scroll/pull-to-refresh while the drag is
      // ours, same reasoning as ui/sheet.tsx's drag-to-dismiss.
      e.preventDefault();
      if (claimed) return;
      if (onPullDownRef.current && isPullDown(dy)) {
        claimed = true;
        onPullDownRef.current();
        return;
      }
      if (onPullUpRef.current && isPullUp(dy)) {
        claimed = true;
        onPullUpRef.current();
        return;
      }

      samples.push({ t: e.timeStamp, y: t.clientY });
      const cutoff = e.timeStamp - VELOCITY_WINDOW_MS;
      samples = samples.filter((s) => s.t >= cutoff);

      onPullRef.current(clamp(dy));
    };

    const onEnd = () => {
      if (!engaged) return;
      engaged = false;
      if (claimed) {
        onCancelRef.current();
        return;
      }
      const last = samples[samples.length - 1];
      const first = samples[0];
      const dy = last ? startY - last.y : 0;
      const pull = clamp(dy);
      let velocity = 0;
      if (first && last && last.t > first.t) {
        velocity = (first.y - last.y) / (last.t - first.t);
      }
      if (shouldOpen(pull, velocity)) onOpenRef.current();
      else onCancelRef.current();
    };

    node.addEventListener("touchstart", onStart, { passive: true });
    node.addEventListener("touchmove", onMove, { passive: false });
    node.addEventListener("touchend", onEnd);
    node.addEventListener("touchcancel", onEnd);
    return () => {
      node.removeEventListener("touchstart", onStart);
      node.removeEventListener("touchmove", onMove);
      node.removeEventListener("touchend", onEnd);
      node.removeEventListener("touchcancel", onEnd);
    };
  }, [node]);

  return { ref: setNode };
}
