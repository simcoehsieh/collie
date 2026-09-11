import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NoteSheet, NotesSheet } from "./notes-sheet";
import { __resetNotes, addNote, markNotesSent, notesForPane, type NoteAnchor } from "@/lib/notes";
import { __resetSendQueue, queuedForPane } from "@/lib/send-queue";

// The two sheets a note is made and spent through: what the capture surface shows and stores, and
// what the list says about a pane that has notes waiting.

const PANE = "w1:p1";

const HUNK: NoteAnchor = {
  kind: "diff",
  file: "web/src/a.ts",
  hunkHeader: "@@ -1,2 +1,3 @@",
  lineRange: "1-3",
  excerpt: "-one\n+two",
};

beforeEach(() => {
  __resetNotes();
  // The queue's drain is wired to the health store, which the suite re-anchors before every case —
  // so a row left here would be delivered by a timer mid-test rather than sitting where it was put.
  __resetSendQueue();
});

describe("NoteSheet", () => {
  it("shows the excerpt it is about and stores the sentence with its intent", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<NoteSheet open onClose={onClose} paneId={PANE} anchor={HUNK} />);

    expect(screen.getByText(/-one/)).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Add a note" })).toBeInTheDocument();
    // Nothing is storable until there is something to say.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await user.type(screen.getByRole("textbox"), "this is 4px too low");
    await user.click(screen.getByRole("button", { name: "Bug" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    const rows = notesForPane(undefined, PANE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.comment).toBe("this is 4px too low");
    expect(rows[0]?.intent).toBe("bug");
    expect(onClose).toHaveBeenCalled();
  });

  it("opens on an anchor that already carries a note as an EDIT, seeded with its words", async () => {
    addNote({ paneId: PANE, anchor: HUNK, comment: "said it once", intent: "change" });
    render(<NoteSheet open onClose={vi.fn()} paneId={PANE} anchor={HUNK} />);

    expect(screen.getByRole("dialog", { name: "Edit the note" })).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("said it once");
    expect(screen.getByRole("button", { name: "Change" })).toHaveAttribute("aria-pressed", "true");
    // And a way out that is not a second note on the same pointer.
    expect(screen.getByRole("button", { name: "Delete note" })).toBeInTheDocument();
  });

  it("says why a framed document has no excerpt instead of showing an empty box", () => {
    render(
      <NoteSheet
        open
        onClose={vi.fn()}
        paneId={PANE}
        anchor={{ kind: "doc", slug: "meow-notes", title: "Meow notes" }}
      />,
    );
    expect(screen.getByText(/framed sandboxed/i)).toBeInTheDocument();
  });

  it("renders nothing at all with no anchor", () => {
    const { container } = render(<NoteSheet open onClose={vi.fn()} paneId={PANE} anchor={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("NotesSheet", () => {
  it("lists the pane's notes with their numbers and offers to send what is waiting", async () => {
    addNote({ paneId: PANE, anchor: HUNK, comment: "too low" });
    addNote({
      paneId: PANE,
      anchor: { kind: "transcript", turnId: "uuid-7", role: "assistant", excerpt: "I removed the guard." },
      comment: "why?",
    });
    render(<NotesSheet open onClose={vi.fn()} paneId={PANE} title="meow › api" agent="claude" />);

    expect(screen.getByRole("dialog", { name: "2 notes" })).toBeInTheDocument();
    expect(screen.getByLabelText("Note 1")).toHaveTextContent("1");
    expect(screen.getByLabelText("Note 2")).toHaveTextContent("2");
    expect(screen.getByText("too low")).toBeInTheDocument();
    expect(screen.getByText("diff a.ts")).toBeInTheDocument();
    expect(screen.getByText("turn uuid-7")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Send 2 notes/ })).toBeEnabled();
  });

  it("dims a sent note, keeps it, and offers to clear only those", async () => {
    const user = userEvent.setup();
    const note = addNote({ paneId: PANE, anchor: HUNK, comment: "already asked" });
    markNotesSent([note.id]);
    render(<NotesSheet open onClose={vi.fn()} paneId={PANE} title="pane" agent="claude" />);

    expect(screen.getByText("sent")).toBeInTheDocument();
    // Nothing is waiting, so there is nothing to send.
    expect(screen.getByRole("button", { name: /Send 0 notes/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Clear sent" }));
    await waitFor(() => expect(notesForPane(undefined, PANE)).toHaveLength(0));
  });

  it("explains an empty list rather than showing a blank sheet", () => {
    render(<NotesSheet open onClose={vi.fn()} paneId={PANE} title="pane" agent="claude" />);
    expect(screen.getByText(/Nothing noted yet/)).toBeInTheDocument();
  });

  it("hands a working pane's send to the queue instead of typing over the agent", async () => {
    const user = userEvent.setup();
    addNote({ paneId: PANE, anchor: HUNK, comment: "too low" });
    render(<NotesSheet open onClose={vi.fn()} paneId={PANE} title="pane" agent="claude" status="working" />);

    await user.click(screen.getByRole("button", { name: /Send 1 note/ }));
    // Read at once, not through `waitFor`: the row is enqueued synchronously on the tap, and the
    // drain's own 250 ms timer would have carried it away by the time a poll-and-retry gave up.
    expect(queuedForPane(undefined, PANE)).toHaveLength(1);
    expect(queuedForPane(undefined, PANE)[0]?.text).toContain("## Feedback: pane");
    // The notes are spent — the queue owns the words now.
    expect(notesForPane(undefined, PANE)[0]?.sentAt).toBeGreaterThan(0);
  });
});
