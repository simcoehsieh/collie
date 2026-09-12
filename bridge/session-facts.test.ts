import { describe, expect, test } from "bun:test";

import type { AgentSessionRef, JournalAdapter, SessionFacts, TranscriptSource } from "./journal/types.ts";
import { FACTS_REFRESH_MS, FACTS_TAIL_BYTES, SessionFactsStore, sessionFactsKey } from "./session-facts.ts";

// FORK — the read-through cache behind a pane's `model` / `effort` (bridge/session-facts.ts). Same
// claims the status-line store makes, plus the one this store adds: an unchanged log is not re-read.

const ref: AgentSessionRef = { kind: "id", value: "abc-123" };

/** A fake source + adapter whose "log" is a string the test controls, with call counters. */
function fake(opts: { path?: string | null; facts?: SessionFacts | null } = {}) {
  const state = {
    text: "",
    size: 0,
    mtimeMs: 1,
    resolves: 0,
    stats: 0,
    tails: 0,
    parses: 0,
    path: opts.path === undefined ? "/logs/abc.jsonl" : opts.path,
  };
  const source: TranscriptSource = {
    resolve: () => {
      state.resolves++;
      return Promise.resolve(state.path);
    },
    stat: () => {
      state.stats++;
      return Promise.resolve(state.path === null ? null : { size: state.size, mtimeMs: state.mtimeMs });
    },
    load: () => Promise.reject(new Error("the facts store must never load a whole log")),
  };
  const adapter: JournalAdapter = {
    agent: "claude",
    source,
    parse: () => [],
    facts: (text) => {
      state.parses++;
      if (opts.facts !== undefined) return opts.facts;
      const m = /model=(\S+) effort=(\S+)/.exec(text);
      return m ? { model: m[1] ?? "", effort: m[2] ?? "" } : null;
    },
  };
  const tail = (_path: string, bytes: number) => {
    state.tails++;
    expect(bytes).toBe(FACTS_TAIL_BYTES);
    return Promise.resolve(state.text);
  };
  const write = (text: string) => {
    state.text = text;
    state.size = text.length;
    state.mtimeMs += 1;
  };
  return { state, adapter, tail, write };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("SessionFactsStore", () => {
  test("answers null on the first read, then the log's facts one poll later", async () => {
    const f = fake();
    f.write("model=claude-fable-5-1 effort=xhigh");
    let now = 1000;
    const store = new SessionFactsStore({ now: () => now, tail: f.tail });
    expect(store.get(f.adapter, ref)).toBeNull();
    await settle();
    expect(store.get(f.adapter, ref)).toEqual({ model: "claude-fable-5-1", effort: "xhigh" });
    expect(f.state.tails).toBe(1);
    // Within the refresh window: served from the map, no fs at all.
    now += FACTS_REFRESH_MS - 1;
    store.get(f.adapter, ref);
    await settle();
    expect(f.state.resolves).toBe(1);
    expect(f.state.stats).toBe(1);
  });

  test("an unchanged log is stat-ed but not re-read; a grown one is", async () => {
    const f = fake();
    f.write("model=claude-fable-5-1 effort=xhigh");
    let now = 1000;
    const store = new SessionFactsStore({ now: () => now, tail: f.tail });
    store.get(f.adapter, ref);
    await settle();
    now += FACTS_REFRESH_MS;
    store.get(f.adapter, ref);
    await settle();
    expect(f.state.stats).toBe(2);
    expect(f.state.tails).toBe(1);
    // The operator ran /model: the log grew, and the next refresh reads the new tail.
    f.write("model=claude-opus-5 effort=high");
    now += FACTS_REFRESH_MS;
    store.get(f.adapter, ref);
    await settle();
    expect(f.state.tails).toBe(2);
    expect(store.get(f.adapter, ref)).toEqual({ model: "claude-opus-5", effort: "high" });
  });

  test("holds the last answer when the tail says nothing, when the read fails, and when the log is gone", async () => {
    const f = fake();
    f.write("model=claude-fable-5-1 effort=xhigh");
    let now = 1000;
    let explode = false;
    const store = new SessionFactsStore({
      now: () => now,
      tail: (path, bytes) => (explode ? Promise.reject(new Error("EIO")) : f.tail(path, bytes)),
    });
    store.get(f.adapter, ref);
    await settle();
    // A burst of tool output: the window holds no assistant row.
    f.write("just a huge tool result with no model in it");
    now += FACTS_REFRESH_MS;
    store.get(f.adapter, ref);
    await settle();
    expect(store.get(f.adapter, ref)).toEqual({ model: "claude-fable-5-1", effort: "xhigh" });
    // The read throws.
    explode = true;
    f.write("model=claude-opus-5 effort=high");
    now += FACTS_REFRESH_MS;
    store.get(f.adapter, ref);
    await settle();
    expect(store.get(f.adapter, ref)).toEqual({ model: "claude-fable-5-1", effort: "xhigh" });
    // The log is gone.
    explode = false;
    f.state.path = null;
    now += FACTS_REFRESH_MS;
    store.get(f.adapter, ref);
    await settle();
    expect(store.get(f.adapter, ref)).toEqual({ model: "claude-fable-5-1", effort: "xhigh" });
  });

  test("answers null, and schedules nothing, for an adapter with no facts reader", async () => {
    const f = fake();
    const bare: JournalAdapter = { agent: "pi", source: f.adapter.source, parse: () => [] };
    const store = new SessionFactsStore({ tail: f.tail });
    expect(store.get(bare, ref)).toBeNull();
    await settle();
    expect(f.state.resolves).toBe(0);
  });

  test("coalesces N panes' reads of one log into one refresh", async () => {
    const f = fake();
    f.write("model=gpt-6-astra effort=medium");
    const store = new SessionFactsStore({ tail: f.tail });
    store.get(f.adapter, ref);
    store.get(f.adapter, ref);
    store.get(f.adapter, ref);
    await settle();
    expect(f.state.resolves).toBe(1);
    expect(f.state.tails).toBe(1);
  });

  test("keys by harness as well as by ref — the same id under two adapters is two logs", () => {
    expect(sessionFactsKey("claude", ref)).not.toBe(sessionFactsKey("codex", ref));
    expect(sessionFactsKey("claude", { kind: "path", value: "/x" })).not.toBe(sessionFactsKey("claude", { kind: "id", value: "/x" }));
  });
});
