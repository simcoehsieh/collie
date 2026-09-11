import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpToLine,
  ArrowRightLeft,
  Brain,
  FileText,
  Globe,
  Loader2,
  MessageCircleQuestionMark,
  Pencil,
  Search,
  Terminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";

import { TodoCard } from "@/components/todo-card";
import { TranscriptView } from "@/components/transcript-view";
import { usePaneTranscript } from "@/hooks/use-pane-transcript";
import { useLocale } from "@/hooks/use-locale";
import { fetchPaneDiff } from "@/lib/api";
import { awayFacts, factsAreEmpty, isAway, type AwayFacts } from "@/lib/away";
import { timeAgoShort } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { Scope } from "@/lib/scope";
import type { ToolKind } from "@/lib/tool-kind";
import type { TodoItem, TranscriptEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

// FORK — CHAT MODE: the pane, read as the conversation it is.
//
// The terminal mirror is a faithful 51-row photograph of a TUI, and for an agent pane that is the
// wrong unit almost all of the time: the thing you came to read is the last message, the thing you
// need in order to act is the plan, and both of them are usually off the top of the viewport (an
// agent's TUI runs on the alternate screen, which keeps no scrollback ring at all). The journal has
// the whole thread; this renders it in place of the mirror, in the SAME slot the latest-reply card
// already occupied, with the mirror one tap away in the segmented control above the composer.
//
// IT IS NOT A REPLACEMENT FOR THE MIRROR AND MUST NOT BECOME ONE (ADR 0008 — Collie runs no terminal
// emulator). Three things keep that honest:
//
//  • A dialog OWNS the keyboard, so the mirror takes the screen back automatically whenever one is
//    up — the parent forces it, because answering a prompt means seeing the prompt (agent-chat.tsx).
//  • Find searches the mirror, so opening find forces the mirror too.
//  • A STREAMING turn is invisible here, because the harness has not flushed its JSONL yet. Rather
//    than pretend otherwise, a working pane carries one line saying the live view is in Terminal.
//    That sentence is the honest version of a limitation, not a feature request.
//
// RENDER WINDOWING is `routes/history.tsx`'s, in miniature and for the same measured reason: the
// whole page is in memory but 1425 turns is ~17k DOM nodes, so a window of the newest turns is what
// paints and "load older" grows it — first out of memory, then over the network.

/** Turns rendered on open. Smaller than the history route's 60: this scroller shares its viewport
 *  with the composer and the chrome block, and the pane opens at the recent end regardless. */
const INITIAL_RENDER = 30;

/** Turns revealed per tap once more are held than shown. */
const RENDER_STEP = 60;

/** The pinned plan card: the newest `todo` part anywhere in the window, or null. */
export function latestTodo(entries: readonly TranscriptEntry[]): TodoItem[] | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const parts = entries[i]?.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j];
      if (part?.kind === "todo") return part.items.length > 0 ? part.items : null;
    }
  }
  return null;
}

const KIND_ICON = {
  read: FileText,
  edit: Pencil,
  delete: Trash2,
  move: ArrowRightLeft,
  search: Search,
  execute: Terminal,
  think: Brain,
  fetch: Globe,
  other: Wrench,
} satisfies Record<ToolKind, typeof Wrench>;

/** The work mix, as icons and counts. Three kinds at most — a row of nine glyphs is a chart. */
function ToolMixRow({ facts }: { facts: AwayFacts }) {
  const shown = facts.tools.slice(0, 3);
  if (shown.length === 0) return null;
  return (
    <div className="flex items-center gap-2.5">
      {shown.map(({ kind, count }) => {
        const Icon = KIND_ICON[kind];
        return (
          <span
            key={kind}
            className="flex items-center gap-1 text-xs text-muted-foreground"
            aria-label={`${count} ${t(`chat.away.toolKind.${kind}`)}`}
          >
            <Icon className="size-3.5 shrink-0" aria-hidden />
            <span className="tabular-nums">{count}</span>
          </span>
        );
      })}
    </div>
  );
}

/** What the work tree looks like now — the SAME `GET /api/pane/:id/diff` the Changes sheet asks. */
interface DiffSummary {
  files: number;
  additions: number;
  deletions: number;
}

/**
 * The rollup card, first thing in the thread, after an absence.
 *
 * Fetches the diff stat ONCE, when it mounts — the card only exists after an hour away, so this is
 * not a cadence, and a failed read simply drops that one line rather than the card.
 */
function AwayCard({
  facts,
  paneId,
  scope,
  now,
  onDismiss,
}: {
  facts: AwayFacts;
  paneId: string;
  scope?: Scope;
  now: number;
  onDismiss: () => void;
}) {
  const [diff, setDiff] = useState<DiffSummary | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    let live = true;
    void (async () => {
      try {
        const res = await fetchPaneDiff(paneId, { mode: "stat" }, scope, abort.signal);
        if (!live || res.mode !== "stat") return;
        const files = res.files.length;
        if (files === 0) return;
        setDiff({
          files,
          additions: res.files.reduce((n, f) => n + f.additions, 0),
          deletions: res.files.reduce((n, f) => n + f.deletions, 0),
        });
      } catch {
        // Not a repo, no git, a refusal — the card is one line shorter and says nothing about it.
      }
    })();
    return () => {
      live = false;
      abort.abort();
    };
  }, [paneId, scope]);

  return (
    <div
      data-slot="away-card"
      className="mb-3 rounded-lg border border-dashed bg-muted/30 px-3 py-2.5"
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {t("chat.away.title")}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("chat.away.dismiss")}
          className="-mr-1 ml-auto flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors active:bg-muted/60"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-xs text-muted-foreground">
          {t("chat.away.turns", { n: String(facts.agentTurns) })}
        </span>
        {facts.userTurns > 0 && (
          <span className="text-xs text-muted-foreground">
            {t("chat.away.userTurns", { n: String(facts.userTurns) })}
          </span>
        )}
        <ToolMixRow facts={facts} />
        {diff !== null && (
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {t("chat.away.diff", {
              files: String(diff.files),
              added: String(diff.additions),
              removed: String(diff.deletions),
            })}
          </span>
        )}
      </div>
      {facts.lastQuestionAt !== null && (
        <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <MessageCircleQuestionMark className="size-3.5 shrink-0" aria-hidden />
          {t("chat.away.question", { age: timeAgoShort(facts.lastQuestionAt, now) })}
        </p>
      )}
    </div>
  );
}

/**
 * The pane's thread — the default view of an agent pane.
 *
 * `mirrorText` is passed in and read for ONE thing: its stillness is what triggers a re-read of the
 * journal (hooks/use-pane-transcript.ts). Nothing here renders it.
 */
export function PaneTranscript({
  paneId,
  scope,
  agent,
  working,
  mirrorText,
  lastSeenAt,
  onShowTerminal,
}: {
  paneId: string;
  scope?: Scope;
  /** The pane's agent name, for the per-turn brand icon. */
  agent?: string;
  /** Is the pane still moving — drives both the live hint and the tool cards' `in_progress`. */
  working: boolean;
  /** The mirror as displayed. Its STILLNESS is the fetch trigger; its content is not read. */
  mirrorText: string;
  /** The shared seen watermark (.adr/0003) — what "while you were away" is measured from. */
  lastSeenAt?: number;
  /** Hand the screen to the mirror. The transcript must never be a view you can get stuck in. */
  onShowTerminal: () => void;
}) {
  useLocale();
  const { entries, hasMore, loading, loadOlder, ready, unavailable } = usePaneTranscript({
    paneId,
    scope,
    enabled: true,
    mirrorText,
  });

  const [renderCount, setRenderCount] = useState(INITIAL_RENDER);
  // A different pane starts its window again — this component is not keyed by pane, the route is.
  useEffect(() => setRenderCount(INITIAL_RENDER), [paneId]);
  const shown = useMemo(
    () => (renderCount >= entries.length ? entries : entries.slice(entries.length - renderCount)),
    [entries, renderCount],
  );
  const allRendered = renderCount >= entries.length;

  const grow = () => {
    if (!allRendered) {
      setRenderCount((c) => Math.min(c + RENDER_STEP, entries.length));
      return;
    }
    if (hasMore) loadOlder();
  };

  // The plan, pinned. Read off everything HELD rather than everything shown: the newest plan is at
  // the recent end, which the window always includes, so this is the same answer either way — and it
  // stays the same answer if the window ever grows away from the tail.
  const todo = latestTodo(entries);

  // ── THE ROLLUP, COMPUTED ONCE PER OPEN ────────────────────────────────────────
  // `now` is frozen at mount on purpose: the card is a statement about the moment you arrived, and a
  // ticking "2h ago" on a card whose whole subject is the past would re-render the thread every
  // minute to say something nobody is reading.
  const [now] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState(false);
  // Reopening a pane you have now seen should not show the card again, so a dismissal is per-open —
  // exactly like the window above, and reset by the same pane change.
  useEffect(() => setDismissed(false), [paneId]);
  const away = isAway(lastSeenAt, now);
  const facts = useMemo(
    () => (away && !dismissed ? awayFacts(entries, lastSeenAt ?? 0) : null),
    [away, dismissed, entries, lastSeenAt],
  );
  const showAway = facts !== null && !factsAreEmpty(facts);

  if (ready && (unavailable || entries.length === 0)) {
    return (
      <div className="py-12 text-center text-sm leading-relaxed text-muted-foreground">
        {t("chat.transcript.empty")}
        <div className="mt-2">
          <button
            type="button"
            onClick={onShowTerminal}
            className="rounded-md px-2 py-1 text-xs font-medium underline underline-offset-2 transition-colors active:bg-muted/50"
          >
            {t("chat.transcript.showTerminal")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div data-slot="pane-transcript">
      {(!allRendered || hasMore) && (
        <button
          type="button"
          onClick={grow}
          disabled={loading}
          className="mb-3 flex w-full items-center justify-center gap-1.5 rounded-md py-2 text-xs font-medium text-muted-foreground transition-colors active:bg-muted/50 disabled:opacity-60"
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <ArrowUpToLine className="size-3.5" />
          )}
          {loading ? t("history.loading") : t("history.loadOlder")}
        </button>
      )}
      {showAway && (
        <AwayCard
          facts={facts}
          paneId={paneId}
          scope={scope}
          now={now}
          onDismiss={() => setDismissed(true)}
        />
      )}
      {/* The plan, above the thread and out of its flow — it is the state of the job, not a turn. */}
      {todo !== null && <TodoCard items={todo} pinned className="mb-3" />}
      <TranscriptView entries={shown} agent={agent} scope={scope} working={working} />
      {/* ── THE WAY ACROSS, AND THE LIMIT IT ADMITS ────────────────────────────
          A turn that is still streaming has not been written to the harness's JSONL yet, so it
          cannot be here — and a thread that simply stops while the agent is plainly busy reads as a
          bug. That is the `working` copy.

          It is drawn AT REST TOO, and that is not decoration: the segmented control lives in the
          composer's Controls row, which this fork folds away by default, so without this the mirror
          would be two taps rather than one. Here it costs no chrome — it is the last thing in a
          bottom-pinned scroller, so it sits just above the composer without being a persistent row
          of its own (upstream #186). */}
      <button
        type="button"
        onClick={onShowTerminal}
        className={cn(
          "mt-2 flex w-full items-center justify-center gap-1.5 rounded-md py-2",
          "text-xs font-medium text-muted-foreground transition-colors active:bg-muted/50",
        )}
      >
        {working ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <Terminal className="size-3.5" aria-hidden />
        )}
        {working ? t("chat.transcript.liveInTerminal") : t("chat.transcript.showTerminal")}
      </button>
    </div>
  );
}
