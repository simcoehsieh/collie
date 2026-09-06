import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

// Spied at the api seam, not over the network — the invariant under test is WHICH scope was asked
// for and HOW OFTEN, and a mock records both synchronously.
vi.mock("@/lib/api", () => ({ fetchLaunchers: vi.fn() }));

import { fetchLaunchers } from "@/lib/api";
import type { Scope } from "@/lib/scope";
import type { Launcher } from "@/lib/types";
import { launcherAgent, pinnedLauncher, useLaunchers } from "./launchers";

const asked = vi.mocked(fetchLaunchers);

const peek: Launcher = { command: "rumen-peek", label: "Runs & quota", cwd: "/home/op/project" };

describe("useLaunchers", () => {
  it("fetches on mount and returns the rows plus home", async () => {
    asked.mockClear();
    asked.mockResolvedValue({ launchers: [peek], home: "/home/op" });
    const { result } = renderHook(() => useLaunchers());
    await waitFor(() => expect(result.current.launchers).toEqual([peek]));
    expect(result.current.home).toBe("/home/op");
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("re-fetches when the scope's host changes", async () => {
    asked.mockClear();
    asked.mockResolvedValue({ launchers: [], home: "" });
    const { rerender } = renderHook(({ scope }: { scope: Scope | undefined }) => useLaunchers(scope), {
      initialProps: { scope: { host: "laptop" } },
    });
    await waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    expect(asked).toHaveBeenLastCalledWith({ host: "laptop", session: undefined });

    rerender({ scope: { host: "desk" } });
    await waitFor(() => expect(asked).toHaveBeenCalledTimes(2));
    expect(asked).toHaveBeenLastCalledWith({ host: "desk", session: undefined });
  });

  it("does not re-fetch when the scope is the same shape on every render", async () => {
    asked.mockClear();
    asked.mockResolvedValue({ launchers: [], home: "" });
    const { rerender } = renderHook(() => useLaunchers({ host: "laptop" }));
    await waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 5; i++) rerender();
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("a failed fetch leaves the rows empty rather than throwing", async () => {
    asked.mockClear();
    asked.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useLaunchers());
    await waitFor(() => expect(asked).toHaveBeenCalled());
    expect(result.current).toEqual({ launchers: [], home: "" });
  });
});

describe("pinnedLauncher", () => {
  const rows: Launcher[] = [
    { command: "claude", label: "claude" },
    { command: "codex --profile work", label: "codex" },
  ];

  it("resolves the pinned row by its command", () => {
    expect(pinnedLauncher(rows, "codex --profile work")).toEqual(rows[1]!);
  });

  it("an empty pin is the plain shell, which is the default", () => {
    expect(pinnedLauncher(rows, "")).toBeUndefined();
  });

  it("a pin whose row has LEFT launchers.toml falls back to the shell", () => {
    // The case the named function exists for. The alternative is a "+" that fails a create nobody
    // remembers configuring — and on a pack, against a host whose config file is not the one the
    // operator edited.
    expect(pinnedLauncher(rows, "gemini")).toBeUndefined();
  });

  it("matches the command exactly — a label or a prefix is not an identity", () => {
    // `POST /api/launch` matches on exact command equality (bridge/server.ts), so anything looser
    // here would resolve to a row the bridge would then refuse.
    expect(pinnedLauncher(rows, "codex")).toBeUndefined();
    expect(pinnedLauncher(rows, "Claude")).toBeUndefined();
  });

  it("has nothing to resolve against an empty roster", () => {
    expect(pinnedLauncher([], "claude")).toBeUndefined();
  });
});

describe("launcherAgent", () => {
  it("is the bare command", () => {
    expect(launcherAgent("claude")).toBe("claude");
  });

  it("ignores flags — a row's agent is its first word", () => {
    expect(launcherAgent("codex --profile work")).toBe("codex");
    expect(launcherAgent("  agy   --new-project  ")).toBe("agy");
  });

  it("strips a path, so an absolute command still names its agent", () => {
    expect(launcherAgent("/opt/homebrew/bin/codex")).toBe("codex");
    expect(launcherAgent("~/.local/bin/claude --resume")).toBe("claude");
  });

  it("answers with the first word even when that word is not an agent", () => {
    // Deliberate, and it is why this does not consult a list of known agents: `AgentIcon` already
    // falls back to a neutral initials tile, so a build command gets a legible tile rather than a
    // hole — and a new agent becomes recognisable by adding a BRAND there, not a name here.
    expect(launcherAgent("make -C ~/dev/collie test")).toBe("make");
    expect(launcherAgent("env FOO=1 claude")).toBe("env");
  });

  it("does not throw on an empty or slash-only command", () => {
    expect(launcherAgent("")).toBe("");
    expect(launcherAgent("   ")).toBe("");
    expect(launcherAgent("/")).toBe("");
  });
});
