import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { fixtureSnapshot } from "@/test/handlers";
import {
  __resetBoot,
  __resetConfigMemo,
  __resetSnapshotCache,
  fetchBootSnapshot,
  fetchConfig,
  fetchLaunchers,
  fetchQuota,
  fetchSnapshot,
  getNotifyPrefs,
} from "./api";
import type { BootResponse } from "./types";

// FORK: the client half of `GET /api/boot` (bridge/boot.ts). The claim under test is not "the route
// answers" — it is that the bundle SEEDS the caches the five routes already read from, so the page
// that boots from it makes no second request for anything it was handed, and goes back to the
// ordinary routes from the next tick onward.

const NOTIFY_PREFS = { blocked: true, done: false, updates: true, panes: [] };
const QUOTA = { ok: true as const, fetchedAt: "2026-09-11T00:00:00.000Z", agents: [] };

function bootBundle(over: Partial<BootResponse> = {}): BootResponse {
  return {
    snapshot: fixtureSnapshot,
    snapshotEtag: '"boot1"',
    config: { push: false, vapidPublicKey: "", build: "from-boot" },
    launchers: { launchers: [{ label: "codex", command: "codex" }], home: "/home/op" },
    notifyPrefs: NOTIFY_PREFS,
    ...over,
  };
}

/** Serve the bundle and count what else the page asks for. */
function withBundle(body: BootResponse = bootBundle()) {
  const asked: string[] = [];
  server.use(
    http.get("/api/boot", () => HttpResponse.json(body)),
    http.get("/api/config", () => {
      asked.push("/api/config");
      return HttpResponse.json({ push: true, vapidPublicKey: "k", build: "from-route" });
    }),
    http.get("/api/launchers", () => {
      asked.push("/api/launchers");
      return HttpResponse.json({ launchers: [], home: "" });
    }),
    http.get("/api/notifications/prefs", () => {
      asked.push("/api/notifications/prefs");
      return HttpResponse.json({ blocked: false, done: false, updates: false, panes: [] });
    }),
    http.get("/api/quota", () => {
      asked.push("/api/quota");
      return HttpResponse.json({ ok: true, fetchedAt: "later", agents: [] });
    }),
    http.get("/api/snapshot", ({ request }) => {
      asked.push(`/api/snapshot if-none-match=${request.headers.get("if-none-match") ?? ""}`);
      return HttpResponse.json(fixtureSnapshot);
    }),
  );
  return asked;
}

beforeEach(() => {
  __resetBoot();
  __resetConfigMemo();
  __resetSnapshotCache();
});

describe("fetchBootSnapshot — one round trip instead of six", () => {
  it("returns the bundle's snapshot", async () => {
    withBundle();
    await expect(fetchBootSnapshot()).resolves.toEqual(fixtureSnapshot);
  });

  it("primes the snapshot ETag map, so the FIRST poll after it validates", async () => {
    const asked = withBundle();
    await fetchBootSnapshot();
    await fetchSnapshot();
    expect(asked).toEqual(['/api/snapshot if-none-match="boot1"']);
  });

  it("answers the three config callers without a request", async () => {
    const asked = withBundle();
    await fetchBootSnapshot();
    const [a, b, c] = await Promise.all([fetchConfig(), fetchConfig(), fetchConfig()]);
    expect(a.build).toBe("from-boot");
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(asked).toEqual([]);
  });

  it("hands the launcher rows and the notify prefs to the first caller, and only the first", async () => {
    const asked = withBundle();
    await fetchBootSnapshot();
    expect((await fetchLaunchers()).launchers).toHaveLength(1);
    expect(await getNotifyPrefs()).toEqual(NOTIFY_PREFS);
    expect(asked).toEqual([]);
    // Rows are read live on every later mount — that is the promise lib/launchers.ts makes, and the
    // seed must not turn it into a page-long cache.
    expect((await fetchLaunchers()).launchers).toHaveLength(0);
    expect(await getNotifyPrefs()).toEqual({ blocked: false, done: false, updates: false, panes: [] });
    expect(asked).toEqual(["/api/launchers", "/api/notifications/prefs"]);
  });

  it("carries the quota only when the bundle had one, and a refresh still reruns the command", async () => {
    const asked = withBundle(bootBundle({ quota: QUOTA, quotaEtag: '"q1"' }));
    await fetchBootSnapshot();
    expect(await fetchQuota()).toEqual(QUOTA);
    expect(asked).toEqual([]);
    // The operator asking for a rerun must reach the bridge even on the boot beat.
    await fetchQuota(true);
    expect(asked).toEqual(["/api/quota"]);
  });

  it("without a quota in the bundle the card asks the route, exactly as it does today", async () => {
    const asked = withBundle();
    await fetchBootSnapshot();
    await fetchQuota();
    expect(asked).toEqual(["/api/quota"]);
  });
});

describe("fetchBootSnapshot — the fallback is the whole safety story", () => {
  it("a bridge without the route falls back to the snapshot (the default handler 404s)", async () => {
    await expect(fetchBootSnapshot()).resolves.toEqual(fixtureSnapshot);
  });

  it("a bundle is asked for ONCE per page, whatever happened — later loads are plain snapshots", async () => {
    const asked = withBundle();
    await fetchBootSnapshot();
    await fetchBootSnapshot();
    expect(asked).toEqual(['/api/snapshot if-none-match="boot1"']);
  });

  it("a member scope never asks for a bundle — launcher rows must come from the host that runs them", async () => {
    const asked = withBundle();
    await fetchBootSnapshot({ host: "laptop" });
    expect(asked.some((a) => a.startsWith("/api/snapshot"))).toBe(true);
  });

  it("a widened view is fetched the old way — the bundle carries the narrow body", async () => {
    const asked = withBundle();
    await fetchBootSnapshot(undefined, undefined, true);
    expect(asked.some((a) => a.startsWith("/api/snapshot"))).toBe(true);
  });
});
