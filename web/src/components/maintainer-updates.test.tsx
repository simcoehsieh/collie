import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { http, HttpResponse } from "msw";
import { server } from "@/test/setup";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { __resetUpdateRunStore } from "@/lib/update-run-store";
import { __resetLocale, setLocale, whenLocaleReady } from "@/lib/i18n";
import type { PreflightReport, UpdateInfo, UpdateRun } from "@/lib/types";
import { withHeaderHost } from "@/test/header-host";

vi.mock("@/lib/fork-shape", async (original) => ({
  ...await original<object>(), MAINTAINER_MANAGED_UPDATES: true,
}));

import { UpdateBanner, updateNotice } from "./update-banner";
import { UpdateCard } from "./update-card";
import { updatesStatusLine } from "./updates-settings-card";
import { UpdatesRoute } from "@/routes/updates";
import { UpdateScreen } from "./update-screen";
import { updateScreenView, type UpdateScreenInput } from "@/lib/update-screen";
import type { UpdateScreen as UpdateScreenState } from "@/hooks/use-update-screen";

const URL = "https://github.com/AltanS/collie/releases/tag/v1.16.0";
const info = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({
  current: "1.15.3", latest: "1.16.0", latestUrl: URL, releaseAvailable: true,
  majorAvailable: null, majorUrl: null, bridgeStale: false, checkedAt: Date.now(), ...over,
});
const green: PreflightReport = { schema: 1, verdict: "green", checks: [
  { id: "doctor", verdict: "green", reason: "maintainer-managed merges" },
] };

function mount(update = info(), element = <UpdateCard />, preflight: PreflightReport | null = green) {
  server.use(http.get("/api/update/check", () => HttpResponse.json({ ...update, preflight })));
  const data: HomeData = { bridge: "connected", device: undefined, agents: [], shellPanes: [],
    workspaces: [], tabs: [], sessions: [], servers: [], ts: 0, scope: {}, viewAll: false,
    snoozedUntil: null, update, error: false, authError: false };
  const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", loader: () => data,
    children: [{ path: "settings/updates", element: withHeaderHost(element) }] }],
  { initialEntries: ["/settings/updates"] });
  return render(<RouterProvider router={router} />);
}

beforeEach(() => { __resetUpdateRunStore(); __resetLocale(); });
afterEach(() => __resetUpdateRunStore());

describe("Maintainer-managed updates", () => {
  it("links the upstream release without an update command", async () => {
    mount(info(), <UpdateBanner />);
    const link = await screen.findByRole("link", { name: "Upstream v1.16.0 released · This installation is updated by maintainer merges" });
    expect(link).toHaveAttribute("href", URL);
    expect(link.parentElement?.querySelector("button")).toBeNull();
    expect(updateNotice(info())?.command).toBeUndefined();
  });

  it("a major release gets notes and never the refused update-major command", () => {
    const notice = updateNotice(info({ releaseAvailable: false, majorAvailable: "2.0.0", majorUrl: null }));
    expect(notice?.href).toBe("https://github.com/AltanS/collie/releases/tag/v2.0.0");
    expect(notice?.line).toContain("Upstream v2.0.0 released");
    expect(notice?.command).toBeUndefined();
  });

  it("keeps a stale process visible without suggesting a self-update", () => {
    expect(updateNotice(info({ bridgeStale: true }))?.line).toContain("Bridge restart needed");
    expect(updateNotice(info({ bridgeStale: true }))?.command).toBeUndefined();
  });

  it.each([{}, { releaseAvailable: false, majorAvailable: "2.0.0", majorUrl: null }])("the card offers release notes and no self-update: %j", async (over) => {
    const mutations: string[] = [];
    server.use(http.post("/api/update", () => { mutations.push("update"); return HttpResponse.json({ ok: true }); }));
    mount(info(over));
    const notes = await screen.findByRole("link", { name: "Release notes" });
    expect(notes.getAttribute("href")).toMatch(/releases\/tag\/v(1\.16\.0|2\.0\.0)$/);
    await screen.findByText("maintainer-managed merges");
    expect(screen.queryByRole("button", { name: /^(Update to|Update all|Cross to|Retry|Try)/ })).toBeNull();
    expect(mutations).toEqual([]);
  });

  it("shows a real red preflight check and its reason", async () => {
    mount(info(), <UpdateCard />, { schema: 1, verdict: "red", checks: [
      { id: "disk", verdict: "red", reason: "No staging space is left" },
    ] });
    expect(await screen.findByText("No staging space is left")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Update to/ })).toBeNull();
  });

  it.each(["rolled-back", "stuck", "interrupted"] as const)("retains a %s run and readable failure log, with no retry action", async (state) => {
    const run: UpdateRun = { schema: 1, state, from: "1.15.3", to: "1.16.0", startedAt: Date.now() - 2000,
      updatedAt: Date.now(), pid: 1, attempt: 0, logTail: "staging failed: disk full" };
    mount(info({ run }));
    const details = await screen.findByText("Log tail");
    fireEvent.click(details);
    expect(screen.getByText("staging failed: disk full")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
    expect(updatesStatusLine({ update: info({ run }), running: false, behind: 0 })).toContain("An update failed");
  });

  it("shows that the update check failed rather than hiding it behind the managed boundary", async () => {
    mount(info(), <UpdateCard />, null);
    await waitFor(() => expect(screen.getByText(/preflight couldn't be run/i)).toBeVisible());
  });

  it("the route names its update information and keeps the release-check control", async () => {
    mount(info(), <UpdatesRoute />);
    expect(await screen.findByRole("heading", { name: "Update information" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Release notes" })).toHaveAttribute("href", URL);
    expect(screen.queryByRole("button", { name: /Update to/ })).toBeNull();
  });

  it.each(["rolled-back", "stuck", "interrupted"] as const)("the %s progress panel also keeps diagnostics without a retry or recovery command", (state) => {
    const now = Date.now();
    const input: UpdateScreenInput = {
      run: { schema: 1, state, from: "1.15.3", to: "1.16.0", startedAt: now - 2000,
        updatedAt: now, pid: 1, attempt: 0, recovery: "collie update --rollback" },
      crew: [], leadName: "test-host", stage: "idle", progress: null, installingSince: null,
      startedHere: false, controllerChangedAt: null, released: false, now, claim: null,
      bundle: { id: "test", version: "1.15.3" }, serverStale: false,
    };
    const screenState: UpdateScreenState = {
      view: updateScreenView(input), mode: "expanded", blocking: true, ask: null,
      setExpanded: vi.fn(), release: vi.fn(), skip: vi.fn(), keepTrying: vi.fn(),
      back: vi.fn(), notNow: vi.fn(), retryMembers: vi.fn(), tryAgain: vi.fn(),
    };
    const openUpdates = vi.fn();
    render(<UpdateScreen screen={screenState} onOpenUpdates={openUpdates} onStarted={vi.fn()} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Try again|Start update/ })).toBeNull();
    expect(screen.queryByText("collie update --rollback")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show log" }));
    expect(openUpdates).toHaveBeenCalledOnce();
  });

  it("serves the requested Traditional Chinese wording through the fork dictionary", async () => {
    act(() => setLocale("zh-TW"));
    await act(() => whenLocaleReady("zh-TW"));
    mount();
    expect(await screen.findByText("上游 v1.16.0 已發佈 · 此安裝由維護者合併更新")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "版本說明" })).toHaveAttribute("href", URL);
  });
});
