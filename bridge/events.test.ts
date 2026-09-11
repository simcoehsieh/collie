import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  EventHub,
  IDLE_TIMEOUT_S,
  PANE_READ_TTL_MS,
  PaneReads,
  type PaneReader,
  type PokeEvent,
  SSE_PING,
  SSE_PING_MS,
  sseFrame,
} from "./events.ts";
import { computeEtag } from "./http-cache.ts";
import { CODEX_TIMEOUT_MS } from "./stt/codex.ts";

// A fake multiplexer: the text each pane currently shows, and a count of how often it was asked.
function fakeReader(screens: Map<string, string>) {
  const calls: string[] = [];
  const reader: PaneReader = async (paneId, lines) => {
    calls.push(`${paneId}@${lines}`);
    const text = screens.get(paneId);
    if (text === undefined) return { ok: false, detail: `no pane ${paneId}` };
    const data = { paneId, text, truncated: false, revision: 0 };
    const body = JSON.stringify(data);
    return { ok: true, body, data, etag: computeEtag(body) };
  };
  return { reader, calls };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("PaneReads — the cache", () => {
  test("a second read inside the TTL is answered from the first, with the same ETag", async () => {
    let now = 1000;
    const { reader, calls } = fakeReader(new Map([["w1:p1", "hello"]]));
    const reads = new PaneReads(reader, { now: () => now });
    const a = await reads.read("w1:p1", 600);
    now += PANE_READ_TTL_MS - 1;
    const b = await reads.read("w1:p1", 600);
    expect(a.ok && b.ok && a.entry === b.entry).toBe(true);
    expect(calls).toEqual(["w1:p1@600"]);
  });

  test("past the TTL the multiplexer is read again", async () => {
    let now = 1000;
    const { reader, calls } = fakeReader(new Map([["w1:p1", "hello"]]));
    const reads = new PaneReads(reader, { now: () => now });
    await reads.read("w1:p1", 600);
    now += PANE_READ_TTL_MS + 1;
    await reads.read("w1:p1", 600);
    expect(calls).toHaveLength(2);
  });

  test("concurrent reads for one (pane, lines) share a single multiplexer call", async () => {
    const { reader, calls } = fakeReader(new Map([["w1:p1", "hello"]]));
    const reads = new PaneReads(reader);
    const [a, b, c] = await Promise.all([
      reads.read("w1:p1", 600),
      reads.read("w1:p1", 600),
      reads.read("w1:p1", 600),
    ]);
    expect(calls).toEqual(["w1:p1@600"]);
    expect(a.ok && b.ok && c.ok && a.entry === b.entry && b.entry === c.entry).toBe(true);
  });

  test("the window is part of the key: 80 and 600 lines are two reads", async () => {
    const { reader, calls } = fakeReader(new Map([["w1:p1", "hello"]]));
    const reads = new PaneReads(reader);
    await reads.read("w1:p1", 80);
    await reads.read("w1:p1", 600);
    expect(calls).toEqual(["w1:p1@80", "w1:p1@600"]);
  });

  test("invalidate() sends the next read back to the multiplexer, for one pane or all", async () => {
    const { reader, calls } = fakeReader(new Map([["w1:p1", "a"], ["w1:p2", "b"]]));
    const reads = new PaneReads(reader);
    await reads.read("w1:p1", 600);
    await reads.read("w1:p2", 600);
    reads.invalidate("w1:p1");
    await reads.read("w1:p1", 600);
    await reads.read("w1:p2", 600); // still cached
    expect(calls).toEqual(["w1:p1@600", "w1:p2@600", "w1:p1@600"]);
    reads.invalidate();
    await reads.read("w1:p2", 600);
    expect(calls).toHaveLength(4);
  });

  test("a failed read is not cached and carries the multiplexer's detail", async () => {
    const { reader, calls } = fakeReader(new Map());
    const reads = new PaneReads(reader);
    const r = await reads.read("w9:p9", 600);
    expect(r).toEqual({ ok: false, detail: "no pane w9:p9" });
    await reads.read("w9:p9", 600);
    expect(calls).toHaveLength(2);
  });

  test("a reader that throws is a failure, never an unhandled rejection", async () => {
    const reads = new PaneReads(async () => {
      throw new Error("socket closed");
    });
    expect(await reads.read("w1:p1", 600)).toEqual({ ok: false, detail: "socket closed" });
  });
});

describe("PaneReads — the watcher", () => {
  test("a watched pane is re-read on the cadence and a change is announced once, with the new entry", async () => {
    const screens = new Map([["w1:p1", "one"]]);
    const { reader, calls } = fakeReader(screens);
    const reads = new PaneReads(reader, { watchMs: 20 });
    const seen: string[] = [];
    reads.onChange((paneId, entry) => seen.push(`${paneId}:${entry.data.text}`));
    const release = reads.watch(["w1:p1"], 600);
    await tick(35);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(seen).toEqual([]); // nothing moved yet
    screens.set("w1:p1", "two");
    await tick(45);
    expect(seen).toEqual(["w1:p1:two"]);
    release();
    reads.stop();
  });

  test("a read on a watched pane is answered from the watcher's own read — no extra socket call", async () => {
    const { reader, calls } = fakeReader(new Map([["w1:p1", "one"]]));
    const reads = new PaneReads(reader, { watchMs: 20 });
    const release = reads.watch(["w1:p1"], 600);
    await tick(5); // the first sweep runs at once
    const before = calls.length;
    const r = await reads.read("w1:p1", 600);
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(before);
    release();
    reads.stop();
  });

  test("releasing the last interest stops the loop", async () => {
    const { reader, calls } = fakeReader(new Map([["w1:p1", "one"]]));
    const reads = new PaneReads(reader, { watchMs: 10 });
    const a = reads.watch(["w1:p1"], 600);
    const b = reads.watch(["w1:p1"], 600);
    expect(reads.watching()).toBe(1);
    a();
    await tick(25);
    expect(reads.watching()).toBe(1); // b still holds it
    b();
    const at = calls.length;
    await tick(30);
    expect(calls.length).toBe(at);
    expect(reads.watching()).toBe(0);
  });
});

describe("PaneReads — waitForChange (the long-poll)", () => {
  test("resolves the fresh entry the moment the bytes move", async () => {
    const screens = new Map([["w1:p1", "one"]]);
    const { reader } = fakeReader(screens);
    const reads = new PaneReads(reader, { watchMs: 10 });
    const first = await reads.read("w1:p1", 600);
    if (!first.ok) throw new Error("unreachable");
    const started = Date.now();
    setTimeout(() => screens.set("w1:p1", "two"), 15);
    const changed = await reads.waitForChange("w1:p1", 600, first.entry.etag, 500);
    expect(changed?.data.text).toBe("two");
    expect(Date.now() - started).toBeLessThan(200);
    expect(reads.watching()).toBe(0); // the wait's own interest is released
    reads.stop();
  });

  test("resolves null on the deadline when nothing moved, and stops watching", async () => {
    const { reader } = fakeReader(new Map([["w1:p1", "one"]]));
    const reads = new PaneReads(reader, { watchMs: 10 });
    const first = await reads.read("w1:p1", 600);
    if (!first.ok) throw new Error("unreachable");
    expect(await reads.waitForChange("w1:p1", 600, first.entry.etag, 40)).toBeNull();
    expect(reads.watching()).toBe(0);
    reads.stop();
  });

  test("answers at once when what is held already differs from the client's tag", async () => {
    const { reader } = fakeReader(new Map([["w1:p1", "one"]]));
    const reads = new PaneReads(reader);
    await reads.read("w1:p1", 600);
    const entry = await reads.waitForChange("w1:p1", 600, '"stale"', 1000);
    expect(entry?.data.text).toBe("one");
  });
});

describe("EventHub — the fan-out", () => {
  test("a snapshot poke reaches every stream; a pane poke only the streams following that pane", () => {
    const hub = new EventHub();
    const a: PokeEvent[] = [];
    const b: PokeEvent[] = [];
    const home: PokeEvent[] = [];
    hub.subscribe({ paneIds: new Set(["w1:p1"]), send: (e) => a.push(e) });
    hub.subscribe({ paneIds: new Set(["w1:p2"]), send: (e) => b.push(e) });
    hub.subscribe({ paneIds: new Set(), send: (e) => home.push(e) });
    hub.pokeSnapshot();
    hub.pokePane("w1:p1");
    expect(a).toEqual([{ kind: "snapshot" }, { kind: "pane", paneId: "w1:p1" }]);
    expect(b).toEqual([{ kind: "snapshot" }]);
    expect(home).toEqual([{ kind: "snapshot" }]);
  });

  test("one stream may follow SEVERAL panes — the Overview grid", () => {
    const hub = new EventHub();
    const grid: PokeEvent[] = [];
    const one: PokeEvent[] = [];
    hub.subscribe({ paneIds: new Set(["w1:p1", "w1:p2", "w2:p1"]), send: (e) => grid.push(e) });
    hub.subscribe({ paneIds: new Set(["w1:p2"]), send: (e) => one.push(e) });
    hub.pokePane("w1:p2");
    hub.pokePane("w2:p1");
    hub.pokePane("w9:p9"); // nobody follows it
    expect(grid).toEqual([
      { kind: "pane", paneId: "w1:p2" },
      { kind: "pane", paneId: "w2:p1" },
    ]);
    expect(one).toEqual([{ kind: "pane", paneId: "w1:p2" }]);
  });

  test("a version stamp rides the poke when the caller has one, and NO key when it does not", () => {
    const hub = new EventHub();
    const got: PokeEvent[] = [];
    hub.subscribe({ paneIds: new Set(["w1:p1"]), send: (e) => got.push(e) });
    hub.pokeSnapshot('"abc"');
    hub.pokePane("w1:p1", '"def"');
    hub.pokeSnapshot();
    hub.pokePane("w1:p1");
    expect(got).toEqual([
      { kind: "snapshot", etag: '"abc"' },
      { kind: "pane", paneId: "w1:p1", etag: '"def"' },
      { kind: "snapshot" },
      { kind: "pane", paneId: "w1:p1" },
    ]);
    // An unstamped poke is byte-for-byte the frame that shipped before the stamp existed.
    expect(sseFrame(got[2]!)).toBe('event: poke\ndata: {"kind":"snapshot"}\n\n');
  });

  test("unsubscribing stops delivery, and a throwing stream does not break the others", () => {
    const hub = new EventHub();
    const got: PokeEvent[] = [];
    hub.subscribe({
      paneIds: new Set<string>(),
      send: () => {
        throw new Error("socket gone");
      },
    });
    const off = hub.subscribe({ paneIds: new Set<string>(), send: (e) => got.push(e) });
    hub.pokeSnapshot();
    expect(got).toHaveLength(1);
    off();
    hub.pokeSnapshot();
    expect(got).toHaveLength(1);
    expect(hub.size()).toBe(1);
  });
});

describe("the wire format", () => {
  test("a poke is one named event with a JSON data line", () => {
    expect(sseFrame({ kind: "snapshot" })).toBe('event: poke\ndata: {"kind":"snapshot"}\n\n');
    expect(sseFrame({ kind: "pane", paneId: "w1:p1" })).toBe(
      'event: poke\ndata: {"kind":"pane","paneId":"w1:p1"}\n\n',
    );
  });

  test("a stamped poke puts the version last, so the old fields keep their place", () => {
    expect(sseFrame({ kind: "snapshot", etag: '"7f"' })).toBe(
      'event: poke\ndata: {"kind":"snapshot","etag":"\\"7f\\""}\n\n',
    );
    expect(sseFrame({ kind: "pane", paneId: "w1:p1", etag: '"7f"' })).toBe(
      'event: poke\ndata: {"kind":"pane","paneId":"w1:p1","etag":"\\"7f\\""}\n\n',
    );
  });

  test("the keepalive is a comment, which EventSource ignores", () => {
    expect(SSE_PING.startsWith(":")).toBe(true);
    expect(SSE_PING.endsWith("\n\n")).toBe(true);
  });
});

// ── The defect this pins (2026-09-11) ─────────────────────────────────────────
// The feed shipped with a 15 s ping under a runtime whose idle timeout defaults to 10 s, so every
// stream over a quiet herd died at ~9 s and reconnected on `retry: 3000` — forever. Nothing in the
// suite could have caught it, because the two numbers lived in different files and only one of them
// was written down at all. Both are here now, and so is the assertion that they are ordered.
describe("the ping beats the idle timeout", () => {
  test("the keepalive fires several times inside the runtime's idle window", () => {
    const idleMs = IDLE_TIMEOUT_S * 1000;
    expect(SSE_PING_MS).toBeLessThan(idleMs);
    // Not merely "less than": a single ping landing just inside the window is one scheduling hiccup
    // away from the bug. Ten of them fit.
    expect(SSE_PING_MS * 10).toBeLessThanOrEqual(idleMs);
  });

  test("the ping also clears Cloudflare's 100 s idle cut and the browser's own reconnect", () => {
    expect(SSE_PING_MS).toBeLessThan(100_000);
  });

  test("the idle timeout covers the longest request the bridge holds open without writing", () => {
    // The codex STT transcription deadline (bridge/stt/codex.ts CODEX_TIMEOUT_MS). While it runs,
    // the bridge has read the whole body and is waiting on a provider: no byte moves either way.
    expect(IDLE_TIMEOUT_S * 1000).toBeGreaterThan(CODEX_TIMEOUT_MS);
    // Bun's own ceiling for the option.
    expect(IDLE_TIMEOUT_S).toBeLessThanOrEqual(255);
  });

  test("server.ts hands it to Bun.serve rather than inheriting the runtime default", () => {
    const src = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
    expect(src).toContain("idleTimeout: IDLE_TIMEOUT_S,");
  });
});
