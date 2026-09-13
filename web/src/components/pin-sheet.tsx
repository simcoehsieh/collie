import { ArrowDown, ArrowUp, ExternalLink, Pin, PinOff } from "lucide-react";

import { ActionRow } from "@/components/action-sheet-rows";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { movePinned, setPinned } from "@/hooks/use-dash-prefs";
import { buzz } from "@/lib/haptics";
import { t } from "@/lib/i18n";
import { paneDisplayName, type AgentView } from "@/lib/types";

// FORK: the sheet a long press on a dashboard row opens — pin, un-pin, nudge a pinned row up or
// down, or just open the pane. Same `BottomSheet` + `ActionRow` anatomy as the pane and tab action
// sheets, so it reads as one of them; it carries no rename or close, because those belong to the
// pane's own sheet inside the pane and a dashboard hold should never be one tap from a close.
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
}) {
  useLocale();
  const id = pane?.paneId ?? "";
  const at = pinned.indexOf(id);
  const isPinned = at >= 0;
  const title = pane ? paneDisplayName(pane) : "";

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
      </div>
    </BottomSheet>
  );
}
