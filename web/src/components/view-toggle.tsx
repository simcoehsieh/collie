import { MessagesSquare, SquareTerminal } from "lucide-react";

import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import type { PaneView } from "@/hooks/use-display-prefs";

// FORK — THE PANE'S TWO REPRESENTATIONS, AS ONE CONTROL.
//
// It rides in the composer's EXISTING Controls row (Keys / Type / Quick / Agent / ⚙), at its head,
// rather than as a row of its own — upstream #186 is the standing complaint that this screen has too
// many persistent bands, and a view switch is exactly the sort of thing that grows one. The row
// already folds away with the rest of the dock, which means chat mode inherits the fold instead of
// needing a second rule for it.
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
      className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted/60 p-0.5"
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
            disabled={disabled}
            onClick={() => onChange(view)}
            className={cn(
              // 40px tall, matching the Controls row's own buttons — a control that sits among them
              // and measures differently makes the row look broken before it looks small.
              "flex h-10 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors",
              on
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground active:bg-muted",
              disabled && "opacity-60",
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            {/* The word is hidden on the narrowest phones, where five controls already compete for
                366px; the icon plus the accessible name still carries it. */}
            <span className="hidden min-[380px]:inline">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
