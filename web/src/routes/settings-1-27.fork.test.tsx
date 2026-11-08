import { render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsGear } from "@/components/app-header";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { UpdateInfo } from "@/lib/types";
import { withHeaderHost } from "@/test/header-host";
import { SettingsRoute } from "./settings";
import { SettingsAppearanceRoute, SettingsSystemRoute } from "./settings-sections";

// FORK — THE 1.27 MERGE'S SETTINGS SHAPES (2026-11-08; lib/fork-shape.ts).
//
// MAINTAINER_MANAGED_UPDATES: upstream 1.27.0 moves Updates to the first row of the Settings index and
// puts a 6px dot on the home gear while a release is on offer. This install is updated by maintainer
// merges, so the index keeps the fork's order (Appearance first), Updates stays the first row of
// System, and the gear carries no dot whatever upstream released.
// FORK_ZOOM_PILL_CHOICE_ON: upstream 1.27.0's Appearance row "Zoom pill" chooses for a pill this
// install never draws (the belt's pinned block, lib/belt-pins.ts), so there is no row.
// Each gate flips per case (a hoisted switch behind getters); the "on" twin is what proves the off
// case is not passing by accident. Upstream's own cases run in settings.test.tsx and app-header.test.tsx.

const gates = vi.hoisted(() => ({ managed: true, zoomPill: false }));
vi.mock("@/lib/fork-shape", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fork-shape")>();
  return {
    ...actual,
    get MAINTAINER_MANAGED_UPDATES() {
      return gates.managed;
    },
    get FORK_ZOOM_PILL_CHOICE_ON() {
      return gates.zoomPill;
    },
  };
});

beforeEach(() => {
  gates.managed = true;
  gates.zoomPill = false;
});

const offered = (): UpdateInfo => ({
  current: "1.27.4",
  latest: "1.28.0",
  latestUrl: null,
  releaseAvailable: true,
  majorAvailable: null,
  majorUrl: null,
  bridgeStale: false,
  checkedAt: 1_700_000_000_000,
});

function home(update: UpdateInfo | undefined): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents: [],
    shellPanes: [],
    workspaces: [],
    tabs: [],
    sessions: [],
    servers: [],
    ts: 0,
    scope: {},
    viewAll: false,
    snoozedUntil: null,
    update,
    error: false,
    authError: false,
  };
}

function renderUnderRoot(path: string, element: React.ReactElement, update: UpdateInfo | undefined = offered()) {
  const data = home(update);
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => data,
        children: [
          { index: true, element: withHeaderHost(element) },
          { path: path.slice(1), element: withHeaderHost(element) },
          { path: "settings/updates", element: <div data-testid="updates" /> },
          { path: "settings/:section", element: <div data-testid="section" /> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  return render(<RouterProvider router={router} />);
}

const rowTitles = () =>
  screen
    .getAllByRole("button")
    .map((b) => b.textContent ?? "")
    .filter((text) => /Updates|Appearance|System/.test(text));

describe("FORK: the Settings index keeps its order (MAINTAINER_MANAGED_UPDATES)", () => {
  it("leads with Updates while the gate is off (the twin)", async () => {
    gates.managed = false;
    renderUnderRoot("/settings", <SettingsRoute />);
    await screen.findByRole("button", { name: /^Updates/ });
    expect(rowTitles()[0]).toContain("Updates");
  });

  it("draws no Updates row on the index, leads with Appearance, and System still names Updates", async () => {
    renderUnderRoot("/settings", <SettingsRoute />);
    await screen.findByRole("button", { name: /^Appearance/ });
    expect(screen.queryByRole("button", { name: /^Updates/ })).toBeNull();
    expect(document.querySelector('[data-slot="update-dot"]')).toBeNull();
    expect(rowTitles()[0]).toContain("Appearance");
    expect(screen.getByRole("button", { name: /^System/ })).toHaveTextContent("Updates, devices, crew");
  });

  it("puts Updates first in System, with no dot", async () => {
    renderUnderRoot("/settings/system", <SettingsSystemRoute />);
    const updates = await screen.findByRole("button", { name: /^Updates/ });
    const devices = await screen.findByText("Paired devices");
    // Updates comes before the paired devices in document order.
    expect(updates.compareDocumentPosition(devices) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(updates.querySelector('[data-slot="update-dot"]')).toBeNull();
    expect(updates).not.toHaveTextContent("1.28.0 available");
  });

  it("has no Updates row in System while the gate is off (the twin: it moved to the index)", async () => {
    gates.managed = false;
    renderUnderRoot("/settings/system", <SettingsSystemRoute />);
    await screen.findByText("Paired devices");
    expect(screen.queryByRole("button", { name: /^Updates/ })).toBeNull();
  });
});

describe("FORK: the home gear carries no update dot (MAINTAINER_MANAGED_UPDATES)", () => {
  it("carries the dot while the gate is off (the twin)", async () => {
    gates.managed = false;
    const { container } = renderUnderRoot("/", <SettingsGear />);
    await screen.findByRole("button", { name: "Settings, update available" });
    expect(container.querySelector('[data-slot="update-dot"]')).not.toBeNull();
  });

  it("has no dot and the plain name though a release is on offer", async () => {
    const { container } = renderUnderRoot("/", <SettingsGear />);
    await screen.findByRole("button", { name: "Settings" });
    expect(container.querySelector('[data-slot="update-dot"]')).toBeNull();
  });
});

describe("FORK: Appearance draws no Zoom pill row (FORK_ZOOM_PILL_CHOICE_ON)", () => {
  it("draws the row while the gate is on (the twin)", async () => {
    gates.zoomPill = true;
    renderUnderRoot("/settings/appearance", <SettingsAppearanceRoute />);
    expect(await screen.findByText("Zoom pill")).toBeInTheDocument();
  });

  it("draws no Zoom pill row with the gate off", async () => {
    renderUnderRoot("/settings/appearance", <SettingsAppearanceRoute />);
    // A row every build draws, so the page is known to have rendered.
    expect(await screen.findByText("Hand")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Zoom pill")).toBeNull());
    expect(screen.queryByRole("radiogroup", { name: "Zoom pill" })).toBeNull();
  });
});
