import { act, renderHook, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { setLocked } from "./idle";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixtureTranscript } from "@/test/handlers";
import { fixtureArtifact } from "@/test/artifacts";
import { server } from "@/test/setup";
import {
  __resetArtifacts,
  useArtifacts,
  ARTIFACT_REFRESH_MS,
  artifactSize,
  artifactsForPane,
  artifactsSnapshot,
  attachArtifactsToTurns,
  deliverArtifactPoke,
  latestVersions,
  loadArtifacts,
  versionsOf,
} from "./artifacts";

// The phone's copy of the library (lib/artifacts.ts). Pinned: which turn an artifact goes under
// (the latest turn not after it), the version grouping, and that a poke refetches every scope that
// has been read — and only those.

beforeEach(() => __resetArtifacts());
afterEach(() => __resetArtifacts());

describe("attachArtifactsToTurns", () => {
  const [user, assistant] = fixtureTranscript; // 06:22:21 user, 06:22:24 assistant

  it("files an artifact under the latest turn that had started when it was registered", () => {
    const made = fixtureArtifact({ id: "a1-00000001", createdMs: Date.parse("2026-07-25T06:22:30.000Z") });
    const map = attachArtifactsToTurns(fixtureTranscript, [made]);
    expect(map.get(assistant!.uuid)).toEqual([made]);
    expect(map.has(user!.uuid)).toBe(false);
  });

  it("one registered between two turns goes under the earlier; one before the window has no turn", () => {
    const between = fixtureArtifact({ id: "a2-00000002", createdMs: Date.parse("2026-07-25T06:22:22.000Z") });
    const before = fixtureArtifact({ id: "a3-00000003", createdMs: Date.parse("2026-07-25T06:00:00.000Z") });
    const map = attachArtifactsToTurns(fixtureTranscript, [between, before]);
    expect(map.get(user!.uuid)).toEqual([between]);
    expect([...map.values()].flat()).not.toContain(before);
  });

  it("keeps registration order within a turn, and answers empty for an empty side", () => {
    const first = fixtureArtifact({ id: "a4-00000004", createdMs: Date.parse("2026-07-25T06:22:25.000Z") });
    const second = fixtureArtifact({ id: "a5-00000005", createdMs: Date.parse("2026-07-25T06:22:26.000Z") });
    expect(attachArtifactsToTurns(fixtureTranscript, [second, first]).get(assistant!.uuid)).toEqual([first, second]);
    expect(attachArtifactsToTurns([], [first]).size).toBe(0);
    expect(attachArtifactsToTurns(fixtureTranscript, []).size).toBe(0);
  });
});

describe("grouping", () => {
  it("latestVersions keeps the first of each slug in list order; versionsOf sorts one slug newest first", () => {
    const v2 = fixtureArtifact({ id: "b2-00000002", version: 2 });
    const v1 = fixtureArtifact({ id: "b1-00000001", version: 1 });
    const other = fixtureArtifact({ id: "c1-00000001", slug: "other" });
    expect(latestVersions([v2, other, v1])).toEqual([v2, other]);
    expect(versionsOf([v1, other, v2], "q3-report")).toEqual([v2, v1]);
    expect(artifactsForPane([v2, fixtureArtifact({ id: "d1-00000001", pane: null })], "w1:p1")).toEqual([v2]);
  });

  it("artifactSize prints the way the CLI does", () => {
    expect(artifactSize(9)).toBe("9 B");
    expect(artifactSize(1536)).toBe("1.5 KB");
    expect(artifactSize(2 * 1024 * 1024 + 104858)).toBe("2.10 MB");
  });
});

describe("the store and the poke", () => {
  it("coalesces readers, refreshes active scopes and invalidates inactive ones", async () => {
    let calls = 0;
    server.use(
      http.get("/api/artifacts", () => {
        calls++;
        return HttpResponse.json({ ok: true, artifacts: [fixtureArtifact({ title: `read ${String(calls)}` })] });
      }),
    );
    expect(deliverArtifactPoke()).toBe(false);
    await Promise.all([loadArtifacts(), loadArtifacts()]);
    expect(calls).toBe(1);
    expect(artifactsSnapshot().phase).toBe("ready");
    expect(artifactsSnapshot().artifacts[0]!.title).toBe("read 1");
    expect(deliverArtifactPoke()).toBe(true);
    expect(calls).toBe(1); // no mounted readers, no network
    const { result, unmount } = renderHook(() => useArtifacts());
    await waitFor(() => expect(result.current.artifacts[0]?.title).toBe("read 2"));
    expect(calls).toBe(2);
    unmount();
    expect(artifactsSnapshot().artifacts[0]!.title).toBe("read 2");
  });

  it("a failed refresh keeps the last list and says so", async () => {
    server.use(http.get("/api/artifacts", () => HttpResponse.json({ ok: true, artifacts: [fixtureArtifact()] })));
    await loadArtifacts();
    server.use(http.get("/api/artifacts", () => new HttpResponse("nope", { status: 503 })));
    await loadArtifacts();
    const snap = artifactsSnapshot();
    expect(snap.phase).toBe("failed");
    expect(snap.artifacts).toHaveLength(1);
  });
});


describe("active library freshness", () => {
  it("shares the fallback timer, pauses hidden/locked readers, catches up on return, and stops after unmount", async () => {
    vi.useFakeTimers();
    let calls = 0;
    server.use(http.get("/api/artifacts", () => {
      calls++;
      return HttpResponse.json({ ok: true, artifacts: [] });
    }));
    const first = renderHook(() => useArtifacts());
    const second = renderHook(() => useArtifacts());
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(calls).toBe(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(ARTIFACT_REFRESH_MS); });
      expect(calls).toBe(2);
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      act(() => { deliverArtifactPoke(); deliverArtifactPoke(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(ARTIFACT_REFRESH_MS * 2); });
      expect(calls).toBe(2);
      visibility.mockReturnValue("visible");
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(0); });
      expect(calls).toBe(3);
      act(() => setLocked(true));
      await act(async () => { await vi.advanceTimersByTimeAsync(ARTIFACT_REFRESH_MS * 2); });
      expect(calls).toBe(3);
      await act(async () => { setLocked(false); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(calls).toBe(4);
      first.unmount(); second.unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(ARTIFACT_REFRESH_MS * 2); });
      expect(calls).toBe(4);
    } finally {
      first.unmount(); second.unmount();
      setLocked(false);
      vi.restoreAllMocks(); vi.useRealTimers();
    }
  });

  it("does not lose a poke arriving during a read", async () => {
    let finish: (() => void) | undefined;
    let calls = 0;
    server.use(http.get("/api/artifacts", async () => {
      const n = ++calls;
      if (n === 1) await new Promise<void>((resolve) => { finish = resolve; });
      return HttpResponse.json({ ok: true, artifacts: [fixtureArtifact({ title: `read ${n}` })] });
    }));
    const { result } = renderHook(() => useArtifacts());
    await waitFor(() => expect(calls).toBe(1));
    act(() => { deliverArtifactPoke(); deliverArtifactPoke(); finish?.(); });
    await waitFor(() => expect(result.current.artifacts[0]?.title).toBe("read 2"));
    expect(calls).toBe(2);
  });

  it("retries a failed initial read on remount", async () => {
    server.use(http.get("/api/artifacts", () => new HttpResponse("nope", { status: 503 })));
    const first = renderHook(() => useArtifacts());
    await waitFor(() => expect(first.result.current.phase).toBe("failed"));
    first.unmount();
    server.use(http.get("/api/artifacts", () => HttpResponse.json({ ok: true, artifacts: [fixtureArtifact()] })));
    const second = renderHook(() => useArtifacts());
    await waitFor(() => expect(second.result.current.phase).toBe("ready"));
    expect(second.result.current.artifacts).toHaveLength(1);
  });
});
