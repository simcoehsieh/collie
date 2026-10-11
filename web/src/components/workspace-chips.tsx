import { Server } from "lucide-react";
import { useEffect, useRef } from "react";

import { Chip } from "@/components/ui/chip";
import { STRIP_SCROLLER } from "@/components/ui/labelled-strip";
import type { StripEntry } from "@/lib/dash-view";
import { HOST_TEXT_CLASSES, hostName, hostSlot } from "@/lib/hosts";
import { t } from "@/lib/i18n";
import type { WorkspaceGroup } from "@/lib/pane-groups";
import { worstTriage } from "@/lib/triage";
import type { ServerSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

// FORK: THE WORKSPACE STRIP, KEPT (operator, 2026-10-11, at the 1.19 merge: 「保留標籤列」).
//
// Upstream 1.19.0 (d7a323c3) replaced this strip with one Workspace select under the summary line and
// deleted it. This is the strip as 1.17.2 drew it, lifted out of components/agent-list.tsx into a file
// of its own so the next merge meets upstream's agent-list unchanged and only the one call site there.
//
// "All", then one chip per workspace in the list's own order, each lit with the worst status inside.
// Tap a chip to see that workspace alone, tap it or All to see everything again. Long-press a chip to
// hide the workspace, and again to bring it back; a hidden chip stays in the strip, dimmed, with its
// dot, so hiding never silences a workspace that needs you. One height always, so nothing below moves.
// A hidden MACHINE (issue #288) is one dimmed stand-in chip instead of its workspace chips, and a tap
// shows it again.
//
// The scroller keeps STRIP_SCROLLER's own `py-1.5` and must: that padding is the room a chip's
// STRIP_TAP_TARGET `::before` reaches into for the 44px tap floor.
export function WorkspaceChips({
  entries,
  isolatedKey,
  isHidden,
  servers,
  onIsolate,
  onToggleHidden,
  onShowMachine,
}: {
  entries: readonly StripEntry[];
  isolatedKey: string | undefined;
  isHidden: (g: WorkspaceGroup) => boolean;
  servers?: readonly ServerSummary[] | undefined;
  /** Tap a chip: that workspace alone, or `null` to show everything. */
  onIsolate: (group: WorkspaceGroup | null) => void;
  /** Long-press a chip: hide the workspace, or show it again. */
  onToggleHidden?: ((group: WorkspaceGroup) => void) | undefined;
  /** Tap a hidden machine's stand-in chip: show that machine again. */
  onShowMachine?: ((host: string) => void) | undefined;
}) {
  // A tap on a hidden machine's stand-in chip shows the machine, and the chip itself leaves. Its place
  // in the strip goes to the machine's first workspace chip, so focus goes there rather than falling
  // to `body`. Runs after every render and is cheap: it acts once, after the tap set the index.
  const stripRef = useRef<HTMLDivElement>(null);
  const refocusChipAt = useRef<number | null>(null);
  useEffect(() => {
    const at = refocusChipAt.current;
    if (at === null) return;
    refocusChipAt.current = null;
    stripRef.current?.querySelectorAll<HTMLElement>("button")[at]?.focus();
  });
  return (
    <nav aria-label={t("space.strip.title")} data-slot="workspace-chips" className="-mx-4">
      <div ref={stripRef} className={cn(STRIP_SCROLLER, "px-4")}>
        <Chip label={t("space.tabStrip.all")} active={isolatedKey === undefined} onClick={() => onIsolate(null)} />
        {entries.map((entry, i) => {
          if (entry.kind === "machine") {
            const name = hostName(servers, entry.host) ?? entry.host;
            const slot = hostSlot(servers, entry.host);
            return (
              <Chip
                // A group key always holds two NULs and this one holds one, so they never collide.
                key={`machine\u0000${entry.host}`}
                glyph={
                  <Server
                    aria-hidden
                    className={cn("size-3.5 shrink-0", slot === null ? "text-muted-foreground" : HOST_TEXT_CLASSES[slot])}
                  />
                }
                label={name}
                ariaLabel={t("home.machineHidden.show", { name })}
                active={false}
                dimmed
                status={worstTriage(entry.panes)}
                onClick={() => {
                  if (!onShowMachine) return;
                  // After "All", one button per entry: the machine's first chip takes this index.
                  refocusChipAt.current = i + 1;
                  onShowMachine(entry.host);
                }}
              />
            );
          }
          const g = entry.group;
          return (
            <Chip
              key={g.key}
              label={g.label}
              active={isolatedKey === g.key}
              dimmed={isolatedKey === undefined && isHidden(g)}
              status={worstTriage(g.panes)}
              onClick={() => onIsolate(isolatedKey === g.key ? null : g)}
              onLongPress={onToggleHidden ? () => onToggleHidden(g) : undefined}
            />
          );
        })}
      </div>
    </nav>
  );
}
