import { act, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { __resetReport, openReport } from "@/lib/report/store";
import { RootLayout } from "./root";

// FORK — NO REPORT A PROBLEM (the 1.25 merge, 2026-11-02; lib/fork-shape.ts FORK_REPORT_ON). Upstream
// 1.24.1 mounts the report sheet's one door in RootLayout (components/report-door.tsx); the card, the
// pane menu and Settings open it through lib/report/store.ts. This install files no issue upstream from
// a fork build, so RootLayout mounts nothing report-related: an open that reaches the store from
// anywhere draws no sheet. The gate flips per case, and the "on" twin proves the off case is not
// passing by accident.

const gates = vi.hoisted(() => ({ report: false }));
vi.mock("@/lib/fork-shape", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fork-shape")>();
  return {
    ...actual,
    get FORK_REPORT_ON() {
      return gates.report;
    },
  };
});

const home = (): HomeData => ({
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
  update: undefined,
  error: false,
  authError: false,
});

async function mountRoot() {
  const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", loader: home, element: <RootLayout /> }], {
    initialEntries: ["/"],
  });
  const { container } = render(<RouterProvider router={router} />);
  await waitFor(() => expect(container.querySelector(".app-viewport")).not.toBeNull());
}

afterEach(() => {
  act(() => __resetReport());
  gates.report = false;
});

describe("FORK: RootLayout and Report a problem", () => {
  it("draws the report sheet when the store opens it while the gate is on (the twin)", async () => {
    gates.report = true;
    await mountRoot();
    act(() => openReport({}));
    expect(await screen.findByText("Report a problem", {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it("draws nothing with the gate off, though the store was asked to open it", async () => {
    await mountRoot();
    act(() => openReport({}));
    // Long enough for the lazy sheet to have loaded in the twin.
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByText("Report a problem")).toBeNull();
  });
});
