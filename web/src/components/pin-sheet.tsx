import { ArrowDown, ArrowUp, ExternalLink, Pin, PinOff, X } from "lucide-react";

import { ActionRow, DestructiveActionRow } from "@/components/action-sheet-rows";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { useMuxCapability } from "@/lib/mux-capability";
import { useState } from "react";
import { movePinned, setPinned } from "@/hooks/use-dash-prefs";
import { buzz } from "@/lib/haptics";
import { t } from "@/lib/i18n";
import type { AgentView } from "@/lib/types";
import { paneName } from "@/lib/pane-name";

// FORK: the sheet a long press on a dashboard row opens — pin, un-pin, nudge a pinned row up or
// down, open the pane, or close it. Same `BottomSheet` + `ActionRow` anatomy as the pane and tab
// action sheets, so it reads as one of them.
//
// IT CARRIES NO RENAME, AND IT DID NOT CARRY A CLOSE EITHER until the operator asked for one
// (2026-09-15): "a dashboard hold should never be one tap from a close" was the old note here, and
// the answer to it is that it is not one tap — the row is the same two-tap `DestructiveActionRow`
// the pane's own sheet uses, and it sits last, under the reorder rows. The swipe on the row itself
// (components/swipe-close.tsx) is the same act for a thumb that would rather not read a menu; this
// row is what makes it reachable without knowing the gesture.
//
// The order edits go straight to the store (hooks/use-dash-prefs.ts), not through the parent: the
// dashboard re-renders off the same store, so there is no state to thread back.
export function PinSheet({
  open,
  pane,
  pinned,
  known,
  onClose,
  onOpen,
  onClosePane,
}: {
  open: boolean;
  /** The row that was held. Null while nothing is (sheet closed). */
  pane: AgentView | null;
  /** The pinned order as the dashboard is currently drawing it. */
  pinned: readonly string[];
  /** Every pane id the snapshot holds — what the store prunes stale pins against on an edit. */
  known: readonly string[];
  onClose: () => void;
  /** Open the held pane, as a tap on the row would have. */
  onOpen: (pane: AgentView) => void;
  /** Close it. Resolves true when the pane is gone; the caller owns the request and its error copy.
   *  Omitted on a read-only device, where the row is not drawn at all. */
  onClosePane?: (pane: AgentView) => Promise<boolean>;
}) {
  useLocale();
  const confirmClose = usePendingConfirm();
  const [closing, setClosing] = useState(false);
  // The pane's OWN machine decides whether it can be closed, exactly as the pane's sheet asks
  // (pane-actions-sheet.tsx): a crew member that cannot close panes must not be offered the row.
  const canClose = useMuxCapability("closePane", { host: pane?.host });
  const id = pane?.paneId ?? "";
  const at = pinned.indexOf(id);
  const isPinned = at >= 0;
  const title = pane ? paneName(pane) : "";

  const act = (fn: () => void) => {
    buzz();
    fn();
    onClose();
  };

  return (
    <BottomSheet open={open} onClose={onClose} title={title}>
      <div className="flex flex-col gap-1" data-slot="pin-sheet">
        {pane && (
          <ActionRow
            icon={<ExternalLink className="size-4 shrink-0 text-muted-foreground" />}
            label={t("home.pin.open")}
            onClick={() => act(() => onOpen(pane))}
          />
        )}
        <ActionRow
          icon={
            isPinned ? (
              <PinOff className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <Pin className="size-4 shrink-0 text-muted-foreground" />
            )
          }
          label={isPinned ? t("home.pin.unpin") : t("home.pin.pin")}
          onClick={() => act(() => setPinned(id, !isPinned, known))}
        />
        {isPinned && at > 0 && (
          <ActionRow
            icon={<ArrowUp className="size-4 shrink-0 text-muted-foreground" />}
            label={t("home.pin.moveUp")}
            onClick={() => act(() => movePinned(id, -1, known))}
          />
        )}
        {isPinned && at < pinned.length - 1 && (
          <ActionRow
            icon={<ArrowDown className="size-4 shrink-0 text-muted-foreground" />}
            label={t("home.pin.moveDown")}
            onClick={() => act(() => movePinned(id, 1, known))}
          />
        )}
        {pane && onClosePane !== undefined && canClose.capable && (
          <DestructiveActionRow
            icon={<X className="size-4 shrink-0" />}
            label={t("home.close.sheet")}
            confirmLabel={t("home.close.confirm")}
            closingLabel={t("home.close.closing")}
            armed={confirmClose.pending === pane.paneId}
            closing={closing}
            onClick={() => {
              if (closing) return;
              if (!confirmClose.confirm(pane.paneId)) return;
              buzz();
              setClosing(true);
              void (async () => {
                try {
                  // The sheet stays open on a refusal, so the status line it raised is read against
                  // the row that asked for it.
                  if (await onClosePane(pane)) onClose();
                } finally {
                  setClosing(false);
                }
              })();
            }}
          />
        )}
      </div>
    </BottomSheet>
  );
}
