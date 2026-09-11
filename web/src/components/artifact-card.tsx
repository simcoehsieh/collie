import { File, FileCode2, FileText, Image as ImageIcon, Pin } from "lucide-react";

import { useLocale } from "@/hooks/use-locale";
import { artifactSize } from "@/lib/artifacts";
import { t } from "@/lib/i18n";
import type { ArtifactKind, ArtifactView } from "@/lib/types";
import { cn } from "@/lib/utils";

// FORK — one artifact as a row: the thing the thread shows under the turn that made it, the pane's
// sheet lists, and the library route stacks. One component so the three surfaces cannot drift in
// what an artifact LOOKS like; what they differ in is only where a tap goes (`onOpen`).
//
// The row is a button, not a link: the viewer is a route, but the surfaces that mount this are
// already inside routers of their own (a sheet, a transcript) and hand the navigation up.

export function ArtifactKindIcon({ kind, className }: { kind: ArtifactKind; className?: string }) {
  const cls = cn("size-4 shrink-0", className);
  switch (kind) {
    case "html":
      return <FileCode2 className={cls} aria-hidden />;
    case "markdown":
    case "text":
      return <FileText className={cls} aria-hidden />;
    case "image":
      return <ImageIcon className={cls} aria-hidden />;
    case "file":
      return <File className={cls} aria-hidden />;
  }
}

/** `10:03` today, `Sep 11` this year, `2025-09-11` otherwise — the shortest stamp that still places it. */
export function artifactWhen(createdMs: number, now: number = Date.now()): string {
  const d = new Date(createdMs);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  if (d.getFullYear() === n.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toISOString().slice(0, 10);
}

export function ArtifactCard({
  artifact,
  onOpen,
  showPane = false,
  className,
}: {
  artifact: ArtifactView;
  onOpen: (artifact: ArtifactView) => void;
  /** Say which pane it came from — for the library, where rows from every pane sit together. */
  showPane?: boolean;
  className?: string;
}) {
  useLocale();
  const from =
    artifact.pane !== null
      ? `${artifact.pane.workspaceLabel} › ${artifact.pane.agent}`
      : artifact.origin !== null
        ? artifact.origin
        : null;
  return (
    <button
      type="button"
      data-slot="artifact-card"
      onClick={() => onOpen(artifact)}
      aria-label={t("artifacts.card.open", { title: artifact.title })}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md border bg-muted/40 px-2.5 py-2 text-left transition-colors active:bg-muted/70",
        className,
      )}
    >
      <ArtifactKindIcon kind={artifact.kind} className="text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-medium">{artifact.title}</span>
          {artifact.version > 1 && (
            <span className="shrink-0 rounded-full bg-primary/15 px-1.5 font-mono text-[10px] tabular-nums text-primary">
              {t("artifacts.card.version", { version: String(artifact.version) })}
            </span>
          )}
          {artifact.pinned && <Pin className="size-3 shrink-0 text-primary" aria-hidden />}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
          <span>{t(`artifacts.kind.${artifact.kind}`)}</span>
          <span aria-hidden>·</span>
          <span className="tabular-nums">{artifactSize(artifact.size)}</span>
          <span aria-hidden>·</span>
          <span className="tabular-nums">{artifactWhen(artifact.createdMs)}</span>
          {showPane && from !== null && (
            <>
              <span aria-hidden>·</span>
              <span className="min-w-0 truncate">{from}</span>
            </>
          )}
        </span>
      </span>
    </button>
  );
}

/** The "N artifacts" chip in the pane header — the door to the pane's sheet, and the count itself. */
export function ArtifactCountChip({ count, onClick }: { count: number; onClick: () => void }) {
  useLocale();
  return (
    <button
      type="button"
      data-slot="artifact-count"
      onClick={onClick}
      aria-label={t("artifacts.chip.aria", { count })}
      className="flex h-7 shrink-0 items-center gap-1 rounded-full border border-transparent bg-muted px-2 text-xs font-medium text-muted-foreground transition-colors active:bg-muted/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <FileCode2 className="size-3.5" />
      <span className="tabular-nums">{count}</span>
    </button>
  );
}

