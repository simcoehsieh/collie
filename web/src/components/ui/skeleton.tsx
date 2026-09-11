import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

// FORK — THE PRIMITIVE FOR "SOMETHING OF A KNOWN SHAPE IS ARRIVING".
//
// The app had 52 `animate-spin` discs and no skeletons. A spinner is the right answer exactly once:
// when the wait has no shape — an update run, a transcription, a send whose duration nobody can
// predict. Everywhere else the shape IS known before the bytes land (the fork's own loaders return
// a memoised snapshot flagged `pending` and revalidate in the same tick — FORK.md → "The
// redesign"), and a disc spinning on top of a known shape is the one loading pattern that always
// reads as generic. A grey bar the exact height of the row it stands in for reads as the screen
// already being there and filling in.
//
// THREE RULES, AND THEY ARE THE WHOLE COMPONENT:
//
//   1. A bar is the SIZE OF ITS TARGET, passed by the caller. This file ships no sizes of its own
//      beyond a sane default height, because a skeleton that is not the size of the thing is a
//      second layout that shifts when the real one arrives — DESIGN.md §2, one frame later.
//   2. It is `aria-hidden` and carries NO text. The route's own `aria-busy` says a wait is on; a
//      screen reader announcing six grey rectangles is worse than silence.
//   3. The shimmer is CSS in `skin.css`, not a class here, and it is the ONLY animated part. With
//      that sheet absent (the playground on this branch, a test renderer) a skeleton is a still
//      muted bar — correct, just quiet — because the ground below is a plain Tailwind utility and
//      never depends on the sheet.
//
// `skeleton-delayed` is the other half, and it is CSS for a reason: the fallback for a lazy route
// must not paint for the ~80ms a precached chunk actually takes, and a `setTimeout` that flips
// state would re-render the tree to do what one `animation-delay` does for free. Held at opacity 0
// for 120ms (delay + `both` fill), exactly the technique `.busy-bar` already uses in index.css.

/**
 * One bar of the skeleton. Give it the size of the thing it stands in for — `className` is the
 * whole API on purpose.
 */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn("skeleton-bar block h-4 rounded-md bg-muted", className)} />;
}

/**
 * The wrapper a whole screen's worth of skeleton goes in: marks the region busy for assistive tech
 * and holds the paint back 120ms so a fast arrival never flashes.
 */
export function SkeletonScreen({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div aria-busy="true" className={cn("skeleton-delayed", className)}>
      {children}
    </div>
  );
}
