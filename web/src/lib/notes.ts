import { asJsonNumber, asJsonObject, asJsonString, parseJson, type JsonValue } from "./json";
import { paneScopeKey, type Scope } from "./scope";

// FORK: anchored notes — a precise pointer plus one human sentence, kept per pane until the
// operator sends them as ONE prompt.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
// The diff sheet, the transcript and the document panel are all read-only dead ends today: you read
// what the agent did, swipe back, and retype what you saw into the composer from memory, on a phone
// keyboard. A note turns reading into acting. It is also the highest-fidelity thing a phone can
// produce — an exact pointer the operator could never type, plus a short sentence they can dictate.
//
// ── ONE STORE, SEVERAL SURFACES ─────────────────────────────────────────────────────────────────
// The shape is Orca's, whose annotate/diff-notes/markdown-review flows are three instantiations of
// one note primitive rather than three features (see the landscape research §A.6). So the ANCHOR is
// a discriminated union and everything else — the cap, the stacking rule, the prompt builder, the
// send — is written once and knows nothing about which panel produced the note.
//
// ── PERSISTED, BOUNDED, AND ORCA'S TWO NUMBERS ──────────────────────────────────────────────────
// localStorage, like lib/drafts.ts and lib/send-queue.ts: the OS kills a backgrounded PWA and a
// note that died with the tab would be lost exactly when the operator walked away mid-review. The
// caps are Orca's, verified from its bundle: 2000 characters of comment, 20 notes per pane (oldest
// dropped), 500 characters of excerpt. There is no TTL — unlike a queued send, a note says nothing
// about a moment, and a stale note is visible as a note rather than sent behind the operator's back.
//
// ── THE PROMPT IS NOT TRANSLATED, AND THAT IS DELIBERATE ────────────────────────────────────────
// `buildNotesPrompt` writes English. It is not UI: it is the text typed into a terminal for an agent
// to read, and it sits with the terminal mirror, quick replies and slash-command descriptions on the
// "another tool's vocabulary" side of ADR 0030. Every string the OPERATOR reads goes through `t()`
// in the components; every string the AGENT reads is here.

/** The rectangle an element anchor was captured at, in CSS pixels of the shot it was probed on. */
export interface NoteBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * WHAT a note points at. Four kinds, one per surface that can produce one.
 *
 * `element` is RESERVED and nothing writes it yet: it is the shape the annotate work will store when
 * a tap on a rendered screenshot is probed back into a DOM node (interactive research §3.3 — the
 * probe runs in the BRIDGE's Chrome, never in the phone's iframe, so `selector`/`box`/`text` arrive
 * from `DOM.getNodeForLocation` and `screenshotPath` is the uploaded shot's host path). It is
 * declared here rather than there so the store, the caps, the stacking rule and the prompt builder
 * are written once against the finished union instead of being widened later.
 */
export type NoteAnchor =
  | { kind: "diff"; file: string; hunkHeader: string; lineRange?: string; excerpt: string }
  | { kind: "transcript"; turnId: string; role: string; excerpt: string }
  | { kind: "doc"; slug: string; title: string }
  | {
      kind: "element";
      selector: string;
      box: NoteBox;
      text: string;
      screenshotPath?: string;
      component?: string;
    };

/** What the operator says this note IS. Orca's three, and it rides in the prompt as `**Intent:**`. */
export type NoteIntent = "bug" | "change" | "question";

export interface Note {
  id: string;
  /**
   * 1-based position among this pane's notes — the number on the badge, on the chip and in the
   * `### N.` heading. RENUMBERED on every add and delete, so the list is always 1…N with no holes:
   * a badge reading "#4" beside two other badges is a badge nobody can count.
   */
  index: number;
  anchor: NoteAnchor;
  comment: string;
  intent?: NoteIntent;
  createdAt: number;
  /** When this note went out with a send. Set, never deleted — a sent note is dimmed, not removed. */
  sentAt?: number;
}

/** The operator's sentence, past which nothing is stored. Orca's `comment` budget. */
export const NOTE_COMMENT_MAX = 2000;
/** The quoted anchor text, past which nothing is stored. Orca's `selectedText` budget. */
export const NOTE_EXCERPT_MAX = 500;
/** Notes kept per pane; the oldest goes when a new one arrives. Orca's `annotationsMaxPerPage`. */
export const NOTES_MAX_PER_PANE = 20;

/** Where the notes live. Exported so a test can round-trip the bytes rather than mock the store. */
export const NOTES_STORAGE_KEY = "collie:notes:v1";
const STORAGE_KEY = NOTES_STORAGE_KEY;

/** Keyed by `paneScopeKey(scope, paneId)` — the same triple every per-pane cache in this app uses. */
let panes = new Map<string, Note[]>();
let loaded = false;
const listeners = new Set<() => void>();
/** Per-key snapshots, so `useSyncExternalStore` sees a stable array while nothing changed. */
const views = new Map<string, Note[]>();

function storage(): Storage | null {
  try {
    // Read off `globalThis` rather than asked for with `typeof`: a page has one, the service worker
    // has none, and jsdom's is a plain object until the test shim wires it (lib/send-queue.ts).
    const store = globalThis.localStorage;
    return store !== undefined && "getItem" in store ? store : null;
  } catch {
    return null;
  }
}

const INTENTS: readonly NoteIntent[] = ["bug", "change", "question"];
function isIntent(value: string): value is NoteIntent {
  return INTENTS.some((known) => known === value);
}

/** One persisted box, believed field by field — a missing or non-numeric side means no box. */
function readBox(value: JsonValue | undefined): NoteBox | null {
  const record = asJsonObject(value);
  if (record === undefined) return null;
  const x = asJsonNumber(record.x);
  const y = asJsonNumber(record.y);
  const w = asJsonNumber(record.w);
  const h = asJsonNumber(record.h);
  if (x === undefined || y === undefined || w === undefined || h === undefined) return null;
  return { x, y, w, h };
}

/** One persisted anchor, narrowed by its `kind` — anything that does not read whole is dropped. */
function readAnchor(value: JsonValue | undefined): NoteAnchor | null {
  const record = asJsonObject(value);
  if (record === undefined) return null;
  const kind = asJsonString(record.kind);
  if (kind === "diff") {
    const file = asJsonString(record.file);
    const hunkHeader = asJsonString(record.hunkHeader);
    const excerpt = asJsonString(record.excerpt);
    if (file === undefined || hunkHeader === undefined || excerpt === undefined) return null;
    const anchor: NoteAnchor = { kind: "diff", file, hunkHeader, excerpt };
    const lineRange = asJsonString(record.lineRange);
    if (lineRange !== undefined) anchor.lineRange = lineRange;
    return anchor;
  }
  if (kind === "transcript") {
    const turnId = asJsonString(record.turnId);
    const role = asJsonString(record.role);
    const excerpt = asJsonString(record.excerpt);
    if (turnId === undefined || role === undefined || excerpt === undefined) return null;
    return { kind: "transcript", turnId, role, excerpt };
  }
  if (kind === "doc") {
    const slug = asJsonString(record.slug);
    const title = asJsonString(record.title);
    if (slug === undefined || title === undefined) return null;
    return { kind: "doc", slug, title };
  }
  if (kind === "element") {
    const selector = asJsonString(record.selector);
    const text = asJsonString(record.text);
    const box = readBox(record.box);
    if (selector === undefined || text === undefined || box === null) return null;
    const anchor: NoteAnchor = { kind: "element", selector, box, text };
    const screenshotPath = asJsonString(record.screenshotPath);
    if (screenshotPath !== undefined) anchor.screenshotPath = screenshotPath;
    const component = asJsonString(record.component);
    if (component !== undefined) anchor.component = component;
    return anchor;
  }
  return null;
}

/** One persisted note, or null. A row that does not read whole is dropped rather than repaired. */
function readNote(value: JsonValue): Note | null {
  const record = asJsonObject(value);
  if (record === undefined) return null;
  const id = asJsonString(record.id);
  const comment = asJsonString(record.comment);
  const index = asJsonNumber(record.index);
  const createdAt = asJsonNumber(record.createdAt);
  const anchor = readAnchor(record.anchor);
  if (id === undefined || comment === undefined || anchor === null) return null;
  if (index === undefined || createdAt === undefined) return null;
  const note: Note = { id, index, anchor, comment, createdAt };
  const intent = asJsonString(record.intent);
  if (intent !== undefined && isIntent(intent)) note.intent = intent;
  const sentAt = asJsonNumber(record.sentAt);
  if (sentAt !== undefined) note.sentAt = sentAt;
  return note;
}

function load(): void {
  if (loaded) return;
  loaded = true;
  const store = storage();
  if (store === null) return;
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (raw === null) return;
    const parsed = asJsonObject(parseJson(raw));
    if (parsed === undefined) return;
    const next = new Map<string, Note[]>();
    for (const [key, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      const rows: Note[] = [];
      for (const item of value) {
        const note = readNote(item);
        if (note !== null) rows.push(note);
      }
      if (rows.length > 0) next.set(key, renumber(rows));
    }
    panes = next;
  } catch {
    panes = new Map();
  }
}

function persist(): void {
  const store = storage();
  if (store === null) return;
  try {
    if (panes.size === 0) {
      store.removeItem(STORAGE_KEY);
      return;
    }
    // The Map, as the object it is read back as. `Object.fromEntries` rather than a typed literal
    // built up field by field: `Note` is a closed shape of JSON primitives by construction (see the
    // interface), so there is nothing here to assert about and nothing to widen.
    store.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(panes)));
  } catch {
    // Private mode, a full disk: the notes live in memory for this page's lifetime.
  }
}

function emit(): void {
  views.clear();
  persist();
  for (const fn of listeners) fn();
}

export function subscribeNotes(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 1…N with no holes, in list order. The badge, the chip and the `### N.` heading all read it. */
function renumber(rows: readonly Note[]): Note[] {
  return rows.map((note, i) => (note.index === i + 1 ? note : { ...note, index: i + 1 }));
}

/**
 * The stacking identity of an anchor — Bolt's rule, and the reason it is a rule: re-noting the same
 * hunk three times with slightly different wording produces a prompt that says the same thing three
 * ways, and an agent asked three times hedges. Two notes are the same note when they point at the
 * same thing, so a second note on a pointer UPDATES the first.
 *
 * ` ` joins the parts because it is the one character no file path, hunk header, uuid, slug or
 * CSS selector can contain, so no two different anchors can collide on a separator.
 */
export function anchorKey(anchor: NoteAnchor): string {
  switch (anchor.kind) {
    case "diff":
      return `diff ${anchor.file} ${anchor.hunkHeader} ${anchor.lineRange ?? ""}`;
    case "transcript":
      return `transcript ${anchor.turnId}`;
    case "doc":
      return `doc ${anchor.slug}`;
    case "element":
      return `element ${anchor.selector}`;
  }
}

/** Trim to a budget, marking the cut so a reader (and the agent) can see the text was shortened. */
function clamp(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/** The anchor as it is STORED: every quoted run already inside its budget. */
function clampAnchor(anchor: NoteAnchor): NoteAnchor {
  switch (anchor.kind) {
    case "diff":
      return { ...anchor, excerpt: clamp(anchor.excerpt, NOTE_EXCERPT_MAX) };
    case "transcript":
      return { ...anchor, excerpt: clamp(anchor.excerpt, NOTE_EXCERPT_MAX) };
    case "doc":
      return anchor;
    case "element":
      return { ...anchor, text: clamp(anchor.text, NOTE_EXCERPT_MAX) };
  }
}

const EMPTY: Note[] = [];

/** One pane's notes, in order. Stable while nothing changed. */
export function notesFor(key: string): Note[] {
  load();
  let view = views.get(key);
  if (view === undefined) {
    view = panes.get(key) ?? EMPTY;
    views.set(key, view);
  }
  return view;
}

/** {@link notesFor} by the pane's own address, for callers that do not hold the key. */
export function notesForPane(scope: Scope | undefined, paneId: string): Note[] {
  return notesFor(paneScopeKey(scope, paneId));
}

/** Every note in the store, whatever pane it belongs to — see {@link noteForTurn}. */
export function allNotes(): Note[] {
  load();
  return [...panes.values()].flat();
}

/**
 * The note anchored to a transcript turn, wherever it lives.
 *
 * A turn id is a journal entry's own uuid, unique across every session on every machine, so this
 * cannot answer about the wrong pane — which is what lets `components/transcript-view.tsx` draw a
 * numbered badge from ONE optional callback prop instead of being handed a pane address it has no
 * other use for. That file is upstream's and the hunk in it is the thing being kept small.
 */
export function noteForTurn(turnId: string): Note | null {
  return allNotes().find((n) => n.anchor.kind === "transcript" && n.anchor.turnId === turnId) ?? null;
}

/** The note already anchored HERE, or null — what the entry gestures open the sheet in edit mode on. */
export function noteAt(key: string, anchor: NoteAnchor): Note | null {
  const wanted = anchorKey(anchor);
  return notesFor(key).find((n) => anchorKey(n.anchor) === wanted) ?? null;
}

export interface AddNoteArgs {
  paneId: string;
  scope?: Scope;
  anchor: NoteAnchor;
  comment: string;
  intent?: NoteIntent;
}

/**
 * Keep a note, or update the one already on this anchor (the stacking rule above).
 *
 * An update keeps the note's id, index and `createdAt` — it is the same note, re-worded — and DROPS
 * `sentAt`: the words changed, so what went out is no longer what this note says, and a note the
 * operator has just re-written must be sendable again rather than dimmed and finished.
 */
export function addNote(args: AddNoteArgs, now: number = Date.now()): Note {
  load();
  const key = paneScopeKey(args.scope, args.paneId);
  const anchor = clampAnchor(args.anchor);
  const comment = clamp(args.comment, NOTE_COMMENT_MAX);
  const rows = panes.get(key) ?? [];
  const wanted = anchorKey(anchor);
  const at = rows.findIndex((n) => anchorKey(n.anchor) === wanted);
  let saved: Note;
  if (at >= 0) {
    const previous = rows[at]!;
    saved = { id: previous.id, index: previous.index, anchor, comment, createdAt: previous.createdAt };
    if (args.intent !== undefined) saved.intent = args.intent;
    panes.set(key, renumber(rows.map((n, i) => (i === at ? saved : n))));
  } else {
    saved = {
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      index: rows.length + 1,
      anchor,
      comment,
      createdAt: now,
    };
    if (args.intent !== undefined) saved.intent = args.intent;
    panes.set(key, renumber([...rows, saved].slice(-NOTES_MAX_PER_PANE)));
  }
  emit();
  // The note the caller gets back is the one in the store, renumbering included.
  return notesFor(key).find((n) => n.id === saved.id) ?? saved;
}

/** Re-word a note in place. A changed comment un-sends it, for the reason {@link addNote} gives. */
export function updateNote(id: string, patch: { comment?: string; intent?: NoteIntent }): void {
  load();
  for (const [key, rows] of panes) {
    const at = rows.findIndex((n) => n.id === id);
    if (at < 0) continue;
    const previous = rows[at]!;
    const next: Note = { ...previous };
    if (patch.comment !== undefined) {
      next.comment = clamp(patch.comment, NOTE_COMMENT_MAX);
      delete next.sentAt;
    }
    if (patch.intent !== undefined) next.intent = patch.intent;
    panes.set(key, rows.map((n, i) => (i === at ? next : n)));
    emit();
    return;
  }
}

export function deleteNote(id: string): void {
  load();
  for (const [key, rows] of panes) {
    if (!rows.some((n) => n.id === id)) continue;
    const next = rows.filter((n) => n.id !== id);
    if (next.length === 0) panes.delete(key);
    else panes.set(key, renumber(next));
    emit();
    return;
  }
}

/** A copy of `note` that has gone out. A new object, because the store hands its rows to React. */
function stamped(note: Note, at: number): Note {
  const next: Note = { ...note };
  next.sentAt = at;
  return next;
}

/** Stamp a send. Sent notes are DIMMED, never deleted — "Clear sent" is the operator's own act. */
export function markNotesSent(ids: readonly string[], now: number = Date.now()): void {
  load();
  const wanted = new Set(ids);
  let touched = false;
  for (const [key, rows] of panes) {
    if (!rows.some((n) => wanted.has(n.id))) continue;
    const next: Note[] = [];
    for (const note of rows) next.push(wanted.has(note.id) ? stamped(note, now) : note);
    panes.set(key, next);
    touched = true;
  }
  if (touched) emit();
}

/** Everything this pane holds. */
export function clearNotes(key: string): void {
  load();
  if (!panes.delete(key)) return;
  emit();
}

/** Only what has already gone out — the tidy-up that cannot lose an unsent sentence. */
export function clearSentNotes(key: string): void {
  load();
  const rows = panes.get(key);
  if (rows === undefined) return;
  const next = rows.filter((n) => n.sentAt === undefined);
  if (next.length === rows.length) return;
  if (next.length === 0) panes.delete(key);
  else panes.set(key, renumber(next));
  emit();
}

/**
 * Drop the notes of panes that are gone, within ONE scope.
 *
 * Scoped rather than global on purpose: the snapshot a caller holds is the panes of the machines the
 * lead could reach on that poll, so a peer that went quiet for a sweep would take its notes with it
 * if this pruned everything it could not see. Restricting the sweep to the keys under `scopeKey`
 * means the worst case is a note that outlives its pane on another host — visible, and dropped the
 * next time that host's own pane view runs this — rather than a note the operator wrote being
 * deleted by a missed poll.
 */
export function pruneNotesForScope(scope: Scope | undefined, livePaneIds: readonly string[]): void {
  load();
  // `paneScopeKey(scope, "")` IS the scope's own prefix plus the separator — asked of the one
  // function that builds these keys rather than re-spelled here, so the two can never disagree.
  const prefix = paneScopeKey(scope, "");
  const live = new Set(livePaneIds.map((paneId) => `${prefix}${paneId}`));
  // Collected first, deleted after: a `Map` is being walked, and removing entries mid-walk is the
  // kind of thing that works today and stops working when somebody adds a second condition.
  const doomed: string[] = [];
  for (const key of panes.keys()) {
    if (!key.startsWith(prefix)) continue;
    if (live.has(key)) continue;
    doomed.push(key);
  }
  for (const key of doomed) panes.delete(key);
  if (doomed.length > 0) emit();
}

// ── The prompt ────────────────────────────────────────────────────────────────

/**
 * A backtick run one longer than the longest run inside `text`, and never shorter than three.
 *
 * Ported from Orca's `Fg`/`Pg` because the bug it prevents is real and this app will hit it on the
 * first note: an agent's own diff or reply regularly CONTAINS a fenced block, and a three-backtick
 * fence around it closes at the inner fence — so the rest of the excerpt and every field after it
 * land outside the code block, as prose the agent reads as instructions.
 */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

/** `text` inside a fence that cannot be closed early by anything inside it. */
export function fenced(text: string): string {
  const fence = fenceFor(text);
  return `${fence}\n${text}\n${fence}`;
}

/** The `### N.` heading's subject. English — this is the agent's half of the prompt (see the header). */
export function anchorLabel(anchor: NoteAnchor): string {
  switch (anchor.kind) {
    case "diff":
      return `Diff · ${anchor.file}`;
    case "transcript":
      return `Transcript · ${anchor.role}`;
    case "doc":
      return `Document · ${anchor.title || anchor.slug}`;
    case "element":
      return `Element · ${anchor.selector}`;
  }
}

/** The short thing a chip says after its kind word — a basename, a turn's head, a title, a selector. */
export function anchorTarget(anchor: NoteAnchor): string {
  switch (anchor.kind) {
    case "diff":
      return anchor.file.split("/").pop() ?? anchor.file;
    case "transcript":
      return anchor.turnId.slice(0, 6);
    case "doc":
      return anchor.title || anchor.slug;
    case "element":
      return anchor.selector;
  }
}

/** The quoted run a note carries, or "" for an anchor that has none (a framed document). */
export function anchorExcerpt(anchor: NoteAnchor): string {
  switch (anchor.kind) {
    case "diff":
      return anchor.excerpt;
    case "transcript":
      return anchor.excerpt;
    case "doc":
      return "";
    case "element":
      return anchor.text;
  }
}

/** The bold field rows of one anchor, in reading order. Excerpt is added by the caller, fenced. */
function anchorFields(anchor: NoteAnchor): string[] {
  switch (anchor.kind) {
    case "diff": {
      const rows = [`**File:** \`${anchor.file}\``, `**Hunk:** \`${anchor.hunkHeader}\``];
      if (anchor.lineRange !== undefined) rows.push(`**Lines:** ${anchor.lineRange}`);
      return rows;
    }
    case "transcript":
      return [`**Turn:** \`${anchor.turnId}\``, `**Role:** ${anchor.role}`];
    case "doc":
      return [
        `**Document:** ${anchor.title || anchor.slug}`,
        `**Slug:** \`${anchor.slug}\``,
        // Said in the prompt, not just in the UI: the panel frames a knowledge-base document with
        // `sandbox=""` into an opaque origin, so the parent cannot read a selection out of it. An
        // agent told only "Document: x" would reasonably assume the operator pointed at a passage.
        "**Note:** the document is framed sandboxed, so no text selection could be captured — this note is anchored to the whole document.",
      ];
    case "element": {
      const rows = [
        `**Selector:** \`${anchor.selector}\``,
        `**Bounds:** x=${anchor.box.x}, y=${anchor.box.y}, ${anchor.box.w}x${anchor.box.h}`,
      ];
      if (anchor.component !== undefined) rows.push(`**Component:** ${anchor.component}`);
      if (anchor.screenshotPath !== undefined) rows.push(`**Screenshot:** \`${anchor.screenshotPath}\``);
      return rows;
    }
  }
}

export interface NotesPromptOptions {
  /** What the notes are ABOUT — the pane or space name, in the `## Feedback:` heading. */
  title: string;
  /** The operator's own message, when a reply is riding along with the notes. */
  message?: string;
}

/**
 * The notes as ONE Markdown document, in Orca's shape (`Lg()` in its bundle): an `##` header naming
 * the source, a `###` per note, bold field labels, and the human's sentence LAST under `**Feedback:**`.
 *
 * The ordering is the argument: the fields are what the operator could never have typed, and the
 * sentence is what they meant by pointing at them — so the pointer is established first and the ask
 * is read against it, rather than a sentence arriving before there is anything to attach it to.
 */
export function buildNotesPrompt(notes: readonly Note[], options: NotesPromptOptions): string {
  const parts: string[] = [`## Feedback: ${options.title}`];
  notes.forEach((note, i) => {
    const rows = [`### ${i + 1}. ${anchorLabel(note.anchor)}`];
    if (note.intent !== undefined) rows.push(`**Intent:** ${note.intent}`);
    rows.push(...anchorFields(note.anchor));
    const excerpt = anchorExcerpt(note.anchor);
    if (excerpt !== "") rows.push(`**Excerpt:**\n${fenced(excerpt)}`);
    rows.push(`**Feedback:** ${note.comment}`);
    parts.push(rows.join("\n"));
  });
  const message = options.message?.trim() ?? "";
  if (message !== "") parts.push(`### Message\n${message}`);
  return parts.join("\n\n");
}

/** Tests only: forget everything, including what was persisted. */
export function __resetNotes(): void {
  panes = new Map();
  loaded = false;
  views.clear();
  storage()?.removeItem(STORAGE_KEY);
  for (const fn of listeners) fn();
}
