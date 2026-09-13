import { beforeEach, describe, expect, it, vi } from "vitest";

import { __resetConnectionHealth, markLive } from "./connection-health";
import type { ReplyOutcome } from "./reply-action";
import { classifySendFailure } from "./send-failure";
import {
  __resetSendQueue,
  discardSend,
  drainSendQueue,
  enqueueSend,
  installSendQueueDrain,
  QUEUE_ITEM_BYTES,
  QUEUE_MAX_ITEMS,
  QUEUE_TTL_MS,
  queuedForPane,
  queuedKeys,
  type QueuedSend,
} from "./send-queue";
import { clearStatus } from "./status";

/** The last status line, `""` for none — a mock, so the drain's report is readable here. */
const statusSpy = vi.hoisted(() => ({ last: "" }));
vi.mock("./status", () => ({
  setStatus: (text: string) => {
    statusSpy.last = text;
  },
  clearStatus: () => {
    statusSpy.last = "";
  },
}));

// The queue's three promises: a link failure is kept and a refusal is not; what was kept comes
// back after a reload and leaves after a day; and the drain sends in order, stops a pane at the
// first refusal, and never sends an answer on its own.

class FakeApiError extends Error {
  status: number;
  constructor(code: number) {
    super(`→ ${code}`);
    this.name = "ApiError";
    this.status = code;
  }
}

beforeEach(() => {
  __resetSendQueue();
  __resetConnectionHealth();
  clearStatus();
});

describe("classifySendFailure", () => {
  it("names the link's failures and nothing else", () => {
    const type = new TypeError("Failed to fetch");
    expect(classifySendFailure(type)).toBe("network");
    const timeout = new DOMException("timed out", "TimeoutError");
    expect(classifySendFailure(timeout)).toBe("network");
    expect(classifySendFailure(new Error("prompt moved"))).toBeNull();
    expect(classifySendFailure("string")).toBeNull();
  });

  it("reads a status off the API client's own throw only", () => {
    // Not the client's class, so no status is read: a look-alike is a plain Error.
    expect(classifySendFailure(new FakeApiError(502))).toBeNull();
  });
});

describe("the store", () => {
  it("keeps a send per pane, in order, and reads it back from storage after a reload", () => {
    const now = Date.now();
    enqueueSend({ paneId: "w1:p1", text: "first", kind: "message", agent: "claude" }, now - 3_000);
    enqueueSend({ paneId: "w1:p1", text: "second", kind: "message", agent: "claude" }, now - 2_000);
    enqueueSend({ paneId: "w1:p2", text: "other", kind: "message", agent: null }, now - 1_000);
    expect(queuedForPane(undefined, "w1:p1").map((r) => r.text)).toEqual(["first", "second"]);
    expect(queuedKeys()).toHaveLength(2);
    const before = queuedForPane(undefined, "w1:p1");
    expect(queuedForPane(undefined, "w1:p1")).toBe(before); // stable while nothing changed

    // A reload: the module forgets, storage remembers.
    const raw = localStorage.getItem("collie:send-queue:v1");
    __resetSendQueue();
    localStorage.setItem("collie:send-queue:v1", raw!);
    expect(queuedForPane(undefined, "w1:p1").map((r) => r.text)).toEqual(["first", "second"]);
  });

  it("refuses a message too large to keep, drops the oldest past the cap, and prunes a day-old one", () => {
    expect(enqueueSend({ paneId: "w1:p1", text: "x".repeat(QUEUE_ITEM_BYTES + 1), kind: "message", agent: null })).toBeNull();
    const base = Date.now() - 60_000;
    for (let i = 0; i < QUEUE_MAX_ITEMS + 2; i++) {
      enqueueSend({ paneId: "w1:p1", text: `m${i}`, kind: "message", agent: null }, base + i);
    }
    const rows = queuedForPane(undefined, "w1:p1");
    expect(rows).toHaveLength(QUEUE_MAX_ITEMS);
    expect(rows[0]?.text).toBe("m2");

    __resetSendQueue();
    const later = Date.now();
    enqueueSend({ paneId: "w1:p1", text: "old", kind: "message", agent: null }, later - QUEUE_TTL_MS - 1);
    enqueueSend({ paneId: "w1:p1", text: "new", kind: "message", agent: null }, later);
    expect(queuedForPane(undefined, "w1:p1").map((r) => r.text)).toEqual(["new"]);
  });

  it("discard removes one row and leaves the rest", () => {
    const a = enqueueSend({ paneId: "w1:p1", text: "a", kind: "message", agent: null })!;
    enqueueSend({ paneId: "w1:p1", text: "b", kind: "message", agent: null });
    discardSend(a.id);
    expect(queuedForPane(undefined, "w1:p1").map((r) => r.text)).toEqual(["b"]);
  });
});

describe("the drain", () => {
  function sender(outcomes: Record<string, ReplyOutcome>, log: string[]) {
    return async (row: QueuedSend): Promise<ReplyOutcome> => {
      log.push(row.text);
      return outcomes[row.text] ?? { status: "sent" };
    };
  }

  it("sends messages in order, removes what went, and reports it", async () => {
    enqueueSend({ paneId: "w1:p1", text: "a", kind: "message", agent: null });
    enqueueSend({ paneId: "w1:p1", text: "b", kind: "message", agent: null });
    const log: string[] = [];
    await drainSendQueue({ sender: sender({}, log) });
    expect(log).toEqual(["a", "b"]);
    expect(queuedForPane(undefined, "w1:p1")).toEqual([]);
    expect(statusSpy.last).toBe("Queued message sent");
  });

  it("a pane's refusal HOLDS that row with the reason and does not send the ones behind it", async () => {
    enqueueSend({ paneId: "w1:p1", text: "a", kind: "message", agent: null });
    enqueueSend({ paneId: "w1:p1", text: "b", kind: "message", agent: null });
    enqueueSend({ paneId: "w1:p2", text: "c", kind: "message", agent: null });
    const log: string[] = [];
    await drainSendQueue({ sender: sender({ a: { status: "stalled", error: "a dialog owns the keyboard" } }, log) });
    expect(log).toEqual(["a", "c"]);
    expect(queuedForPane(undefined, "w1:p1").map((r) => [r.text, r.held])).toEqual([
      ["a", "a dialog owns the keyboard"],
      ["b", undefined],
    ]);
    expect(queuedForPane(undefined, "w1:p2")).toEqual([]);
    // A held row is skipped by the next automatic drain…
    const again: string[] = [];
    await drainSendQueue({ sender: sender({}, again) });
    expect(again).toEqual([]);
    // …and sent by its own Send now, after which the one behind it is free to go.
    const forced: string[] = [];
    const held = queuedForPane(undefined, "w1:p1")[0]!;
    await drainSendQueue({ force: held.id, sender: sender({}, forced) });
    expect(forced).toEqual(["a"]);
    const rest: string[] = [];
    await drainSendQueue({ sender: sender({}, rest) });
    expect(rest).toEqual(["b"]);
  });

  it("a link failure stops everything and keeps every row for the next live poll", async () => {
    enqueueSend({ paneId: "w1:p1", text: "a", kind: "message", agent: null });
    enqueueSend({ paneId: "w1:p2", text: "b", kind: "message", agent: null });
    const log: string[] = [];
    await drainSendQueue({ sender: sender({ a: { status: "error", error: "Failed to fetch", transport: "network" } }, log) });
    expect(log).toEqual(["a"]);
    expect(queuedForPane(undefined, "w1:p1")[0]?.held).toBeUndefined();
    expect(queuedKeys()).toHaveLength(2);
  });

  it("never sends an answer on its own — only on its own Send now", async () => {
    const row = enqueueSend({ paneId: "w1:p1", text: "y", kind: "answer", agent: "claude", status: "blocked" })!;
    const log: string[] = [];
    await drainSendQueue({ sender: sender({}, log) });
    expect(log).toEqual([]);
    await drainSendQueue({ force: row.id, sender: sender({}, log) });
    expect(log).toEqual(["y"]);
    expect(queuedForPane(undefined, "w1:p1")).toEqual([]);
  });

  it("a live poll schedules a drain; a stale one does not", async () => {
    vi.useFakeTimers();
    try {
      enqueueSend({ paneId: "w1:p1", text: "a", kind: "message", agent: null });
      const log: string[] = [];
      const off = installSendQueueDrain(sender({}, log));
      await vi.advanceTimersByTimeAsync(300);
      expect(log).toEqual([]); // nothing proved the link live yet
      markLive();
      await vi.advanceTimersByTimeAsync(300);
      expect(log).toEqual(["a"]);
      off();
    } finally {
      vi.useRealTimers();
    }
  });
});
