import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ECHO_DONE_MS, useActionEcho } from "@/hooks/use-action-echo";
import type { EchoPhase } from "@/hooks/use-action-echo";
import { useOperatorQuickReplies } from "@/lib/operator-config";
import { FOLDED_GROUP, quickRepliesFor } from "@/lib/quick-replies";
import type { HarnessBarItem } from "@/lib/harness-bar";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { Collapse } from "@/components/ui/collapse";
import { t as translate, type MessageKey } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

interface QuickActionsContentProps {
  /** Resolves true once the reply is verified sent — drives the ✓ and the deferred close. */
  onSend: (text: string) => Promise<boolean>;
  onClose: () => void;
  /** The pane's agent + kind — pick the reply set (lib/quick-replies). A shell gets y/n, not "skip". */
  agent: string | undefined | null;
  isShell: boolean;
  disabled?: boolean;
  /**
   * FORK: the running harness's own commands — `/model`, `/effort`, `/compact`, `/resume` on Claude
   * Code (lib/harness-bar.ts). They used to be a tinted section of the actions belt, which meant
   * panning the belt sideways to reach them; the operator asked for them here instead, where the
   * dock has room to draw them as a grid and the belt gets its width back (2026-09-19).
   *
   * Empty (the default) draws nothing at all and this dock is byte-identical to what it was — which
   * is what a shell pane, an unknown harness, and the operator's own Settings switch all produce.
   */
  harness?: readonly HarnessBarItem[];
}

/** `quickRepliesFor`'s group titles are catalog identifiers ("confirm"/"common"), not display text —
 *  translate them here rather than in the data (lib/quick-replies.ts is the sent-verbatim catalog,
 *  a different content class from a UI label). Unknown ids (a future catalog entry) fall back to the
 *  raw identifier rather than throwing. */
function groupTitle(title: string): string {
  return title === "confirm"
    ? translate("quickActions.group.confirm")
    : title === "common"
      ? translate("quickActions.group.common")
      : title === FOLDED_GROUP
        ? translate("quickActions.group.others")
        : title;
}

/** Stable identity for the default — a fresh `[]` each render would be a new prop every time. */
const NO_HARNESS: readonly HarnessBarItem[] = [];

/** The harness group's heading: the agent's own name, which is what the belt's tint used to say. */
function harnessTitle(agent: string | undefined | null): string {
  return agent != null && agent !== "" ? agent : translate("quickActions.group.harness");
}

/** A shipped row carries an i18n key; an operator's row carries its own words (harness-bar.ts). */
function harnessLabel(item: HarnessBarItem): string {
  // SAFETY: the `harnessBar.` prefix is exactly what marks a shipped row's label as an i18n key
  // (HarnessBarItem.label documents the split, and harness-bar.ts's invariant test holds the
  // catalog to it). An operator's own words never carry the prefix and are printed as they stand.
  return item.label.startsWith("harnessBar.") ? translate(item.label as MessageKey) : item.label;
}

// Module-level so it isn't a fresh component type each render (which would remount the grid).
function Group({
  title,
  items,
  cols,
  disabled,
  busy,
  phaseOf,
  onFire,
}: {
  title: string;
  items: readonly string[];
  cols: string;
  disabled?: boolean;
  /** Some reply in the dock is in flight — the untapped siblings dim and lock out. */
  busy: boolean;
  phaseOf: (id: string) => EchoPhase;
  onFire: (text: string) => void;
}) {
  return (
    <div>
      <p className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className={`grid gap-2 ${cols}`}>
        {items.map((t) => {
          const phase = phaseOf(t);
          return (
            <Button
              key={t}
              type="button"
              // The tapped reply goes accent (and stays undimmed under `disabled`, so it reads over
              // its dimmed siblings) — the same busy language the dialog option rows use.
              variant={phase === "idle" ? "outline" : "default"}
              disabled={disabled || busy}
              onClick={() => onFire(t)}
              className={cn(
                "h-12 gap-1.5 text-sm font-medium",
                phase !== "idle" && "disabled:opacity-100",
              )}
            >
              {phase === "pending" && <Loader2 className="size-4 animate-spin" />}
              {phase === "done" && <Check className="size-4" />}
              {t}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

// The Quick-actions body — the two one-tap reply grids, no chrome of its own. Docked in-flow by the
// composer (same ComposerDock wrapper as Keys), so it never covers the mirror. Padding matches
// NavTray so both docks read identically.
//
// The dock deliberately stays up THROUGH the send. It used to close on the tap itself, which meant
// the reply's only acknowledgement — the ✓ on the composer's Send button — flashed a second later on
// a surface you'd already been navigated away from, so a quick reply felt like it vanished into
// nothing. Now the tapped button owns its own feedback (spinner → ✓, siblings dimmed) and the dock
// closes after the ✓, once you've seen where your tap went. A FAILED send leaves the dock open with
// every button live again, so you can retry without reopening it.
export function QuickActionsContent({
  onSend,
  onClose,
  agent,
  isShell,
  disabled,
  harness = NO_HARNESS,
}: QuickActionsContentProps) {
  useLocale();
  const operatorGroups = useOperatorQuickReplies();
  const groups = quickRepliesFor(agent, isShell, operatorGroups);
  const echo = useActionEcho();
  // The harness rows keep the two-tap the belt gave them: `/compact` and `/resume` are not undoable
  // and moving them into this dock must not quietly make them one tap (lib/harness-bar.ts marks
  // which, and an operator's own row inherits the shipped floor).
  const harnessConfirm = usePendingConfirm();
  // The folded group, shut on every open. Deliberately NOT remembered: the phrases behind it are the
  // burst-use half, and a dock that reopens holding yesterday's expansion is the wall this split
  // just removed.
  const [othersOpen, setOthersOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  const fire = (text: string) => {
    if (disabled || echo.pending) return;
    void echo.run(text, async () => {
      const ok = await onSend(text);
      // Let the ✓ land before the dock goes. On failure we hold it open — the status bar carries the
      // reason and the user is one tap from trying again.
      if (ok) closeTimer.current = setTimeout(onClose, ECHO_DONE_MS);
      return ok;
    });
  };

  const fireHarness = (item: HarnessBarItem) => {
    if (disabled || echo.pending) return;
    if (item.confirm === true && !harnessConfirm.confirm(item.id)) return; // first tap arms it
    harnessConfirm.reset();
    void echo.run(item.id, () => onSend(item.command));
  };

  return (
    <div className="space-y-4 border-t border-rule bg-muted/30 px-3 py-2.5">
      {/* FORK: the harness's own commands lead. They are the reason this dock is opened on a Claude
          pane at all now, and they are the half that acts on the PROGRAM rather than answering it. */}
      {harness.length > 0 && (
        <div>
          <p className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            {harnessTitle(agent)}
          </p>
          <div className="grid grid-cols-2 gap-2">
            {harness.map((item) => {
              const phase = echo.phaseOf(item.id);
              const armed = harnessConfirm.pending === item.id;
              return (
                <Button
                  key={item.id}
                  type="button"
                  variant={phase === "idle" && !armed ? "outline" : "default"}
                  disabled={disabled || echo.pending}
                  onClick={() => fireHarness(item)}
                  className={cn(
                    "h-12 gap-1.5 text-sm font-medium",
                    phase !== "idle" && "disabled:opacity-100",
                  )}
                >
                  {phase === "pending" && <Loader2 className="size-4 animate-spin" />}
                  {phase === "done" && <Check className="size-4" />}
                  {armed ? translate("quickActions.confirm") : harnessLabel(item)}
                </Button>
              );
            })}
          </div>
        </div>
      )}
      {groups.map((g) =>
        g.title === FOLDED_GROUP ? (
          // ONE BUTTON, THEN THE GRID. The fold is a peer of the rows above it rather than a header
          // with a chevron on the right: it is a thing you press, and at this size a whole-width
          // target reads that way where a 12px caret does not.
          <div key={g.title}>
            <Button
              type="button"
              variant="outline"
              aria-expanded={othersOpen}
              disabled={disabled || echo.pending}
              onClick={() => setOthersOpen((v) => !v)}
              className="h-10 w-full justify-center gap-1.5 text-sm font-medium text-muted-foreground"
            >
              {groupTitle(g.title)}
              <ChevronDown className={cn("size-4 transition-transform", othersOpen && "rotate-180")} />
            </Button>
            <Collapse open={othersOpen}>
              <div className="grid grid-cols-2 gap-2 pt-2">
                {g.items.map((text) => {
                  const phase = echo.phaseOf(text);
                  return (
                    <Button
                      key={text}
                      type="button"
                      variant={phase === "idle" ? "outline" : "default"}
                      disabled={disabled || echo.pending}
                      onClick={() => fire(text)}
                      className={cn(
                        "h-12 gap-1.5 text-sm font-medium",
                        phase !== "idle" && "disabled:opacity-100",
                      )}
                    >
                      {phase === "pending" && <Loader2 className="size-4 animate-spin" />}
                      {phase === "done" && <Check className="size-4" />}
                      {text}
                    </Button>
                  );
                })}
              </div>
            </Collapse>
          </div>
        ) : (
          <Group
            key={g.title}
            title={groupTitle(g.title)}
            items={g.items}
            cols="grid-cols-2"
            disabled={disabled}
            busy={echo.pending}
            phaseOf={echo.phaseOf}
            onFire={fire}
          />
        ),
      )}
    </div>
  );
}
