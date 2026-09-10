import { useSyncExternalStore } from "react";

import { lastHealthyAt, subscribeHealth } from "./connection-health";
import { hasWindow } from "./env";
import { asJsonNumber, asJsonObject, asJsonString, parseJson, type JsonValue } from "./json";
import { t } from "./i18n";
import { sendGuardedReply } from "./reply-action";
import { paneScopeKey, type Scope } from "./scope";
import { setStatus } from "./status";
import type { AgentStatus } from "./types";

// FORK: the sends that could not leave the phone, kept to leave when the link is back.
//
// Through a tunnel and an identity proxy, a send fails for reasons that have nothing to do with
// the pane: the radio dropped for a second, the Access session lapsed, the bridge is restarting.
// Before this the composer handed the words back to the field and said so — which on a phone
// means the operator re-taps Send until it goes, or forgets, and the message is lost with the
// draft's 48 hours. Now a send whose failure was the LINK's (lib/send-failure.ts) is queued here,
// per pane, and drained in order the moment a poll proves the link live again.
//
// ── WHAT DRAINS ON ITS OWN, AND WHAT WAITS FOR A TAP ────────────────────────────────────────────
// A plain message resends itself. An ANSWER — a yes/no to a prompt the pane was showing when it
// was queued — does not: the prompt may have been answered from the terminal, or timed out, or be a
// different prompt now, and an auto-sent "y" into a pane that has moved on is the one thing this
// must never do. Those are marked `answer`, carry the status the pane had, and drain only on the
// row's own Send now. A message the drain could not deliver (the pane refused it — a dialog owns
// the keyboard, the text never echoed) is HELD the same way, with the pane's reason on the row.
//
// ── PERSISTED, BOUNDED ──────────────────────────────────────────────────────────────────────────
// localStorage, like the drafts: the OS kills a PWA in the background, and a queue that died with
// the tab would be a queue that lost the message exactly when the tunnel was down for a while.
// Twenty-four hours, eight KiB an item, thirty items — past any of those the oldest goes, because a
// message a day old sent into a pane that has done a day's work is not the message it was.

export type QueuedKind = "message" | "answer";

export interface QueuedSend {
  id: string;
  paneId: string;
  scope?: Scope;
  /** `paneScopeKey(scope, paneId)`, so every read is one string compare. */
  key: string;
  text: string;
  kind: QueuedKind;
  /** The pane's agent when queued — picks the adapter the resend is verified through. */
  agent: string | null;
  /** The pane's status when queued; an `answer` is only meaningful against the same one. */
  status?: AgentStatus;
  queuedAt: number;
  /** Set when the drain tried and the PANE refused: the row waits for a tap, and says why. */
  held?: string;
}

export const QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
export const QUEUE_ITEM_BYTES = 8 * 1024;
export const QUEUE_MAX_ITEMS = 30;
const STORAGE_KEY = "collie:send-queue:v1";

let items: QueuedSend[] = [];
let loaded = false;
const listeners = new Set<() => void>();
/** Per-key snapshots, so `useSyncExternalStore` sees a stable array while nothing changed. */
const views = new Map<string, QueuedSend[]>();

function storage(): Storage | null {
  try {
    // The globals are read off `globalThis` rather than asked for with `typeof`: a page has one,
    // the service worker has none, and jsdom's is a plain object until the test shim wires it.
    const store = globalThis.localStorage;
    return store !== undefined && "getItem" in store ? store : null;
  } catch {
    return null;
  }
}

/** One persisted row, believed field by field through the JSON readers — or null. */
function readRow(value: JsonValue): QueuedSend | null {
  const record = asJsonObject(value);
  if (record === undefined) return null;
  const id = asJsonString(record.id);
  const paneId = asJsonString(record.paneId);
  const key = asJsonString(record.key);
  const text = asJsonString(record.text);
  const kind = asJsonString(record.kind);
  const queuedAt = asJsonNumber(record.queuedAt);
  if (id === undefined || paneId === undefined || key === undefined || text === undefined) return null;
  if ((kind !== "message" && kind !== "answer") || queuedAt === undefined) return null;
  const row: QueuedSend = { id, paneId, key, text, kind, agent: asJsonString(record.agent) ?? null, queuedAt };
  const scope = asJsonObject(record.scope);
  if (scope !== undefined) {
    const host = asJsonString(scope.host);
    const session = asJsonString(scope.session);
    const out: Scope = {};
    if (host !== undefined) out.host = host;
    if (session !== undefined) out.session = session;
    row.scope = out;
  }
  const status = asJsonString(record.status);
  if (status !== undefined && isAgentStatus(status)) row.status = status;
  const held = asJsonString(record.held);
  if (held !== undefined) row.held = held;
  return row;
}

const AGENT_STATUSES: readonly AgentStatus[] = ["idle", "working", "blocked", "done", "unknown"];
function isAgentStatus(value: string): value is AgentStatus {
  return AGENT_STATUSES.some((known) => known === value);
}

function load(now: number): void {
  if (loaded) return;
  loaded = true;
  const store = storage();
  if (store === null) return;
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (raw === null) return;
    const parsed = parseJson(raw);
    if (!Array.isArray(parsed)) return;
    const rows: QueuedSend[] = [];
    for (const item of parsed) {
      const row = readRow(item);
      if (row !== null && now - row.queuedAt < QUEUE_TTL_MS) rows.push(row);
    }
    items = rows;
  } catch {
    items = [];
  }
}

function persist(): void {
  const store = storage();
  if (store === null) return;
  try {
    if (items.length === 0) store.removeItem(STORAGE_KEY);
    else store.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Private mode, a full disk: the queue lives in memory for this page's lifetime.
  }
}

function emit(): void {
  views.clear();
  persist();
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Whether `text` is small enough to be kept. */
export function fitsQueue(text: string): boolean {
  return new TextEncoder().encode(text).byteLength <= QUEUE_ITEM_BYTES;
}

export interface EnqueueArgs {
  paneId: string;
  scope?: Scope;
  text: string;
  kind: QueuedKind;
  agent: string | null;
  status?: AgentStatus;
}

/** Keep one send. Returns the row, or null when the text is too large to keep. */
export function enqueueSend(args: EnqueueArgs, now: number = Date.now()): QueuedSend | null {
  load(now);
  if (!fitsQueue(args.text)) return null;
  const row: QueuedSend = {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    paneId: args.paneId,
    key: paneScopeKey(args.scope, args.paneId),
    text: args.text,
    kind: args.kind,
    agent: args.agent,
    queuedAt: now,
  };
  if (args.scope !== undefined) row.scope = args.scope;
  if (args.status !== undefined) row.status = args.status;
  items = [...items.filter((i) => now - i.queuedAt < QUEUE_TTL_MS), row];
  while (items.length > QUEUE_MAX_ITEMS) items.shift();
  emit();
  return row;
}

export function discardSend(id: string): void {
  load(Date.now());
  const next = items.filter((i) => i.id !== id);
  if (next.length === items.length) return;
  items = next;
  emit();
}

/** The queued sends for one pane, oldest first. Stable while nothing changed. */
export function queuedFor(key: string): QueuedSend[] {
  load(Date.now());
  let view = views.get(key);
  if (view === undefined) {
    view = items.filter((i) => i.key === key);
    views.set(key, view);
  }
  return view;
}

/** {@link queuedFor} by the pane's own address, for callers that do not hold the key. */
export function queuedForPane(scope: Scope | undefined, paneId: string): QueuedSend[] {
  return queuedFor(paneScopeKey(scope, paneId));
}

const EMPTY: QueuedSend[] = [];

/** The hook view of {@link queuedFor}. */
export function useQueuedSends(scope: Scope | undefined, paneId: string): QueuedSend[] {
  const key = paneScopeKey(scope, paneId);
  return useSyncExternalStore(
    subscribe,
    () => queuedFor(key),
    () => EMPTY,
  );
}

/** Every pane with something waiting. */
export function queuedKeys(): string[] {
  load(Date.now());
  return [...new Set(items.map((i) => i.key))];
}

function mark(id: string, held: string | undefined): void {
  items = items.map((i) => {
    if (i.id !== id) return i;
    const next = { ...i };
    if (held === undefined) delete next.held;
    else next.held = held;
    return next;
  });
  emit();
}

// ── The drain ─────────────────────────────────────────────────────────────────

/** The send the drain performs, injectable so the test drives the sequencing without a pane. */
export type QueueSender = (row: QueuedSend) => ReturnType<typeof sendGuardedReply>;

const defaultSender: QueueSender = (row) =>
  sendGuardedReply({ paneId: row.paneId, text: row.text, agent: row.agent, scope: row.scope });

let draining: Promise<void> | null = null;

/**
 * Send what can be sent, one pane at a time, in order.
 *
 * `force` sends ONE row regardless of its kind or hold — the row's own Send now. Without it, only
 * plain messages with no hold are attempted, and the first refusal in a pane stops that pane so the
 * ones behind it stay in order. A link failure stops everything: the next live poll will try again.
 */
export async function drainSendQueue(
  options: { force?: string; sender?: QueueSender } = {},
): Promise<void> {
  if (draining !== null) {
    await draining;
    if (options.force === undefined) return;
  }
  const run = (async () => {
    load(Date.now());
    const sender = options.sender ?? defaultSender;
    const forced = options.force !== undefined ? items.find((i) => i.id === options.force) : undefined;
    const candidates = forced ? [forced] : [...items];
    const stopped = new Set<string>();
    for (const row of candidates) {
      if (!forced && (row.kind !== "message" || row.held !== undefined)) {
        // A row that waits for a tap holds its pane's place in line: the ones behind it wait too,
        // so a queue never sends out of order around something the operator has not decided.
        stopped.add(row.key);
        continue;
      }
      if (stopped.has(row.key)) continue;
      if (!items.some((i) => i.id === row.id)) continue; // discarded meanwhile
      let outcome: Awaited<ReturnType<QueueSender>>;
      try {
        outcome = await sender(row);
      } catch (e) {
        outcome = { status: "error", error: e instanceof Error ? e.message : String(e) };
      }
      if (outcome.status === "sent") {
        items = items.filter((i) => i.id !== row.id);
        emit();
        setStatus(t("queue.sent"), "success");
        continue;
      }
      if (outcome.status === "error" && outcome.transport !== undefined && !outcome.textDelivered) {
        // The link again. Leave everything as it is; the next live poll drains.
        return;
      }
      // The PANE refused (or the text landed unsubmitted): hold this row for a tap, and do not
      // send the ones behind it out of order.
      mark(row.id, outcome.error);
      stopped.add(row.key);
    }
  })();
  draining = run;
  try {
    await run;
  } finally {
    if (draining === run) draining = null;
  }
}

// ── When to drain ─────────────────────────────────────────────────────────────
//
// A live poll (`markLive`, which moves `lastHealthyAt`) is the proof the link is back — the same
// proof the connection banner de-escalates on, so the queue can never think the link is up while the
// banner says it is down. `online` is a hint on top: it fires the instant the radio returns, before
// the next poll would, and a drain on a link that is not really back simply fails and waits.

let lastSeenHealthy = 0;
let scheduled: ReturnType<typeof setTimeout> | null = null;

function scheduleDrain(sender?: QueueSender): void {
  if (scheduled !== null) return;
  scheduled = setTimeout(() => {
    scheduled = null;
    if (queuedKeys().length === 0) return;
    void drainSendQueue(sender === undefined ? {} : { sender });
  }, 250);
}

let installed: (() => void) | null = null;

/**
 * Wire the drain to the link. Called once at module load in a page; a second call REPLACES the
 * first (a test installing its own sender), so two listeners can never race for the one timer.
 * Returns the unsubscribe.
 */
export function installSendQueueDrain(sender?: QueueSender): () => void {
  installed?.();
  lastSeenHealthy = lastHealthyAt();
  const offHealth = subscribeHealth(() => {
    const now = lastHealthyAt();
    if (now <= lastSeenHealthy) return;
    lastSeenHealthy = now;
    scheduleDrain(sender);
  });
  const onOnline = () => scheduleDrain(sender);
  if (hasWindow()) window.addEventListener("online", onOnline);
  const off = () => {
    offHealth();
    if (hasWindow()) window.removeEventListener("online", onOnline);
    if (scheduled !== null) {
      clearTimeout(scheduled);
      scheduled = null;
    }
    if (installed === off) installed = null;
  };
  installed = off;
  return off;
}

/** Tests only: forget everything, including what was persisted. */
export function __resetSendQueue(): void {
  items = [];
  loaded = false;
  views.clear();
  draining = null;
  if (scheduled !== null) {
    clearTimeout(scheduled);
    scheduled = null;
  }
  storage()?.removeItem(STORAGE_KEY);
  for (const fn of listeners) fn();
}

if (hasWindow()) installSendQueueDrain();
