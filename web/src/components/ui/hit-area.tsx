import { cn } from "@/lib/utils";

// FORK — THE 44px FLOOR, BOUGHT AS HIT AREA, FOR A CONTROL THAT IS NOT A PILL.
//
// DESIGN.md §6: 44px is the floor for anything tappable, and where drawn size is expensive the floor
// is bought as HIT area instead. `STRIP_TAP_TARGET` (`labelled-strip.tsx`) does it for the strip pills
// with a `::before`. This is the same idea for every other small control — the fork's reading
// toolbars and the pane's view switch — with two differences, both on purpose:
//
//  - It is a real element, not a pseudo-element. A browser test can then measure exactly the box a
//    finger can hit (`getBoundingClientRect`, `elementFromPoint`) instead of inferring it from a
//    class name, which is how a reach that silently stopped reaching would get caught.
//  - The reach is stated per side, at the call site, with the room that side has. "No two targets
//    overlap" is a fact about a control's NEIGHBOURS, and only the call site knows them; a single
//    symmetric reach is how the fold chevron's left half ended up over the view switch beside it.
//
// Put it FIRST inside a `relative` control. It is absolutely positioned, so it costs the layout nothing
// and the drawn box is exactly what it was; it is a child, so a tap on it is a tap on the control.
// An absolutely placed box resolves its insets against the parent's PADDING box, one border inside the
// drawn edge — `border` says how thick that border is, so every reach below is measured from the edge
// the eye sees. A disabled control inherits `pointer-events: none` down to this box, so a disabled
// control's reach does not swallow a tap either.

export interface HitReach {
  /** Pixels past the drawn top edge. */
  readonly top?: number;
  /** Pixels past the drawn right edge. */
  readonly right?: number;
  /** Pixels past the drawn bottom edge. */
  readonly bottom?: number;
  /** Pixels past the drawn left edge. */
  readonly left?: number;
}

export interface HitAreaProps extends HitReach {
  /** The control's own border width — `Button` draws a 1px transparent one. */
  readonly border?: number;
  /**
   * Lift the box over later, positioned content it reaches across — the tab row's reach lies over the
   * terminal mirror, which is positioned and later in the tree and would otherwise take the tap
   * (the same `z-[1]` `TAB_ROW_SQUARE_TAP_TARGET` carries, for the same reason).
   */
  readonly raised?: boolean;
}

/** The floor every tappable thing owes, in CSS pixels (DESIGN.md §6). */
export const TAP_FLOOR_PX = 44;

/** One side's inset: the reach plus the border, outward — and a plain 0 where there is neither. */
function outward(reach: number, border: number): number {
  const distance = reach + border;
  return distance === 0 ? 0 : -distance;
}

/** The inline insets for a reach, measured from the drawn edge through a `border`-thick border. */
export function hitInsets({ top = 0, right = 0, bottom = 0, left = 0, border = 0 }: HitAreaProps) {
  return {
    top: outward(top, border),
    right: outward(right, border),
    bottom: outward(bottom, border),
    left: outward(left, border),
  };
}

export function HitArea(props: HitAreaProps) {
  return (
    <span
      aria-hidden="true"
      data-slot="hit-area"
      className={cn("absolute", props.raised === true && "z-[1]")}
      style={hitInsets(props)}
    />
  );
}
