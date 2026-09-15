import { useEffect, useRef, useState } from "react";
import type { ReactNode, TouchEvent as ReactTouchEvent } from "react";
import { Loader2, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { buzz } from "@/lib/haptics";

// FORK: SWIPE A DASHBOARD ROW LEFT TO CLOSE ITS PANE.
//
// The dashboard is where the operator sees a herd they are done with, and until now the only way to
// close one of those panes was to open it, open its ⋮ and take the close row inside — three screens
// away from the list that made the decision. The hold is already spent on the pin sheet (which
// carries this same close as a row, for a thumb that would rather read than swipe).
//
// THE SWIPE REVEALS, IT DOES NOT ACT. A gesture that killed a pane outright would be one flick of a
// scrolling thumb away from ending someone's work; what it does is uncover a button, and the button
// is the two-tap confirm every other destructive control in this app already uses. So a close is:
// swipe, tap, tap — the same three deliberate acts the pane's own sheet asks for.
//
// It never fights the list's scrolling: `touch-action: pan-y` hands vertical movement to the
// browser, and a gesture is only adopted once it is dominantly horizontal and past the slop.

/** How far the row slides, and how wide the revealed button is. One number, so they cannot disagree. */
export const REVEAL_PX = 96;

/** Movement before a drag is a drag rather than a tap's jitter. The same 8px the sheet pull uses. */
const SLOP = 8;

/** Past this much of the reveal, letting go opens it rather than springing back. */
const OPEN_AT = REVEAL_PX / 2;

/** A horizontal move must beat the vertical one by this much before the row takes the gesture. */
const DOMINANCE = 1.3;

export function SwipeClose({
  label,
  confirmLabel,
  closingLabel,
  onConfirm,
  children,
}: {
  label: string;
  /** What the button says once armed — the second tap is the one that closes. */
  confirmLabel: string;
  closingLabel: string;
  /** Resolves true when the pane is gone; false leaves the row where it is, error already reported. */
  onConfirm: () => Promise<boolean>;
  children: ReactNode;
}) {
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const [closing, setClosing] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const axis = useRef<"none" | "row" | "list">("none");
  const disarm = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The arm expires on its own, exactly as `usePendingConfirm` does for the sheets — an armed button
  // left on screen is a trap for the next thumb.
  useEffect(() => {
    if (!armed) return;
    disarm.current = setTimeout(() => setArmed(false), 3000);
    return () => {
      if (disarm.current) clearTimeout(disarm.current);
    };
  }, [armed]);

  const shut = () => {
    setOpen(false);
    setOffset(0);
    setArmed(false);
  };

  const onTouchStart = (e: ReactTouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    start.current = { x: t.clientX, y: t.clientY };
    axis.current = "none";
  };

  const onTouchMove = (e: ReactTouchEvent) => {
    const s = start.current;
    const t = e.touches[0];
    if (!s || !t) return;
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    // ONE-WAY LATCH, like the sheet pull's: a gesture the list claimed stays the list's even if the
    // thumb wanders sideways later, so a diagonal scroll never peels rows open on the way past.
    if (axis.current === "none") {
      if (Math.abs(dy) > SLOP && Math.abs(dy) >= Math.abs(dx) / DOMINANCE) {
        axis.current = "list";
        return;
      }
      if (Math.abs(dx) > SLOP && Math.abs(dx) > Math.abs(dy) * DOMINANCE) axis.current = "row";
    }
    if (axis.current !== "row") return;
    const from = open ? -REVEAL_PX : 0;
    setOffset(Math.max(-REVEAL_PX, Math.min(0, from + dx)));
  };

  const onTouchEnd = () => {
    start.current = null;
    if (axis.current !== "row") return;
    axis.current = "none";
    const next = -offset >= OPEN_AT;
    setOpen(next);
    setOffset(next ? -REVEAL_PX : 0);
    if (next) buzz();
    if (!next) setArmed(false);
  };

  async function tap() {
    if (closing) return;
    if (!armed) {
      buzz();
      setArmed(true);
      return;
    }
    setArmed(false);
    setClosing(true);
    try {
      const ok = await onConfirm();
      // A row whose pane is gone unmounts with the next snapshot; one that failed springs shut, so
      // the operator reads the error rather than an armed button sitting over a pane still running.
      if (!ok) shut();
    } finally {
      setClosing(false);
    }
  }

  return (
    <div data-slot="swipe-close" className="relative overflow-hidden">
      {/* Behind the row, and only as wide as the reveal: it is uncovered, never slid in, so what the
          thumb pulls back is the row itself and the button was there all along. */}
      <button
        type="button"
        onClick={() => void tap()}
        disabled={closing}
        tabIndex={open ? 0 : -1}
        aria-hidden={!open}
        data-slot="swipe-close-action"
        className={cn(
          "absolute inset-y-0 right-0 flex items-center justify-center gap-1.5 px-3 text-xs font-medium",
          "bg-destructive text-destructive-foreground transition-opacity",
          armed ? "opacity-100" : "opacity-90",
          open ? "" : "pointer-events-none",
        )}
        style={{ width: REVEAL_PX }}
      >
        {closing ? <Loader2 className="size-4 shrink-0 animate-spin" /> : <X className="size-4 shrink-0" />}
        <span className="truncate">{closing ? closingLabel : armed ? confirmLabel : label}</span>
      </button>
      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        // A tap anywhere on an OPEN row shuts it instead of opening the pane: the capture phase is
        // what stops the row's own click from reaching the card beneath.
        onClickCapture={(e) => {
          if (!open) return;
          e.preventDefault();
          e.stopPropagation();
          shut();
        }}
        className="relative bg-card"
        style={{
          touchAction: "pan-y",
          transform: `translateX(${offset}px)`,
          transition: start.current === null ? "transform 160ms ease-out" : "none",
        }}
      >
        {children}
      </div>
    </div>
  );
}
