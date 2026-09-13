import { describe, expect, it, vi } from "vitest";

import { applyBadge, attentionCount, type BadgeSink } from "./app-badge";
import type { AgentView } from "./types";

// FORK — what the app icon's badge counts (lib/app-badge.ts): blocked panes and finished-unread
// ones, nothing else; and the two calls a count turns into.

const agent = (over: Partial<AgentView>): AgentView => ({
  paneId: "w1:p1",
  workspaceId: "w1",
  workspaceLabel: "webapp",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: "claude",
  status: "idle",
  cwd: "/home/you/webapp",
  focused: false,
  ...over,
});

describe("attentionCount", () => {
  it("counts blocked panes and finished-but-unread ones; a read or a working pane counts nothing", () => {
    const agents = [
      agent({ paneId: "a", status: "blocked" }),
      agent({ paneId: "b", status: "done", lastActiveAt: 20, lastSeenAt: 10 }), // unread
      agent({ paneId: "c", status: "done", lastActiveAt: 10, lastSeenAt: 20 }), // read
      agent({ paneId: "d", status: "working" }),
      agent({ paneId: "e", status: "done" }), // an older bridge: no timestamps, not unseen
    ];
    expect(attentionCount(agents)).toBe(2);
    expect(attentionCount([])).toBe(0);
  });
});

describe("applyBadge", () => {
  it("shows a positive count, clears on zero, and swallows a refusal", async () => {
    const sink: BadgeSink = { set: vi.fn(() => Promise.resolve()), clear: vi.fn(() => Promise.resolve()) };
    await applyBadge(sink, 3);
    expect(sink.set).toHaveBeenCalledWith(3);
    await applyBadge(sink, 0);
    expect(sink.clear).toHaveBeenCalledTimes(1);
    const refusing: BadgeSink = { set: () => Promise.reject(new Error("no")), clear: () => Promise.reject(new Error("no")) };
    await expect(applyBadge(refusing, 1)).resolves.toBeUndefined();
    await expect(applyBadge(refusing, 0)).resolves.toBeUndefined();
  });
});
