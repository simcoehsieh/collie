import { act, renderHook } from "@testing-library/react";

import {
  __resetLiveFeed,
  isLiveFeedHealthy,
  liveFeedAvailable,
  liveFeedUrl,
  openLiveFeed,
  parsePoke,
  type Poke,
  useLiveFeedHealthy,
} from "./live-feed";

// jsdom ships no EventSource. The fake below is the four members the client touches, and it keeps
// the last instance reachable so a test can drive the stream from outside.
class FakeEventSource {
  static last: FakeEventSource | null = null;
  static CLOSED = 2;
  readyState = 0;
  closed = false;
  private handlers = new Map<string, Set<(e: Event) => void>>();
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (e: Event) => void): void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(fn);
  }
  emit(type: string, data?: string): void {
    const event = data === undefined ? new Event(type) : new MessageEvent(type, { data });
    for (const fn of this.handlers.get(type) ?? []) fn(event);
  }
  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}

beforeEach(() => {
  Object.assign(globalThis, { EventSource: FakeEventSource });
  __resetLiveFeed();
});

afterEach(() => {
  __resetLiveFeed();
});

describe("liveFeedUrl", () => {
  it("names the session and the followed pane at its window, and nothing else", () => {
    expect(liveFeedUrl()).toBe("/api/events");
    expect(liveFeedUrl({ session: "demo" })).toBe("/api/events?session=demo");
    expect(liveFeedUrl(undefined, "w1:p1", 200)).toBe("/api/events?pane=w1%3Ap1&lines=200");
    expect(liveFeedUrl({ session: "demo" }, "w1:p1")).toBe("/api/events?session=demo&pane=w1%3Ap1");
    expect(liveFeedUrl(undefined, null, 200)).toBe("/api/events");
  });
});

describe("liveFeedAvailable", () => {
  it("is available for the lead's own sessions and never for a member host", () => {
    expect(liveFeedAvailable()).toBe(true);
    expect(liveFeedAvailable({ session: "demo" })).toBe(true);
    expect(liveFeedAvailable({ host: "badger" })).toBe(false);
  });

  it("is unavailable where the platform has no EventSource", () => {
    Object.assign(globalThis, { EventSource: undefined });
    expect(liveFeedAvailable()).toBe(false);
  });
});

describe("parsePoke", () => {
  it("accepts the two shapes and drops everything else", () => {
    expect(parsePoke('{"kind":"snapshot"}')).toEqual({ kind: "snapshot" });
    expect(parsePoke('{"kind":"pane","paneId":"w1:p1"}')).toEqual({ kind: "pane", paneId: "w1:p1" });
    expect(parsePoke('{"kind":"pane"}')).toBeNull();
    expect(parsePoke('{"kind":"pane","paneId":""}')).toBeNull();
    expect(parsePoke('{"kind":"other"}')).toBeNull();
    expect(parsePoke("not json")).toBeNull();
    expect(parsePoke("[]")).toBeNull();
  });
});

describe("openLiveFeed", () => {
  it("reports open and drop once each, marks the shared flag, and delivers pokes", () => {
    const pokes: Poke[] = [];
    const health: boolean[] = [];
    const feed = openLiveFeed("/api/events", { onPoke: (p) => pokes.push(p), onHealth: (h) => health.push(h) });
    const source = FakeEventSource.last!;
    expect(isLiveFeedHealthy()).toBe(false);
    source.emit("open");
    source.emit("open"); // a duplicate is not a transition
    expect(health).toEqual([true]);
    expect(isLiveFeedHealthy()).toBe(true);
    source.emit("poke", '{"kind":"pane","paneId":"w1:p1"}');
    source.emit("poke", "garbage");
    expect(pokes).toEqual([{ kind: "pane", paneId: "w1:p1" }]);
    source.emit("error");
    expect(health).toEqual([true, false]);
    expect(isLiveFeedHealthy()).toBe(false);
    feed.close();
    expect(source.closed).toBe(true);
  });

  it("closing an open stream reports the drop", () => {
    const health: boolean[] = [];
    const feed = openLiveFeed("/api/events", { onPoke: () => {}, onHealth: (h) => health.push(h) });
    FakeEventSource.last!.emit("open");
    feed.close();
    expect(health).toEqual([true, false]);
    expect(isLiveFeedHealthy()).toBe(false);
  });

  it("the hook view follows the flag", () => {
    const { result } = renderHook(() => useLiveFeedHealthy());
    expect(result.current).toBe(false);
    openLiveFeed("/api/events", { onPoke: () => {}, onHealth: () => {} });
    act(() => FakeEventSource.last!.emit("open"));
    expect(result.current).toBe(true);
  });
});
