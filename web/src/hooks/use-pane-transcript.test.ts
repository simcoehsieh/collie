import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { usePaneTranscript } from "./use-pane-transcript";
import type { TranscriptEntry } from "@/lib/types";

// Chat mode's reader. The load-bearing claims are the CADENCE (it must never join the 1.5 s poll —
// a fetch re-parses the agent's whole log bridge-side) and the PAGING bookkeeping (a refresh of the
// newest page has to coexist with pages the reader already walked back to).

const turn = (uuid: string, text: string): TranscriptEntry => ({
  uuid,
  ts: "2026-09-11T09:00:00.000Z",
  role: "assistant",
  parts: [{ kind: "text", text }],
});

interface Served {
  /** Every request's query, in order — the whole record of what the hook asked for. */
  asks: URLSearchParams[];
}

/** Serve the history route from a function of the `before` cursor. */
function serveHistory(pages: (before: string | null) => TranscriptEntry[], hasMore = false): Served {
  const asks: URLSearchParams[] = [];
  server.use(
    http.get(/\/api\/pane\/[^/]+\/history/, ({ request }) => {
      const query = new URL(request.url).searchParams;
      asks.push(query);
      const entries = pages(query.get("before"));
      return HttpResponse.json({
        paneId: "w1:p1",
        available: true,
        entries,
        hasMore: query.get("before") === null ? hasMore : false,
        total: entries.length,
        fileTruncated: false,
      });
    }),
  );
  return { asks };
}

describe("usePaneTranscript", () => {
  it("opens on the newest turns without waiting out the settle timer", async () => {
    serveHistory(() => [turn("a", "first"), turn("b", "second")]);
    const { result } = renderHook(() =>
      usePaneTranscript({ paneId: "w1:p1", enabled: true, mirrorText: "screen" }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.entries.map((e) => e.uuid)).toEqual(["a", "b"]);
  });

  it("fetches nothing at all while it is switched off", async () => {
    const served = serveHistory(() => [turn("a", "first")]);
    const { result } = renderHook(() =>
      usePaneTranscript({ paneId: "w1:p1", enabled: false, mirrorText: "screen" }),
    );
    await waitFor(() => expect(result.current.entries).toEqual([]));
    expect(served.asks).toHaveLength(0);
  });

  // THE CADENCE. A mirror that keeps changing is a message still streaming; only stillness is a
  // finished one. Without this the hook would re-parse a 32 MB log on every poll.
  it("does not re-read while the mirror is still moving", async () => {
    const served = serveHistory(() => [turn("a", "first")]);
    const { result, rerender } = renderHook(
      ({ mirrorText }) => usePaneTranscript({ paneId: "w1:p1", enabled: true, mirrorText }),
      { initialProps: { mirrorText: "frame 1" } },
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(served.asks).toHaveLength(1);
    for (const frame of ["frame 2", "frame 3", "frame 4"]) rerender({ mirrorText: frame });
    // Each change restarts the settle timer, so nothing has settled and nothing is re-read.
    expect(served.asks).toHaveLength(1);
  });

  it("re-reads once the mirror has held still", async () => {
    vi.useFakeTimers();
    try {
      const served = serveHistory(() => [turn("a", "first")]);
      const { rerender } = renderHook(
        ({ mirrorText }) => usePaneTranscript({ paneId: "w1:p1", enabled: true, mirrorText }),
        { initialProps: { mirrorText: "frame 1" } },
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(served.asks).toHaveLength(1);
      rerender({ mirrorText: "the finished message" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(served.asks).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("walks back with a cursor and keeps the pages in order", async () => {
    const served = serveHistory(
      (before) => (before === null ? [turn("c", "newest")] : [turn("a", "oldest"), turn("b", "middle")]),
      true,
    );
    const { result } = renderHook(() =>
      usePaneTranscript({ paneId: "w1:p1", enabled: true, mirrorText: "screen" }),
    );
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.entries).toHaveLength(3));
    expect(result.current.entries.map((e) => e.uuid)).toEqual(["a", "b", "c"]);
    expect(served.asks.at(-1)?.get("before")).toBe("c");
    // The walk is finished, so the button stands down.
    await waitFor(() => expect(result.current.hasMore).toBe(false));
  });

  // A refresh of the newest page can re-deliver turns an older page already holds. `base` is the
  // fresher read of the same rows, so the older half yields — or the thread grows a duplicate per
  // finished message.
  it("does not duplicate a turn that a refresh re-delivers", async () => {
    vi.useFakeTimers();
    try {
      serveHistory(
        (before) => (before === null ? [turn("b", "middle"), turn("c", "newest")] : [turn("a", "oldest"), turn("b", "middle")]),
        true,
      );
      const { result, rerender } = renderHook(
        ({ mirrorText }) => usePaneTranscript({ paneId: "w1:p1", enabled: true, mirrorText }),
        { initialProps: { mirrorText: "frame 1" } },
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      act(() => result.current.loadOlder());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      rerender({ mirrorText: "settled" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(result.current.entries.map((e) => e.uuid)).toEqual(["a", "b", "c"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops everything on a pane switch rather than showing the last pane's thread", async () => {
    serveHistory(() => [turn("a", "first")]);
    const { result, rerender } = renderHook(
      ({ paneId }) => usePaneTranscript({ paneId, enabled: true, mirrorText: "screen" }),
      { initialProps: { paneId: "w1:p1" } },
    );
    await waitFor(() => expect(result.current.entries).toHaveLength(1));

    server.use(
      http.get(/\/api\/pane\/[^/]+\/history/, () =>
        HttpResponse.json({ paneId: "w1:p2", available: false, reason: "no-log" }),
      ),
    );
    rerender({ paneId: "w1:p2" });
    expect(result.current.entries).toEqual([]);
    await waitFor(() => expect(result.current.unavailable).toBe(true));
  });

  it("says `unavailable` rather than `empty` when the bridge has no journal for the pane", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/history/, () =>
        HttpResponse.json({ paneId: "w1:p1", available: false, reason: "no-session" }),
      ),
    );
    const { result } = renderHook(() =>
      usePaneTranscript({ paneId: "w1:p1", enabled: true, mirrorText: "screen" }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.unavailable).toBe(true);
    expect(result.current.entries).toEqual([]);
  });

  it("keeps what it holds when a read fails", async () => {
    vi.useFakeTimers();
    try {
      serveHistory(() => [turn("a", "first")]);
      const { result, rerender } = renderHook(
        ({ mirrorText }) => usePaneTranscript({ paneId: "w1:p1", enabled: true, mirrorText }),
        { initialProps: { mirrorText: "frame 1" } },
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.entries).toHaveLength(1);

      server.use(http.get(/\/api\/pane\/[^/]+\/history/, () => HttpResponse.error()));
      rerender({ mirrorText: "settled" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(result.current.entries.map((e) => e.uuid)).toEqual(["a"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
