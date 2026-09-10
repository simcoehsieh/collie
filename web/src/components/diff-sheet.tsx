import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, Copy, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { RightSheet } from "@/components/ui/right-sheet";
import type { MirrorFont } from "@/hooks/use-display-prefs";
import { useLocale } from "@/hooks/use-locale";
import * as api from "@/lib/api";
import { isApiErrorStatus } from "@/lib/api";
import { buzz } from "@/lib/haptics";
import { t } from "@/lib/i18n";
import type { Scope } from "@/lib/scope";
import { shortenHome } from "@/lib/shorten-home";
import type { DiffFileView, PaneDiffPatchResponse, PaneDiffStatResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

// FORK: what the agent changed, read off the pane's own work tree — the file list with counts,
// and one tap further a file's unified diff. Read-only: the phone looks, the agent in the pane
// acts. The bridge half is bridge/diff.ts; this is the sheet.
//
// It shares the document panel's host (`RightSheet`) because it is the same kind of thing: a page
// beside the terminal, dismissed with a swipe, that the mirror stays live behind.

interface DiffSheetProps {
  open: boolean;
  onClose: () => void;
  paneId: string;
  scope?: Scope;
  /** The mirror's font size, so a patch reads at the size the operator already chose for code. */
  fontSize: number;
  /** The mirror's face, for the same reason. */
  mirrorFace: MirrorFont;
  /** The answering host's home, so the repo root reads `~/git/proj`. Empty leaves it absolute. */
  home?: string;
}

type Loaded<T> = { phase: "loading" } | { phase: "ready"; data: T } | { phase: "failed"; message: string };

/** The status letter's tint and label. Untracked and added are the same colour: both are new. */
function statusClass(status: string): string {
  switch (status) {
    case "A":
    case "?":
      return "text-status-done";
    case "D":
      return "text-status-blocked";
    case "U":
      return "text-status-blocked";
    default:
      return "text-status-working";
  }
}

/** The sentence for a refused list or patch, by status. */
function describeFailure<TThrown>(e: TThrown): string {
  if (isApiErrorStatus(e, 404)) return t("diff.error.notRepo");
  if (isApiErrorStatus(e, 403)) return t("diff.error.outside");
  return t("diff.error.failed");
}

export function DiffSheet({ open, onClose, paneId, scope, fontSize, mirrorFace, home = "" }: DiffSheetProps) {
  useLocale();
  const [stat, setStat] = useState<Loaded<PaneDiffStatResponse>>({ phase: "loading" });
  const [file, setFile] = useState<string | null>(null);
  const [patch, setPatch] = useState<Loaded<PaneDiffPatchResponse>>({ phase: "loading" });
  const [copied, setCopied] = useState(false);
  // One in-flight request per view; a newer one aborts the older so a slow answer cannot land on
  // top of a fresher one (the same shape every loader in this app uses).
  const inFlight = useRef<AbortController | null>(null);

  const loadStat = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setStat((prev) => (prev.phase === "ready" ? prev : { phase: "loading" }));
    try {
      const data = await api.fetchPaneDiff(paneId, { mode: "stat" }, scope, controller.signal);
      if (controller.signal.aborted || data.mode !== "stat") return;
      setStat({ phase: "ready", data });
    } catch (e) {
      if (controller.signal.aborted) return;
      setStat({ phase: "failed", message: describeFailure(e) });
    }
  }, [paneId, scope]);

  const loadPatch = useCallback(
    async (path: string) => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      setPatch({ phase: "loading" });
      try {
        const data = await api.fetchPaneDiff(paneId, { mode: "patch", path }, scope, controller.signal);
        if (controller.signal.aborted || data.mode !== "patch") return;
        setPatch({ phase: "ready", data });
      } catch (e) {
        if (controller.signal.aborted) return;
        setPatch({ phase: "failed", message: describeFailure(e) });
      }
    },
    [paneId, scope],
  );

  // Opening (re)loads the list and lands on it; closing forgets the file so a re-open never
  // greets the operator with a stale patch of a file that has since been reverted.
  useEffect(() => {
    if (!open) {
      inFlight.current?.abort();
      setFile(null);
      setCopied(false);
      return;
    }
    void loadStat();
  }, [open, loadStat]);

  function openFile(path: string) {
    setFile(path);
    setCopied(false);
    void loadPatch(path);
  }

  function back() {
    inFlight.current?.abort();
    setFile(null);
    setCopied(false);
    void loadStat();
  }

  function refresh() {
    if (file !== null) void loadPatch(file);
    else void loadStat();
  }

  async function copyPath() {
    if (file === null) return;
    try {
      await navigator.clipboard.writeText(file);
      buzz();
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const ready = stat.phase === "ready" ? stat.data : null;
  const subtitle = ready ? t("diff.subtitle", { branch: ready.branch, root: shortenHome(ready.repoRoot, home) }) : undefined;

  return (
    <RightSheet open={open} onClose={onClose} title={file ?? t("diff.title")} subtitle={file ? undefined : subtitle}>
      <div className="flex h-full flex-col">
        {/* The tool row: back (in a patch), refresh, copy path (in a patch). */}
        <div className="flex shrink-0 items-center gap-1 border-b border-rule px-2 py-1">
          {file !== null && (
            <Button variant="ghost" size="sm" className="h-8 gap-1 px-2" onClick={back}>
              <ChevronLeft className="size-4" />
              {t("diff.back")}
            </Button>
          )}
          <span className="flex-1" />
          {file !== null && (
            <Button variant="ghost" size="sm" className="h-8 gap-1 px-2" onClick={() => void copyPath()}>
              {copied ? <Check className="size-4 text-status-done" /> : <Copy className="size-4" />}
              {copied ? t("diff.copied") : t("diff.copyPath")}
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-8 gap-1 px-2" onClick={refresh} aria-label={t("diff.refresh")}>
            <RefreshCw className="size-4" />
          </Button>
        </div>

        {file === null ? (
          <FileList stat={stat} onOpen={openFile} />
        ) : (
          <Patch patch={patch} fontSize={fontSize} mirrorFace={mirrorFace} />
        )}
      </div>
    </RightSheet>
  );
}

function FileList({ stat, onOpen }: { stat: Loaded<PaneDiffStatResponse>; onOpen: (path: string) => void }) {
  if (stat.phase === "loading") {
    return (
      <p className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t("diff.loading")}
      </p>
    );
  }
  if (stat.phase === "failed") {
    return <p className="px-4 py-6 text-sm text-muted-foreground">{stat.message}</p>;
  }
  const { files, truncated } = stat.data;
  if (files.length === 0) {
    return <p className="px-4 py-6 text-sm text-muted-foreground">{t("diff.empty")}</p>;
  }
  return (
    <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto overscroll-contain">
      {files.map((f) => (
        <FileRow key={f.path} file={f} onOpen={onOpen} />
      ))}
      {truncated && <li className="px-4 py-3 text-xs text-muted-foreground">{t("diff.truncated")}</li>}
    </ul>
  );
}

function FileRow({ file, onOpen }: { file: DiffFileView; onOpen: (path: string) => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(file.path)}
        className="flex min-h-11 w-full items-center gap-3 px-4 py-2 text-left hover:bg-accent active:bg-muted"
      >
        <span className={cn("w-4 shrink-0 text-center font-mono text-sm font-semibold", statusClass(file.status))}>
          {file.status}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-mono text-sm">{file.path}</span>
          {(file.from || file.staged) && (
            <span className="truncate text-xs text-muted-foreground">
              {file.from ? `← ${file.from}` : ""}
              {file.from && file.staged ? " · " : ""}
              {file.staged ? t("diff.staged") : ""}
            </span>
          )}
        </span>
        <span className="shrink-0 font-mono text-xs tabular-nums">
          {file.binary ? (
            <span className="text-muted-foreground">{t("diff.binary")}</span>
          ) : (
            <>
              <span className="text-status-done">+{file.additions}</span>{" "}
              <span className="text-status-blocked">−{file.deletions}</span>
            </>
          )}
        </span>
      </button>
    </li>
  );
}

/** One line of a unified diff, classed by its first character. */
function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-muted-foreground";
  if (line.startsWith("@@")) return "bg-muted text-primary";
  if (line.startsWith("+")) return "bg-status-done/10 text-status-done";
  if (line.startsWith("-")) return "bg-status-blocked/10 text-status-blocked";
  if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file")) {
    return "text-muted-foreground";
  }
  return "";
}

function Patch({
  patch,
  fontSize,
  mirrorFace,
}: {
  patch: Loaded<PaneDiffPatchResponse>;
  fontSize: number;
  mirrorFace: MirrorFont;
}) {
  if (patch.phase === "loading") {
    return (
      <p className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t("diff.loading")}
      </p>
    );
  }
  if (patch.phase === "failed") {
    return <p className="px-4 py-6 text-sm text-muted-foreground">{patch.message}</p>;
  }
  const lines = patch.data.patch.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return (
    <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
      <pre
        data-slot="diff-patch"
        className={cn("min-w-max px-2 py-2 font-mono leading-snug", mirrorFace.className)}
        style={{ fontSize, ...mirrorFace.style }}
      >
        {lines.map((line, i) => (
          <div key={`${i}:${line}`} className={cn("whitespace-pre px-1", lineClass(line))}>
            {line === "" ? " " : line}
          </div>
        ))}
      </pre>
      {patch.data.truncated && <p className="px-4 py-3 text-xs text-muted-foreground">{t("diff.truncated")}</p>}
    </div>
  );
}
