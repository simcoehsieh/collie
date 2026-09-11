import type { ReactNode } from "react";
import { MessageSquarePlus, StickyNote } from "lucide-react";

import { useLongPress } from "@/hooks/use-long-press";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useLocale } from "@/hooks/use-locale";
import { useTurnNote } from "@/hooks/use-notes";
import { t } from "@/lib/i18n";
import type { TranscriptEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

// FORK: the marks and the gesture that anchored notes wear wherever they are taken.
//
// Three pieces, kept together because they are one visual idea: the numbered pin that says "you
// noted this", the reserved slot that keeps a row the same height whether or not there is a pin in
// it (DESIGN.md §2 — a state may repaint, it may not re-lay-out), and the fine-pointer button that
// gives a mouse the gesture a thumb gets by holding.
//
// `TurnNoteHandle` is here rather than in components/transcript-view.tsx because that file is
// upstream's: the hunk there is one optional prop and one wrapper, and everything this feature
// knows lives on this side of it.

/** How much of a turn's prose is quoted into a note. The store clamps to 500; this is the read. */
const TURN_EXCERPT_CHARS = 500;

/**
 * The numbered pin. Small, high-contrast, `tabular-nums` because it is a number that steps
 * (DESIGN.md §5), and dimmed once its note has gone out — a sent note is still an anchor, it is
 * just no longer waiting for anything.
 */
export function NoteBadge({ index, sent, className }: { index: number; sent?: boolean; className?: string }) {
  useLocale();
  return (
    <span
      data-slot="note-badge"
      aria-label={t(sent === true ? "notes.badge.sentAria" : "notes.badge.aria", { index })}
      className={cn(
        "inline-flex h-4 min-w-4 select-none items-center justify-center rounded-full px-1 text-[10px]/none font-semibold tabular-nums",
        sent === true ? "bg-muted text-muted-foreground" : "bg-primary text-primary-foreground",
        className,
      )}
    >
      {index}
    </span>
  );
}

/**
 * The pin's SLOT, reserved whether or not there is a pin.
 *
 * DESIGN.md §2: a badge that appears when a note is taken would push everything after it sideways
 * on the row it lands in, and a diff hunk header is exactly the kind of row a reader is comparing
 * character by character. The slot is the same 16px wide in both states; only the paint changes.
 */
export function NotePinSlot({ index, sent, className }: { index?: number; sent?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex h-4 w-4 shrink-0 items-center justify-center align-middle", className)}>
      {index === undefined ? null : <NoteBadge index={index} sent={sent} />}
    </span>
  );
}

/**
 * The "+ note" button, and it renders NOTHING on a touch device.
 *
 * The gesture on glass is the long press, which a mouse has no equivalent of that is not also a
 * right-click menu — so a fine pointer (a mouse or a trackpad, the same gate hooks/use-hotkeys.ts
 * runs the whole keyboard layer behind) gets a real control instead. On a phone the row stays
 * exactly as wide as it was.
 */
export function AddNoteButton({
  onClick,
  noted,
  className,
}: {
  onClick: () => void;
  /** There is already a note here, so the control edits rather than adds — it says so. */
  noted?: boolean;
  className?: string;
}) {
  useLocale();
  const fine = useMediaQuery("(pointer: fine)");
  if (!fine) return null;
  return (
    <button
      type="button"
      data-slot="add-note"
      onClick={onClick}
      aria-label={t(noted === true ? "notes.edit.aria" : "notes.add.aria")}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-md border border-transparent px-1.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
    >
      <MessageSquarePlus className="size-3" />
      {t(noted === true ? "notes.edit.short" : "notes.add.short")}
    </button>
  );
}

/** The "N notes" chip in a route header — the one way into the list, and the count itself. */
export function NoteCountChip({ count, onClick }: { count: number; onClick: () => void }) {
  useLocale();
  return (
    <button
      type="button"
      data-slot="note-count"
      onClick={onClick}
      aria-label={t("notes.chip.aria", { count })}
      className="flex h-7 shrink-0 items-center gap-1 rounded-full border border-transparent bg-primary/15 px-2 text-xs font-medium text-primary transition-colors active:bg-primary/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <StickyNote className="size-3.5" />
      <span className="tabular-nums">{count}</span>
    </button>
  );
}

/** What a transcript turn hands the note sheet. Kept structural so the store never sees a React node. */
export interface NotedTurn {
  turnId: string;
  role: string;
  excerpt: string;
}

/** The prose of a turn, for the note's excerpt — tool calls and images contribute nothing quotable. */
export function turnExcerpt(entry: TranscriptEntry): string {
  const prose: string[] = [];
  for (const part of entry.parts) {
    if (part.kind === "text" || part.kind === "thinking") prose.push(part.text);
    else if (part.kind === "tool") prose.push(`${part.name}${part.summary ? ` ${part.summary}` : ""}`);
  }
  return prose.join("\n").trim().slice(0, TURN_EXCERPT_CHARS);
}

/**
 * One transcript turn, made notable: hold it (or click "+ note" with a mouse) to open the sheet, and
 * wear a numbered pin once it carries a note.
 *
 * The badge is looked up by the turn's own uuid rather than by pane, which is what keeps the hunk in
 * upstream's `transcript-view.tsx` to one optional callback: a journal entry's uuid is unique across
 * every session on every machine, so no pane address has to be threaded through a component that
 * has no other use for one (`lib/notes.ts` → `noteForTurn`).
 *
 * `select-none` + `-webkit-touch-callout:none` are not decoration: iOS Safari's selection loupe
 * fires `pointercancel` mid-hold and kills the timer, which is the failure `useLongPress` documents
 * and every caller of it has to carry.
 */
export function TurnNoteHandle({
  entry,
  onLongPress,
  children,
}: {
  entry: TranscriptEntry;
  onLongPress: (turn: NotedTurn) => void;
  children: ReactNode;
}) {
  const note = useTurnNote(entry.uuid);
  const open = () => onLongPress({ turnId: entry.uuid, role: entry.role, excerpt: turnExcerpt(entry) });
  const longPress = useLongPress(open);
  return (
    <div
      data-slot="turn-note-handle"
      {...longPress}
      className="relative select-none [-webkit-touch-callout:none]"
    >
      {children}
      {/* Both marks sit in one absolutely-positioned cluster at the turn's top-right corner, so
          nothing in the turn itself moves when a note lands on it — the §2 rule, bought with
          position rather than with a reserved slot because a turn is a block and has a corner. */}
      <span className="absolute right-1 top-1 flex items-center gap-1">
        <AddNoteButton onClick={open} noted={note !== null} className="bg-card/90" />
        {note !== null && <NoteBadge index={note.index} sent={note.sentAt !== undefined} />}
      </span>
    </div>
  );
}
