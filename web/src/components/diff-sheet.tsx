import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, Copy, FileCode, Loader2, RefreshCw } from "lucide-react";

import { AddNoteButton, NotePinSlot } from "@/components/note-badge";
import { NoteSheet } from "@/components/notes-sheet";
import { Button } from "@/components/ui/button";
import { RightSheet } from "@/components/ui/right-sheet";
import type { MirrorFont } from "@/hooks/use-display-prefs";
import { useLocale } from "@/hooks/use-locale";
import { useLongPress } from "@/hooks/use-long-press";
import { useNotes } from "@/hooks/use-notes";
import * as api from "@/lib/api";
import { isApiErrorStatus } from "@/lib/api";
import { buzz } from "@/lib/haptics";
import { t } from "@/lib/i18n";
import { anchorKey, type Note, type NoteAnchor } from "@/lib/notes";
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
  /**
   * FORK: open one file in the viewer rather than its patch (components/file-sheet.tsx).
   *
   * A SECOND affordance on the row, not a replacement for the first: a row's main tap still opens
   * the patch, which is what the sheet is for. This is the escape from "+82 −11 of a file I cannot
   * see the rest of" — and it is the viewer rather than a third view inside this sheet, because the
   * file that most often needs reading is the one with no row here at all.
   */
  onOpenFile?: (path: string) => void;
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

export function DiffSheet({ open, onClose, paneId, scope, fontSize, mirrorFace, home = "", onOpenFile }: DiffSheetProps) {
  useLocale();
  const [stat, setStat] = useState<Loaded<PaneDiffStatResponse>>({ phase: "loading" });
  const [file, setFile] = useState<string | null>(null);
  const [patch, setPatch] = useState<Loaded<PaneDiffPatchResponse>>({ phase: "loading" });
  const [copied, setCopied] = useState(false);
  // FORK: the hunk a note is being written about, or null. The sheet that takes the sentence is
  // mounted below, INSIDE this panel: the panel is the top of the app while it is open, so a note
  // taken here must not have to close the thing it is about first.
  const [noting, setNoting] = useState<NoteAnchor | null>(null);
  const notes = useNotes(scope, paneId);
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
      // The note sheet is a sibling of this panel now, so closing the panel has to take it down —
      // it would otherwise be left standing over the terminal with nothing behind it.
      setNoting(null);
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
    <>
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
          {/* FORK: the same hop the row offers, from inside a patch — the hunk's three lines of
              context is exactly where the question "what does the rest of this say" arrives. */}
          {file !== null && onOpenFile !== undefined && (
            <Button variant="ghost" size="sm" className="h-8 gap-1 px-2" onClick={() => onOpenFile(file)}>
              <FileCode className="size-4" />
              {t("diff.openFile")}
            </Button>
          )}
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
          <FileList stat={stat} onOpen={openFile} onOpenFile={onOpenFile} />
        ) : (
          <Patch patch={patch} fontSize={fontSize} mirrorFace={mirrorFace} notes={notes} onNote={setNoting} />
        )}
      </div>
    </RightSheet>
    {/* FORK: anchored notes. A `BottomSheet`, because `ui/sheet.tsx` is the app's only floating
        layer (DESIGN.md §1) — this is one more thing standing in it, not a new kind of thing.
        Mounted BESIDE the panel rather than inside it: the panel plays a `translateX` entrance, and
        a transform makes its subtree the containing block for anything `position: fixed`, so a
        sheet mounted within it would rise from the panel's bottom edge instead of the viewport's.
        Same z-rung, later in the document, so it paints over the panel it was opened from. */}
    <NoteSheet open={noting !== null} onClose={() => setNoting(null)} paneId={paneId} scope={scope} anchor={noting} />
    </>
  );
}

function FileList({
  stat,
  onOpen,
  onOpenFile,
}: {
  stat: Loaded<PaneDiffStatResponse>;
  onOpen: (path: string) => void;
  onOpenFile?: (path: string) => void;
}) {
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
        <FileRow key={f.path} file={f} onOpen={onOpen} onOpenFile={onOpenFile} />
      ))}
      {truncated && <li className="px-4 py-3 text-xs text-muted-foreground">{t("diff.truncated")}</li>}
    </ul>
  );
}

function FileRow({
  file,
  onOpen,
  onOpenFile,
}: {
  file: DiffFileView;
  onOpen: (path: string) => void;
  onOpenFile?: (path: string) => void;
}) {
  return (
    // FORK: two controls on one row, as SIBLINGS rather than one nested in the other — a button
    // inside a button is not a thing the browser renders, and the row's main tap has to keep meaning
    // "show me the patch", which is what this sheet is for.
    <li className="flex items-stretch">
      <button
        type="button"
        onClick={() => onOpen(file.path)}
        className="flex min-h-11 w-full min-w-0 flex-1 items-center gap-3 px-4 py-2 text-left hover:bg-accent active:bg-muted"
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
      {/* A real 44px box, stated: it is the narrow control on a row whose other control is the whole
          width, so it is the one that has to draw the floor rather than inherit it. A DELETED file
          has nothing left on disk to open, so it gets no button — the sheet hides a control it has
          nothing to point at, the same rule PaneActionsSheet's rows follow. */}
      {onOpenFile !== undefined && file.status !== "D" && (
        <button
          type="button"
          onClick={() => onOpenFile(file.path)}
          aria-label={t("diff.openFileAria", { path: file.path })}
          className="grid size-11 shrink-0 place-items-center self-center text-muted-foreground transition-colors hover:bg-accent active:bg-muted"
        >
          <FileCode className="size-4" />
        </button>
      )}
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

/** One `@@` run of a unified diff: its header row and every line up to the next `@@`. */
interface Hunk {
  header: string;
  body: string[];
}

/** A patch as it is rendered: the preamble git prints, then the hunks a note can be anchored to. */
export interface SplitPatch {
  preamble: string[];
  hunks: Hunk[];
}

/** FORK: a patch split into the preamble git prints and the hunks a note can be anchored to. */
export function splitHunks(lines: readonly string[]): SplitPatch {
  const preamble: string[] = [];
  const hunks: Hunk[] = [];
  for (const line of lines) {
    if (line.startsWith("@@")) {
      hunks.push({ header: line, body: [] });
      continue;
    }
    const current = hunks[hunks.length - 1];
    if (current === undefined) preamble.push(line);
    else current.body.push(line);
  }
  return { preamble, hunks };
}

/**
 * FORK: the NEW side's line range out of a hunk header (`@@ -4,7 +12,9 @@` → `12-20`), or undefined
 * when the header does not carry one.
 *
 * The new side rather than the old one: a note asks for something to CHANGE, and the line the agent
 * will open is the line as it stands now. A count of 0 is a pure deletion and has no new range at
 * all, which is why the caller gets `undefined` rather than a range of length zero.
 */
export function newSideRange(header: string): string | undefined {
  const m = /\+(\d+)(?:,(\d+))?/.exec(header);
  if (!m) return undefined;
  const start = Number(m[1]);
  const count = m[2] === undefined ? 1 : Number(m[2]);
  if (count === 0) return undefined;
  return count === 1 ? `${start}` : `${start}-${start + count - 1}`;
}

function Patch({
  patch,
  fontSize,
  mirrorFace,
  notes,
  onNote,
}: {
  patch: Loaded<PaneDiffPatchResponse>;
  fontSize: number;
  mirrorFace: MirrorFont;
  /** This pane's notes, so a hunk that already carries one wears its number. */
  notes: readonly Note[];
  onNote: (anchor: NoteAnchor) => void;
}) {
  const ready = patch.phase === "ready" ? patch.data : null;
  const split = useMemo(() => {
    if (ready === null) return { preamble: [], hunks: [] };
    const lines = ready.patch.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return splitHunks(lines);
  }, [ready]);

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
  const file = ready?.path ?? "";
  return (
    <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
      <pre
        data-slot="diff-patch"
        className={cn("min-w-max px-2 py-2 font-mono leading-snug", mirrorFace.className)}
        style={{ fontSize, ...mirrorFace.style }}
      >
        {split.preamble.map((line, i) => (
          <div key={`p${i}:${line}`} className={cn("whitespace-pre px-1", lineClass(line))}>
            {line === "" ? " " : line}
          </div>
        ))}
        {split.hunks.map((hunk, i) => (
          <HunkRows key={`h${i}:${hunk.header}`} file={file} hunk={hunk} notes={notes} onNote={onNote} />
        ))}
      </pre>
      {patch.data.truncated && <p className="px-4 py-3 text-xs text-muted-foreground">{t("diff.truncated")}</p>}
    </div>
  );
}

/**
 * FORK: one hunk, and the gesture that notes it.
 *
 * The header row is the anchor because it is the one row in a hunk that is not code — noting a `+`
 * line would mean deciding which of two files it belongs to, and the hunk is the unit an agent acts
 * on anyway. Hold it on glass; a fine pointer gets `AddNoteButton` instead (it renders nothing on a
 * touch device, so the row is not a pixel wider on a phone).
 *
 * `NotePinSlot` is always there and always 16px, painted only when this hunk carries a note. That is
 * DESIGN.md §2 in the place it matters most: a badge that ARRIVED would push the `@@ … @@` text
 * sideways on the row the reader is using to locate themselves in the file.
 */
function HunkRows({
  file,
  hunk,
  notes,
  onNote,
}: {
  file: string;
  hunk: Hunk;
  notes: readonly Note[];
  onNote: (anchor: NoteAnchor) => void;
}) {
  const lineRange = newSideRange(hunk.header);
  const excerpt = [hunk.header, ...hunk.body].join("\n");
  const anchor: NoteAnchor =
    lineRange === undefined
      ? { kind: "diff", file, hunkHeader: hunk.header, excerpt }
      : { kind: "diff", file, hunkHeader: hunk.header, lineRange, excerpt };
  const wanted = anchorKey(anchor);
  const note = notes.find((n) => anchorKey(n.anchor) === wanted);
  const open = () => onNote(anchor);
  const longPress = useLongPress(open);

  return (
    <>
      <div
        data-slot="diff-hunk"
        {...longPress}
        className={cn(
          // select-none + -webkit-touch-callout:none stop iOS Safari's selection loupe, whose native
          // long-press fires pointercancel and kills the hold timer (hooks/use-long-press.ts).
          "flex select-none items-center gap-1.5 whitespace-pre px-1 [-webkit-touch-callout:none]",
          lineClass(hunk.header),
        )}
      >
        <NotePinSlot index={note?.index} sent={note?.sentAt !== undefined} />
        <span className="whitespace-pre">{hunk.header}</span>
        <AddNoteButton onClick={open} noted={note !== undefined} />
      </div>
      {hunk.body.map((line, i) => (
        <div key={`${i}:${line}`} className={cn("whitespace-pre px-1", lineClass(line))}>
          {line === "" ? " " : line}
        </div>
      ))}
    </>
  );
}
