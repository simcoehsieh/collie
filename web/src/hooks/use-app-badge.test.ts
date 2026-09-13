import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { BadgeSink } from "@/lib/app-badge";
import { fixtureAgents } from "@/test/handlers";
import type { AgentView } from "@/lib/types";
import { useAppBadge } from "./use-app-badge";

// FORK — the open app keeps the icon's badge equal to what needs you (hooks/use-app-badge.ts):
// written on mount, rewritten when the count changes, cleared when nothing is unseen.

describe("useAppBadge", () => {
  it("writes the count on mount, again when it changes, and clears at zero", async () => {
    const sink: BadgeSink = { set: vi.fn(() => Promise.resolve()), clear: vi.fn(() => Promise.resolve()) };
    const blocked = fixtureAgents.filter((a) => a.status === "blocked");
    expect(blocked.length).toBeGreaterThan(0);
    const { rerender } = renderHook(({ agents }: { agents: readonly AgentView[] }) => useAppBadge(agents, sink), {
      initialProps: { agents: blocked },
    });
    await waitFor(() => expect(sink.set).toHaveBeenCalledWith(blocked.length));
    const working: AgentView[] = [];
    for (const a of blocked) working.push(Object.assign({}, a, { status: "working" as const }));
    rerender({ agents: working });
    await waitFor(() => expect(sink.clear).toHaveBeenCalledTimes(1));
    // The same count again is not a second write.
    rerender({ agents: [...working] });
    expect(sink.clear).toHaveBeenCalledTimes(1);
  });

  it("does nothing where the platform has no badge", () => {
    expect(() => renderHook(() => useAppBadge(fixtureAgents, null))).not.toThrow();
  });
});
