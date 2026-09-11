import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetNotes,
  addNote,
  anchorKey,
  buildNotesPrompt,
  clearNotes,
  clearSentNotes,
  deleteNote,
  fenceFor,
  markNotesSent,
  noteForTurn,
  notesForPane,
  NOTES_MAX_PER_PANE,
  NOTES_STORAGE_KEY,
  NOTE_COMMENT_MAX,
  NOTE_EXCERPT_MAX,
  pruneNotesForScope,
  updateNote,
  type Note,
  type NoteAnchor,
} from "./notes";
import { paneScopeKey } from "./scope";

// The note store's four promises: the caps hold, re-noting one anchor updates that note rather than
// stacking a second, what was kept comes back after a reload, and a note outlives everything except
// the pane it points at. Plus the prompt, whose fence is the bug the builder exists to avoid.

const PANE = "w1:p1";
const KEY = paneScopeKey(undefined, PANE);

function diffAnchor(file = "src/a.ts", header = "@@ -1,2 +1,3 @@", excerpt = "+one"): NoteAnchor {
  return { kind: "diff", file, hunkHeader: header, lineRange: "1-3", excerpt };
}

beforeEach(() => __resetNotes());

describe("the caps", () => {
  it("clamps a comment to Orca's 2000 and marks the cut", () => {
    const note = addNote({ paneId: PANE, anchor: diffAnchor(), comment: "x".repeat(NOTE_COMMENT_MAX + 500) });
    expect(note.comment).toHaveLength(NOTE_COMMENT_MAX);
    expect(note.comment.endsWith("…")).toBe(true);
  });

  it("clamps an excerpt to 500, whichever anchor carries it", () => {
    const long = "y".repeat(NOTE_EXCERPT_MAX + 200);
    const diff = addNote({ paneId: PANE, anchor: diffAnchor("a.ts", "@@ -1 +1 @@", long), comment: "look" });
    expect(diff.anchor.kind === "diff" && diff.anchor.excerpt).toHaveLength(NOTE_EXCERPT_MAX);
    const turn = addNote({
      paneId: PANE,
      anchor: { kind: "transcript", turnId: "u-1", role: "assistant", excerpt: long },
      comment: "and this",
    });
    expect(turn.anchor.kind === "transcript" && turn.anchor.excerpt).toHaveLength(NOTE_EXCERPT_MAX);
  });

  it("keeps twenty per pane, drops the oldest, and renumbers 1…N with no holes", () => {
    for (let i = 0; i < NOTES_MAX_PER_PANE + 3; i++) {
      addNote({ paneId: PANE, anchor: diffAnchor("a.ts", `@@ -${i} +${i} @@`), comment: `note ${i}` });
    }
    const rows = notesForPane(undefined, PANE);
    expect(rows).toHaveLength(NOTES_MAX_PER_PANE);
    expect(rows[0]?.comment).toBe("note 3"); // 0, 1 and 2 went
    expect(rows.map((n) => n.index)).toEqual(rows.map((_n, i) => i + 1));
  });

  it("renumbers after a delete, so no badge names a number nobody can count", () => {
    const a = addNote({ paneId: PANE, anchor: diffAnchor("a.ts", "@@ -1 +1 @@"), comment: "one" });
    addNote({ paneId: PANE, anchor: diffAnchor("b.ts", "@@ -2 +2 @@"), comment: "two" });
    addNote({ paneId: PANE, anchor: diffAnchor("c.ts", "@@ -3 +3 @@"), comment: "three" });
    deleteNote(a.id);
    expect(notesForPane(undefined, PANE).map((n) => [n.index, n.comment])).toEqual([
      [1, "two"],
      [2, "three"],
    ]);
  });
});

describe("the stacking rule", () => {
  it("re-noting the same anchor updates that note in place", () => {
    const first = addNote({ paneId: PANE, anchor: diffAnchor(), comment: "too low", intent: "bug" });
    const second = addNote({ paneId: PANE, anchor: diffAnchor(), comment: "actually, too high", intent: "change" });
    expect(second.id).toBe(first.id);
    expect(second.index).toBe(first.index);
    expect(second.createdAt).toBe(first.createdAt);
    expect(notesForPane(undefined, PANE)).toHaveLength(1);
    expect(second.comment).toBe("actually, too high");
    expect(second.intent).toBe("change");
  });

  it("a different anchor on the same file is a different note", () => {
    addNote({ paneId: PANE, anchor: diffAnchor("a.ts", "@@ -1 +1 @@"), comment: "one" });
    addNote({ paneId: PANE, anchor: diffAnchor("a.ts", "@@ -9 +9 @@"), comment: "two" });
    expect(notesForPane(undefined, PANE)).toHaveLength(2);
  });

  it("re-wording a sent note un-sends it, because what went out is no longer what it says", () => {
    const note = addNote({ paneId: PANE, anchor: diffAnchor(), comment: "one" });
    markNotesSent([note.id]);
    expect(notesForPane(undefined, PANE)[0]?.sentAt).toBeGreaterThan(0);
    updateNote(note.id, { comment: "one, but clearer" });
    expect(notesForPane(undefined, PANE)[0]?.sentAt).toBeUndefined();
    // And so does a second note on the same anchor.
    markNotesSent([note.id]);
    addNote({ paneId: PANE, anchor: diffAnchor(), comment: "third go" });
    expect(notesForPane(undefined, PANE)[0]?.sentAt).toBeUndefined();
  });

  it("names an anchor by what it points at, never by its excerpt", () => {
    expect(anchorKey(diffAnchor("a.ts", "@@ -1 +1 @@", "one"))).toBe(
      anchorKey(diffAnchor("a.ts", "@@ -1 +1 @@", "a completely different excerpt")),
    );
  });
});

describe("persistence", () => {
  it("round-trips through localStorage", () => {
    addNote({ paneId: PANE, anchor: diffAnchor(), comment: "keep me", intent: "question" });
    const raw = localStorage.getItem(NOTES_STORAGE_KEY);
    expect(raw).not.toBeNull();

    // A reload: the module forgets everything, the bytes stay.
    const reread = readAfterReload(raw ?? "");
    expect(reread).toHaveLength(1);
    expect(reread[0]?.comment).toBe("keep me");
    expect(reread[0]?.intent).toBe("question");
    expect(reread[0]?.anchor.kind).toBe("diff");
  });

  it("drops a row that does not read whole rather than repairing it", () => {
    const good = { id: "a", index: 1, anchor: diffAnchor(), comment: "fine", createdAt: 1 };
    const bad = { id: "b", index: 2, comment: "no anchor at all", createdAt: 1 };
    const rows = readAfterReload(JSON.stringify({ [KEY]: [good, bad] }));
    expect(rows.map((n) => n.id)).toEqual(["a"]);
  });
});

/** Put `raw` in storage as if the page had just opened, and read the pane back out of it. */
function readAfterReload(raw: string): Note[] {
  __resetNotes();
  localStorage.setItem(NOTES_STORAGE_KEY, raw);
  // `__resetNotes` leaves the store unloaded, so this read is the load.
  return notesForPane(undefined, PANE);
}

describe("what a note outlives", () => {
  it("is pruned when its pane is gone, and only within its own scope", () => {
    addNote({ paneId: "w1:p1", anchor: diffAnchor(), comment: "here" });
    addNote({ paneId: "w1:p9", anchor: diffAnchor(), comment: "gone" });
    addNote({ paneId: "w1:p9", scope: { host: "office" }, anchor: diffAnchor(), comment: "another machine" });
    pruneNotesForScope(undefined, ["w1:p1"]);
    expect(notesForPane(undefined, "w1:p1")).toHaveLength(1);
    expect(notesForPane(undefined, "w1:p9")).toHaveLength(0);
    // The other host was not in the list and must not have been read as absent.
    expect(notesForPane({ host: "office" }, "w1:p9")).toHaveLength(1);
  });

  it("clears the sent without touching the unsent, and clears all on request", () => {
    const a = addNote({ paneId: PANE, anchor: diffAnchor("a.ts", "@@ -1 +1 @@"), comment: "sent" });
    addNote({ paneId: PANE, anchor: diffAnchor("b.ts", "@@ -2 +2 @@"), comment: "waiting" });
    markNotesSent([a.id]);
    clearSentNotes(KEY);
    expect(notesForPane(undefined, PANE).map((n) => n.comment)).toEqual(["waiting"]);
    clearNotes(KEY);
    expect(notesForPane(undefined, PANE)).toHaveLength(0);
  });

  it("finds a transcript note by its turn's own uuid, whatever pane it was taken on", () => {
    addNote({
      paneId: "w2:p4",
      anchor: { kind: "transcript", turnId: "uuid-42", role: "assistant", excerpt: "…" },
      comment: "explain this",
    });
    expect(noteForTurn("uuid-42")?.comment).toBe("explain this");
    expect(noteForTurn("uuid-43")).toBeNull();
  });
});

describe("the fence", () => {
  it("is three backticks for ordinary text", () => {
    expect(fenceFor("nothing special")).toBe("```");
  });

  it("is always longer than the longest run inside, which is the bug it exists for", () => {
    expect(fenceFor("a ``` fence inside")).toBe("````");
    expect(fenceFor("`````` six of them")).toBe("```````");
    // An inline `code` span must not widen it past the default.
    expect(fenceFor("a `code` span")).toBe("```");
  });
});

describe("the prompt", () => {
  it("is Orca's shape: one header, a numbered section each, the sentence last", () => {
    addNote({
      paneId: PANE,
      anchor: diffAnchor("web/src/a.ts", "@@ -10,3 +12,4 @@", "-old\n+new"),
      comment: "this is 4px too low",
      intent: "bug",
    });
    addNote({
      paneId: PANE,
      anchor: { kind: "transcript", turnId: "uuid-7", role: "assistant", excerpt: "I removed the guard." },
      comment: "why?",
    });
    const prompt = buildNotesPrompt(notesForPane(undefined, PANE), { title: "meow › api" });

    expect(prompt.startsWith("## Feedback: meow › api\n")).toBe(true);
    expect(prompt).toContain("### 1. Diff · web/src/a.ts");
    expect(prompt).toContain("**Intent:** bug");
    expect(prompt).toContain("**File:** `web/src/a.ts`");
    expect(prompt).toContain("**Hunk:** `@@ -10,3 +12,4 @@`");
    expect(prompt).toContain("**Lines:** 1-3"); // `diffAnchor`'s own range — see the helper
    expect(prompt).toContain("### 2. Transcript · assistant");
    expect(prompt).toContain("**Turn:** `uuid-7`");

    // The human's sentence is LAST in its section, after every field it is about.
    const section = prompt.slice(prompt.indexOf("### 1."), prompt.indexOf("### 2."));
    expect(section.indexOf("**Feedback:** this is 4px too low")).toBeGreaterThan(section.indexOf("**Excerpt:**"));
    expect(section.trimEnd().endsWith("**Feedback:** this is 4px too low")).toBe(true);
    // And the sections are in the notes' own order.
    expect(prompt.indexOf("### 1.")).toBeLessThan(prompt.indexOf("### 2."));
  });

  it("fences an excerpt that itself contains a fence, so nothing escapes the block", () => {
    addNote({
      paneId: PANE,
      anchor: diffAnchor("a.md", "@@ -1 +1 @@", "+```sh\n+echo hi\n+```"),
      comment: "keep the block",
    });
    const prompt = buildNotesPrompt(notesForPane(undefined, PANE), { title: "pane" });
    expect(prompt).toContain("````\n+```sh");
    // The closing run matches, and the note's own sentence is still outside the block.
    expect(prompt).toContain("+```\n````\n**Feedback:** keep the block");
  });

  it("says out loud that a framed document could not be quoted", () => {
    addNote({ paneId: PANE, anchor: { kind: "doc", slug: "meow-notes", title: "Meow notes" }, comment: "stale" });
    const prompt = buildNotesPrompt(notesForPane(undefined, PANE), { title: "pane" });
    expect(prompt).toContain("### 1. Document · Meow notes");
    expect(prompt).toContain("**Slug:** `meow-notes`");
    expect(prompt).toContain("framed sandboxed");
    expect(prompt).not.toContain("**Excerpt:**");
  });

  it("carries the operator's own message after the notes, under its own heading", () => {
    addNote({ paneId: PANE, anchor: diffAnchor(), comment: "one" });
    const prompt = buildNotesPrompt(notesForPane(undefined, PANE), { title: "pane", message: "  and please rebuild  " });
    expect(prompt.trimEnd().endsWith("### Message\nand please rebuild")).toBe(true);
  });

  it("renders the element anchor the annotate work will write", () => {
    addNote({
      paneId: PANE,
      anchor: {
        kind: "element",
        selector: "main > button.primary",
        box: { x: 880, y: 312, w: 104, h: 36 },
        text: "Export CSV",
        component: "UsageChart > Button",
        screenshotPath: "/blobs/shot.webp",
      },
      comment: "misaligned",
    });
    const prompt = buildNotesPrompt(notesForPane(undefined, PANE), { title: "pane" });
    expect(prompt).toContain("### 1. Element · main > button.primary");
    expect(prompt).toContain("**Bounds:** x=880, y=312, 104x36");
    expect(prompt).toContain("**Component:** UsageChart > Button");
    expect(prompt).toContain("**Screenshot:** `/blobs/shot.webp`");
  });
});
