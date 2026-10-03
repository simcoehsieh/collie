import { MessagesSquare, SquareTerminal } from "lucide-react";

import { HitArea, type HitReach } from "@/components/ui/hit-area";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import type { PaneView } from "@/hooks/use-display-prefs";

// FORK — THE PANE'S TWO REPRESENTATIONS, AS ONE CONTROL.
//
// It rides in the TAB ROW's trailing slot, beside the fold chevron (agent-chat.tsx hands both to
// TabStrip's `trailing`). That row is the header's "which pane" strip, and this is "which face of
// that pane" — the two are one decision about what is on screen, so they share a row. It was first
// placed at the head of the composer's Controls row (Keys / Type / Quick / Agent / ⚙), to avoid
// growing a band of its own; the cost was that its two labelled options took half of a 366px row
// and the four controls beside it ellipsised to their first letter on every phone. Up here it
// takes the pixels the 44px tab row was already spending, the way the chevron does.
//
// ICON-ONLY, because the row it now sits in is the tab scroller's, and every pixel the trailing
// slot takes is a pixel the last tab can no longer scroll into. The selected face is the one
// with the raised background; the accessible name carries the word.
//
// A SEGMENTED CONTROL AND NOT A TOGGLE BUTTON, because there are two NAMED destinations and the
// operator has to be able to see which one they are in without tapping to find out. `radiogroup` is
// the semantics that says exactly that, and it is what gives a screen reader the pair plus the
// selection in one announcement.
//
// FORCED IS NOT PRESSED. When a dialog owns the keyboard the pane shows the mirror whatever the
// stored choice is (agent-chat.tsx says why), so the control reflects the SCREEN — otherwise it
// would claim "Transcript" over a terminal — while `disabled` says the operator cannot move it right
// now. The stored choice is untouched and comes back when the dialog clears.
//
// Folding the strips takes this with them: the 24px summary bar that stands in for the rows has
// no room for a 32px control, and a folded band is the operator asking for the mirror's space,
// not for more chrome. Unfold to switch.
//
// THE 44px FLOOR, AS HIT AREA (survey round 3). Each 28px option reaches the 44px line the tab row's
// other controls reach — up to the row's top edge (the route's scroller clips above it) and down 14px
// over the mirror, raised over it — and sideways only into room nobody else claims: 1px toward its
// twin (half the 2px between them) and 15px outward. The outward room is bought with the capsule's
// own margins: `ml-1` plus the slot's and the scroller's padding leaves 15px clear of the "+"'s 9px
// reach even when the "+" is scrolled hard against the slot, and `mr-3` leaves 15px clear of the fold
// chevron's 2px left reach (agent-chat.tsx). The drawn circles do not change size; the capsule moves.
// `e2e/hit-areas.spec.ts` measures all of it in a browser.
const REACH = {
  transcript: { top: 2, bottom: 14, left: 15, right: 1 },
  terminal: { top: 2, bottom: 14, left: 1, right: 15 },
} satisfies Record<PaneView, HitReach>;

export function ViewToggle({
  value,
  onChange,
  disabled = false,
}: {
  /** Which view is ON SCREEN — not necessarily the stored choice; see the header. */
  value: PaneView;
  onChange: (view: PaneView) => void;
  /** A dialog or find owns the screen, so the mirror is not the operator's to give up right now. */
  disabled?: boolean;
}) {
  const options: readonly { view: PaneView; label: string; Icon: typeof MessagesSquare }[] = [
    { view: "transcript", label: t("chat.view.transcript"), Icon: MessagesSquare },
    { view: "terminal", label: t("chat.view.terminal"), Icon: SquareTerminal },
  ];
  return (
    <div
      role="radiogroup"
      data-slot="view-toggle"
      aria-label={t("chat.view.label")}
      // 32px tall, the same square recipe as the "+" and the fold chevron it sits beside: three
      // controls of one rank in one row, drawn to one height so none of them outranks the others.
      className="ml-1 mr-3 flex h-8 shrink-0 items-center gap-0.5 rounded-full bg-muted/60 p-0.5"
    >
      {options.map(({ view, label, Icon }) => {
        const on = value === view;
        return (
          <button
            key={view}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={() => onChange(view)}
            className={cn(
              "relative flex size-7 items-center justify-center rounded-full transition-colors",
              on ? "bg-background text-foreground shadow-xs" : "text-muted-foreground active:bg-muted",
              disabled && "opacity-60",
            )}
          >
            <HitArea {...REACH[view]} raised />
            <Icon className="size-4 shrink-0" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
