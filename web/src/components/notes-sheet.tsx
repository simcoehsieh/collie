import { useEffect, useRef, useState } from "react";
import { Loader2, Send, Trash2 } from "lucide-react";

import { NoteBadge } from "@/components/note-badge";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { useNoteAt, useNotes } from "@/hooks/use-notes";
import { t, tn, type MessageKey } from "@/lib/i18n";
import {
  addNote,
  anchorExcerpt,
  anchorTarget,
  buildNotesPrompt,
  clearNotes,
  clearSentNotes,
  deleteNote,
  markNotesSent,
  updateNote,
  NOTE_COMMENT_MAX,
  type Note,
  type NoteAnchor,
  type NoteIntent,
} from "@/lib/notes";
import { sendGuardedReply } from "@/lib/reply-action";
import { paneScopeKey, type Scope } from "@/lib/scope";
import { enqueueSend } from "@/lib/send-queue";
import { setStatus } from "@/lib/status";
import type { AgentStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

// FORK: the two sheets anchored notes are made and spent through.
//
// `NoteSheet` is the capture surface every entry gesture opens: the excerpt it is about, a field for
// the sentence, three intent chips, Save. `NotesSheet` is the pane's whole list — edit, delete, mark
// sent, and the one button that turns the lot into a single prompt.
//
// ── WHY THE SEND GOES THROUGH `sendGuardedReply` AND NOT THE COMPOSER ───────────────────────────
// The list can be opened from three screens (the pane, the diff panel over it, the history route),
// and only one of those has a composer. So the send takes the same path `lib/send-queue.ts`'s drain
// takes — the guarded reply, which types, verifies the text reached the input box, and only then
// sends the submit key (ADR 0010 covers the long ones through the paste placeholder). What it does
// NOT get is the composer's pre-clear sweep of a draft stranded on the terminal's own "❯" line;
// that is the same trade the queue's drain already makes, and the guard still refuses to submit
// anything it cannot see.
//
// ── A SENT NOTE IS DIMMED, NEVER DELETED ────────────────────────────────────────────────────────
// The operator asked the agent for something; the note is the record of what was asked. Deleting it
// on send would throw away the only thing that says so, and the second send of a re-worded note is a
// normal thing to do. "Clear sent" is the tidy-up, and it is theirs to tap.

const INTENTS: readonly NoteIntent[] = ["bug", "change", "question"];

const INTENT_LABEL = {
  bug: "notes.intent.bug",
  change: "notes.intent.change",
  question: "notes.intent.question",
} satisfies Record<NoteIntent, MessageKey>;

const KIND_LABEL = {
  diff: "notes.kind.diff",
  transcript: "notes.kind.transcript",
  doc: "notes.kind.doc",
  element: "notes.kind.element",
  artifact: "notes.kind.artifact",
} satisfies Record<NoteAnchor["kind"], MessageKey>;

/** "#2 · turn 1a2b3c" — what a chip and a list row say about where a note points. */
export function noteChipLabel(note: Note): string {
  return `${t(KIND_LABEL[note.anchor.kind])} ${anchorTarget(note.anchor)}`;
}

interface NoteSheetProps {
  open: boolean;
  onClose: () => void;
  paneId: string;
  scope?: Scope;
  /** What this note points at. Null while nothing is being noted — the sheet then renders closed. */
  anchor: NoteAnchor | null;
}

/**
 * Write (or re-write) the note on one anchor.
 *
 * Re-opening on an anchor that already carries a note EDITS it rather than adding a second: two
 * notes on one pointer produce a prompt that asks the same question twice, which is what makes an
 * agent hedge (Bolt's stacking rule — the store enforces it, this just shows the words already
 * there so the operator can see they are editing).
 */
export function NoteSheet({ open, onClose, paneId, scope, anchor }: NoteSheetProps) {
  useLocale();
  const existing = useNoteAt(scope, paneId, open ? anchor : null);
  const [comment, setComment] = useState("");
  const [intent, setIntent] = useState<NoteIntent | undefined>(undefined);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  // Seed from whatever is already on this anchor, once per opening. Keyed on `open` alone: a store
  // change while the sheet is up is the operator's own typing and must not be written back over.
  useEffect(() => {
    if (!open) return;
    setComment(existing?.comment ?? "");
    setIntent(existing?.intent);
    fieldRef.current?.focus();
    // The seed is a fact about the MOMENT THE SHEET OPENED; re-running it on every keystroke-driven
    // store change would fight the field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function save() {
    if (anchor === null) return;
    const text = comment.trim();
    if (text === "") return;
    addNote(intent === undefined ? { paneId, scope, anchor, comment: text } : { paneId, scope, anchor, comment: text, intent });
    onClose();
  }

  const excerpt = anchor === null ? "" : anchorExcerpt(anchor);
  const target = anchor === null ? "" : anchorTarget(anchor);
  const kind = anchor === null ? null : t(KIND_LABEL[anchor.kind]);

  return (
    <BottomSheet open={open && anchor !== null} onClose={onClose} title={t(existing === null ? "notes.sheet.add" : "notes.sheet.edit")}>
      <div data-slot="note-sheet" className="flex flex-col gap-3">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {kind !== null && <span className="font-medium text-foreground">{kind}</span>}
          <span className="min-w-0 truncate font-mono">{target}</span>
        </p>
        {/* The quoted anchor, verbatim and unwrapped: it is the machine's own text, so it wears the
            mono face and never the app's (DESIGN.md §5). A document anchor has no excerpt — the
            panel frames it sandboxed, so the parent cannot read a selection out of it — and says so
            in words rather than showing an empty box. */}
        {excerpt === "" ? (
          <p className="rounded-lg bg-muted/50 px-3 py-2 text-xs leading-snug text-muted-foreground">
            {t("notes.excerpt.none")}
          </p>
        ) : (
          <pre className="max-h-32 overflow-auto overscroll-contain rounded-lg bg-muted/50 px-3 py-2 font-mono text-[11px] leading-snug whitespace-pre-wrap">
            {excerpt}
          </pre>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{t("notes.comment.label")}</span>
          <textarea
            ref={fieldRef}
            value={comment}
            onChange={(e) => setComment(e.target.value.slice(0, NOTE_COMMENT_MAX))}
            rows={3}
            placeholder={t("notes.comment.placeholder")}
            className="min-h-20 rounded-lg border border-border bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
        </label>
        <div role="group" aria-label={t("notes.intent.label")} className="flex gap-1.5">
          {INTENTS.map((value) => (
            <Button
              key={value}
              size="sm"
              variant={intent === value ? "default" : "outline"}
              className="flex-1"
              aria-pressed={intent === value}
              onClick={() => setIntent(intent === value ? undefined : value)}
            >
              {t(INTENT_LABEL[value])}
            </Button>
          ))}
        </div>
        <div className="flex gap-2">
          {existing !== null && (
            <Button
              variant="ghost"
              className="h-11 text-muted-foreground"
              onClick={() => {
                deleteNote(existing.id);
                onClose();
              }}
              aria-label={t("notes.delete")}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
          <Button className="h-11 flex-1" disabled={comment.trim() === ""} onClick={save}>
            {t("notes.save")}
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}

interface NotesSheetProps {
  open: boolean;
  onClose: () => void;
  paneId: string;
  scope?: Scope;
  /** What the notes are about — the pane's own name, in the prompt's `## Feedback:` heading. */
  title: string;
  /** The pane's agent, which picks the adapter the guarded send verifies through. */
  agent: string | undefined | null;
  /** The pane's status. `working` sends through the queue instead of typing over a running agent. */
  status?: AgentStatus;
}

/** The pane's notes: what is waiting, what has gone, and the one button that spends them. */
export function NotesSheet({ open, onClose, paneId, scope, title, agent, status }: NotesSheetProps) {
  useLocale();
  const notes = useNotes(scope, paneId);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const pending = notes.filter((n) => n.sentAt === undefined);
  const sent = notes.filter((n) => n.sentAt !== undefined);

  async function sendAll() {
    if (pending.length === 0 || busy) return;
    const ids = pending.map((n) => n.id);
    const text = buildNotesPrompt(pending, { title });
    setBusy(true);
    try {
      // A working pane gets the queue rather than a guarded send: the agent owns its own input box
      // while it is running, and the queue is this app's existing answer for a send that should not
      // go this instant. It drains on the next poll that proves the link live, and the row is
      // visible above the composer with Send now / Discard until it does.
      if (status === "working") {
        const kept = enqueueSend({ paneId, scope, text, kind: "message", agent: agent ?? null, status });
        if (kept !== null) {
          markNotesSent(ids);
          setStatus(t("queue.queued"), "warn");
          onClose();
          return;
        }
        // Too large for the queue's per-item bound: fall through and try to send it now rather than
        // silently dropping the operator's work.
      }
      const res = await sendGuardedReply({ paneId, text, agent, scope });
      if (res.status === "sent") {
        markNotesSent(ids);
        setStatus(t("notes.status.sent"), "success");
        onClose();
        return;
      }
      // The LINK failed and nothing was typed, so the words are still good and only the moment was
      // wrong — the same verdict lib/send-queue.ts is built around.
      if (res.status === "error" && res.transport !== undefined && res.textDelivered !== true) {
        const kept = enqueueSend({ paneId, scope, text, kind: "message", agent: agent ?? null, status });
        if (kept !== null) {
          markNotesSent(ids);
          setStatus(t("queue.queued"), "warn");
          onClose();
          return;
        }
      }
      setStatus(res.error, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={tn("notes.title", notes.length)}>
      <div data-slot="notes-sheet" className="flex flex-col gap-3">
        {notes.length === 0 ? (
          <p className="py-2 text-sm leading-snug text-muted-foreground">{t("notes.empty")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {notes.map((note) => (
              <NoteRow
                key={note.id}
                note={note}
                editing={editing === note.id}
                onToggleEdit={() => setEditing(editing === note.id ? null : note.id)}
              />
            ))}
          </ul>
        )}
        <Button className="h-11" disabled={pending.length === 0 || busy} onClick={() => void sendAll()}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          {tn("notes.send", pending.length)}
        </Button>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="flex-1 text-muted-foreground"
            disabled={sent.length === 0}
            onClick={() => clearSentNotes(paneScopeKey(scope, paneId))}
          >
            {t("notes.clearSent")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="flex-1 text-muted-foreground"
            disabled={notes.length === 0}
            onClick={() => {
              clearNotes(paneScopeKey(scope, paneId));
              onClose();
            }}
          >
            {t("notes.clearAll")}
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}

/** One row: the pin, where it points, what it says — and, tapped, the field that re-words it. */
function NoteRow({ note, editing, onToggleEdit }: { note: Note; editing: boolean; onToggleEdit: () => void }) {
  useLocale();
  const [draft, setDraft] = useState(note.comment);
  const gone = note.sentAt !== undefined;
  useEffect(() => {
    if (editing) setDraft(note.comment);
  }, [editing, note.comment]);

  return (
    <li className={cn("flex flex-col gap-1 py-2", gone && "opacity-55")}>
      <div className="flex items-start gap-2">
        <NoteBadge index={note.index} sent={gone} className="mt-0.5" />
        <button type="button" onClick={onToggleEdit} className="min-w-0 flex-1 text-left">
          <span className="block truncate text-xs text-muted-foreground">{noteChipLabel(note)}</span>
          <span className="block whitespace-pre-wrap break-words text-sm">{note.comment}</span>
        </button>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 px-2 text-muted-foreground"
          onClick={() => deleteNote(note.id)}
          aria-label={t("notes.delete")}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
      {gone && <span className="pl-6 text-[11px] font-medium text-muted-foreground">{t("notes.sentLabel")}</span>}
      {editing && (
        <div className="flex flex-col gap-2 pl-6">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value.slice(0, NOTE_COMMENT_MAX))}
            rows={3}
            className="min-h-16 rounded-lg border border-border bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              onClick={() => {
                // Marking sent by hand is the answer for a note the operator dealt with in the
                // terminal: it leaves the record and takes the note out of the next send.
                markNotesSent([note.id]);
                onToggleEdit();
              }}
              disabled={gone}
            >
              {t("notes.markSent")}
            </Button>
            <Button
              size="sm"
              className="flex-1"
              disabled={draft.trim() === ""}
              onClick={() => {
                updateNote(note.id, { comment: draft.trim() });
                onToggleEdit();
              }}
            >
              {t("notes.save")}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
