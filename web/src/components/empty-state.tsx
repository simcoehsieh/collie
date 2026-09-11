import type { ReactNode } from "react";

import { MeowMark } from "@/components/meow-mark";
import { cn } from "@/lib/utils";

// FORK — THE ONE SHAPE FOR "THERE IS NOTHING HERE", AND FOR "IT BROKE".
//
// Four screens answered an empty or failed state with a grey sentence floating in the middle of
// nothing: the overview was the words "No agents running." and 700px of black; the root error
// boundary was a red line, a muted line, and "Reload" as a bare underlined link — the only
// underlined link in an app where every other action is a button.
//
// The app already knew how to do this properly, six screens away. `idle-lock.tsx` is the model:
// mark, heading, one honest sentence, one real button. This is that composition extracted, and the
// idle lock is deliberately NOT refactored onto it — that screen is a full-viewport glass dialog
// with its own panel, blur and geometry, and folding the two together would make this component
// carry a scrim it is never asked for anywhere else.
//
// WHAT EACH SLOT IS FOR, because an empty state that says nothing useful is just a nicer void:
//   • `mark` — the cat at rest by default. A different glyph where the situation is narrower than
//     "the app has nothing to show" (a lost connection is not a brand moment).
//   • `heading` — the FACT, in the app's own voice. Not an apology and not an exclamation.
//   • `body` — one sentence saying what would fill this space, or what to do. Optional: a heading
//     that is already the whole truth does not need a second line restating it.
//   • `detail` — the machine's own words, when there are any: an error string, a code. Set in a
//     muted mono chip, because it is a QUOTE and should not read as prose the app wrote.
//   • `action` — the one thing worth doing here, as a solid button. At most one. A screen with
//     nothing on it is the clearest place in the app for a single primary action, and it is the
//     one place the accent is unambiguous (see the `--control-on` / `--primary` split).
//
// Vertical rhythm is `idle-lock`'s: a 20px box around the mark so the panel's geometry never moves
// as a mark swaps, gap-6 between the block and the action, gap-3 inside the head.
interface EmptyStateProps {
  /** Override the mark. Pass `null` for none at all (a narrow inline empty state). */
  mark?: ReactNode;
  heading: string;
  body?: string;
  /** The machine's own words — an error message, a code. Rendered as a muted mono chip. */
  detail?: string;
  /** The one thing worth doing here. A `<Button>`; at most one. */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ mark, heading, body, detail, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-6 px-6 py-16 text-center",
        className,
      )}
    >
      <div className="flex flex-col items-center gap-3">
        {/* One 64px box whatever goes in it, so a mark swapping for a glyph moves nothing below.
            `paper` is the knockout that puts a near-side bead in front of the head, so it has to
            name the ground this sits on — every mount of this component is on the page. */}
        {mark !== null && (
          <span className="grid size-16 shrink-0 place-items-center text-muted-foreground">
            {mark ?? <MeowMark size={56} weight="header" paper="var(--background)" />}
          </span>
        )}
        <div className="space-y-1">
          <p className="font-medium">{heading}</p>
          {body !== undefined && (
            <p className="max-w-xs text-sm text-muted-foreground">{body}</p>
          )}
        </div>
        {detail !== undefined && (
          // A quote, not prose: mono, muted, and wrapped so a long bridge message still fits a
          // 390px screen rather than forcing the column wider.
          <p className="max-w-xs break-words rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs text-muted-foreground">
            {detail}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}
