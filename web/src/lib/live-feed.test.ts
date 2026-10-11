import { act, renderHook } from "@testing-library/react";

import {
  __resetLiveFeed,
  __setLiveFeedSupported,
  isLiveFeedHealthy,
  LIVE_FEED_RETRY_MAX_MS,
  LIVE_FEED_RETRY_MS,
  liveFeedAvailable,
  liveFeedUrl,
  openLiveFeed,
  parsePoke,
  readEventStream,
  type Poke,
  useLiveFeedHealthy,
} from "./live-feed";
import { setDeviceToken } from "./pairing";
import { FakeEventStream, flushStream, installFakeEventStream } from "@/test/fake-event-stream";

let uninstall: () => void = () => {};

beforeEach(() => {
  __resetLiveFeed();
  uninstall = installFakeEventStream();
});

afterEach(() => {
  uninstall();
  __resetLiveFeed();
  vi.useRealTimers();
});

describe("liveFeedUrl", () => {
  it("names the session and the followed pane at its window, and nothing else", () => {
    expect(liveFeedUrl()).toBe("/api/events");
    expect(liveFeedUrl({ session: "demo" })).toBe("/api/events?session=demo");
    expect(liveFeedUrl(undefined, "w1:p1", 200)).toBe("/api/events?pane=w1%3Ap1&lines=200");
    expect(liveFeedUrl({ session: "demo" }, "w1:p1")).toBe("/api/events?session=demo&pane=w1%3Ap1");
    expect(liveFeedUrl(undefined, null, 200)).toBe("/api/events");
  });

  // FORK: the Overview grid names every visible card on the ONE stream the page already has.
  it("repeats `pane` for a set, at one shared window", () => {
    expect(liveFeedUrl(undefined, ["w1:p1", "w1:p2", "w2:p1"], 12)).toBe(
      "/api/events?pane=w1%3Ap1&pane=w1%3Ap2&pane=w2%3Ap1&lines=12",
    );
    expect(liveFeedUrl({ session: "demo" }, ["w1:p1"], 12)).toBe(
      "/api/events?session=demo&pane=w1%3Ap1&lines=12",
    );
    // An empty set is the herd-only stream, and carries no window to be read at.
    expect(liveFeedUrl(undefined, [], 12)).toBe("/api/events");
  });
});

describe("liveFeedAvailable", () => {
  it("is available for the lead's own sessions and never for a member host", () => {
    expect(liveFeedAvailable()).toBe(true);
    expect(liveFeedAvailable({ session: "demo" })).toBe(true);
    expect(liveFeedAvailable({ host: "badger" })).toBe(false);
  });

  it("is unavailable where the platform cannot stream (and, by default, under the test runner)", () => {
    __setLiveFeedSupported(false);
    expect(liveFeedAvailable()).toBe(false);
    __setLiveFeedSupported(null);
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

  // FORK: the version stamp. A poke that carries one names the bytes it is about, so the page can
  // skip a fetch it can prove would 304 (hooks/use-polling.ts `alreadyHeld`).
  it("reads the version stamp when the bridge sent one", () => {
    expect(parsePoke('{"kind":"snapshot","etag":"\\"7f\\""}')).toEqual({
      kind: "snapshot",
      etag: '"7f"',
    });
    expect(parsePoke('{"kind":"pane","paneId":"w1:p1","etag":"\\"7f\\""}')).toEqual({
      kind: "pane",
      paneId: "w1:p1",
      etag: '"7f"',
    });
  });

  it("leaves the key OFF when the bridge sent none, or sent something that is not a string", () => {
    expect("etag" in parsePoke('{"kind":"snapshot"}')!).toBe(false);
    expect("etag" in parsePoke('{"kind":"snapshot","etag":3}')!).toBe(false);
    expect("etag" in parsePoke('{"kind":"snapshot","etag":""}')!).toBe(false);
    expect("etag" in parsePoke('{"kind":"pane","paneId":"w1:p1"}')!).toBe(false);
  });
});

/** A body that yields `chunks` one read at a time. */
function bodyOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

describe("readEventStream", () => {
  it("reassembles frames split across chunks, mid-line and mid-field, and skips comments", async () => {
    const events: [string, string][] = [];
    const retries: number[] = [];
    await readEventStream(
      bodyOf([
        "retry: 25",
        "00\n\n: ping\n\nevent: po",
        'ke\ndata: {"kind":"sna',
        'pshot"}\n',
        "\nevent: poke\r\ndata: a\r",
        "\ndata: b\r\n\r\n",
        "data: cut off at the end",
      ]),
      (type, data) => events.push([type, data]),
      (ms) => retries.push(ms),
    );
    expect(retries).toEqual([2500]);
    expect(events).toEqual([
      ["poke", '{"kind":"snapshot"}'],
      ["poke", "a\nb"],
    ]);
  });
});

describe("openLiveFeed", () => {
  it("sends the pairing token and the XHR header, as every other /api read does", async () => {
    setDeviceToken("tok-feed");
    openLiveFeed("/api/events?pane=w1%3Ap1", { onPoke: () => {}, onHealth: () => {} });
    await flushStream();
    const stream = FakeEventStream.last!;
    expect(stream.url).toBe("/api/events?pane=w1%3Ap1");
    expect(stream.headers.get("authorization")).toBe("Bearer tok-feed");
    expect(stream.headers.get("x-requested-with")).toBe("XMLHttpRequest");
  });

  it("reports open and drop once each, marks the shared flag, and delivers pokes", async () => {
    const pokes: Poke[] = [];
    const health: boolean[] = [];
    const feed = openLiveFeed("/api/events", { onPoke: (p) => pokes.push(p), onHealth: (h) => health.push(h) });
    await flushStream();
    const stream = FakeEventStream.last!;
    expect(isLiveFeedHealthy()).toBe(false);
    stream.open();
    await flushStream();
    expect(health).toEqual([true]);
    expect(isLiveFeedHealthy()).toBe(true);
    stream.write('event: poke\ndata: {"kind":"pane",');
    stream.write('"paneId":"w1:p1"}\n\n');
    stream.poke("garbage");
    stream.write('data: {"kind":"snapshot"}\n\n'); // an unnamed event is not a poke
    await flushStream();
    expect(pokes).toEqual([{ kind: "pane", paneId: "w1:p1" }]);
    stream.end();
    await flushStream();
    expect(health).toEqual([true, false]);
    expect(isLiveFeedHealthy()).toBe(false);
    feed.close();
  });

  it("a refusal is the stream being down, retried on a doubling backoff until it opens", async () => {
    vi.useFakeTimers();
    const health: boolean[] = [];
    const feed = openLiveFeed("/api/events", { onPoke: () => {}, onHealth: (h) => health.push(h) });
    await flushStream();
    FakeEventStream.last!.refuse(403);
    await flushStream();
    expect(isLiveFeedHealthy()).toBe(false);
    expect(FakeEventStream.all).toHaveLength(1);

    vi.advanceTimersByTime(LIVE_FEED_RETRY_MS - 1);
    expect(FakeEventStream.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await flushStream();
    expect(FakeEventStream.all).toHaveLength(2); // the first retry, after the bridge's 3 s

    FakeEventStream.last!.drop(); // a transport failure counts the same
    await flushStream();
    vi.advanceTimersByTime(LIVE_FEED_RETRY_MS * 2 - 1);
    expect(FakeEventStream.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    await flushStream();
    expect(FakeEventStream.all).toHaveLength(3); // doubled

    FakeEventStream.last!.open();
    await flushStream();
    expect(health).toEqual([true]);
    expect(isLiveFeedHealthy()).toBe(true);
    feed.close();
  });

  it("caps the backoff, and after a stream that opened starts again from the base", async () => {
    vi.useFakeTimers();
    const feed = openLiveFeed("/api/events", { onPoke: () => {}, onHealth: () => {} });
    for (let i = 0; i < 8; i++) {
      await flushStream();
      FakeEventStream.last!.refuse(403);
      await flushStream();
      vi.advanceTimersByTime(LIVE_FEED_RETRY_MAX_MS);
    }
    await flushStream();
    expect(FakeEventStream.all).toHaveLength(9); // one per cap-sized wait, never a longer one
    FakeEventStream.last!.open();
    await flushStream();
    FakeEventStream.last!.end();
    await flushStream();
    vi.advanceTimersByTime(LIVE_FEED_RETRY_MS);
    await flushStream();
    expect(FakeEventStream.all).toHaveLength(10);
    feed.close();
  });

  it("follows the bridge's retry: for the next reconnect", async () => {
    vi.useFakeTimers();
    const feed = openLiveFeed("/api/events", { onPoke: () => {}, onHealth: () => {} });
    await flushStream();
    FakeEventStream.last!.open();
    await flushStream();
    FakeEventStream.last!.write("retry: 500\n\n");
    FakeEventStream.last!.end();
    await flushStream();
    vi.advanceTimersByTime(500);
    await flushStream();
    expect(FakeEventStream.all).toHaveLength(2);
    feed.close();
  });

  it("close aborts the open stream, reports the drop, and never reconnects", async () => {
    vi.useFakeTimers();
    const health: boolean[] = [];
    const feed = openLiveFeed("/api/events", { onPoke: () => {}, onHealth: (h) => health.push(h) });
    await flushStream();
    const stream = FakeEventStream.last!;
    stream.open();
    await flushStream();
    feed.close();
    await flushStream();
    expect(stream.aborted).toBe(true);
    expect(health).toEqual([true, false]);
    expect(isLiveFeedHealthy()).toBe(false);
    vi.advanceTimersByTime(LIVE_FEED_RETRY_MAX_MS * 2);
    await flushStream();
    expect(FakeEventStream.all).toHaveLength(1);
  });

  it("close during a pending answer aborts it, and a retry timer is cancelled", async () => {
    vi.useFakeTimers();
    const feed = openLiveFeed("/api/events", { onPoke: () => {}, onHealth: () => {} });
    await flushStream();
    FakeEventStream.last!.refuse(403);
    await flushStream();
    feed.close(); // the retry timer is pending
    vi.advanceTimersByTime(LIVE_FEED_RETRY_MAX_MS);
    await flushStream();
    expect(FakeEventStream.all).toHaveLength(1);

    const again = openLiveFeed("/api/events", { onPoke: () => {}, onHealth: () => {} });
    await flushStream();
    again.close(); // the fetch has not been answered
    await flushStream();
    expect(FakeEventStream.last!.aborted).toBe(true);
  });

  it("the hook view follows the flag", async () => {
    const { result } = renderHook(() => useLiveFeedHealthy());
    expect(result.current).toBe(false);
    const feed = openLiveFeed("/api/events", { onPoke: () => {}, onHealth: () => {} });
    await act(async () => {
      await flushStream();
      FakeEventStream.last!.open();
      await flushStream();
    });
    expect(result.current).toBe(true);
    act(() => feed.close());
    expect(result.current).toBe(false);
  });
});

