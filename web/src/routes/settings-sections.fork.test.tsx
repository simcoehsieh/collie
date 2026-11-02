import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { withHeaderHost } from "@/test/header-host";
import { SettingsAppearanceRoute, SettingsSystemRoute } from "./settings-sections";

// FORK — THREE SETTINGS ROWS THIS INSTALL DOES NOT DRAW (the 1.25 merge, 2026-11-02; lib/fork-shape.ts).
// Upstream 1.24 adds Large-screen layout and Pane navigation to Appearance, and 1.24.1 adds Report a
// problem to System. The layout and the gesture are off here (FORK_WIDE_LAYOUT_ON, FORK_PANE_NAV_ON),
// so a row that chooses between them would choose nothing; a report would file a fork build's issue
// upstream (FORK_REPORT_ON). Upstream's cases, with the rows, run in the controls' own test files.

vi.mock("@/lib/fork-shape", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/fork-shape")>()),
  FORK_WIDE_LAYOUT_ON: false,
  FORK_PANE_NAV_ON: false,
  FORK_REPORT_ON: false,
}));

function renderAt(path: string, element: React.ReactElement) {
  const router = createMemoryRouter(
    [
      { path, element: withHeaderHost(element) },
      { path: "/settings", element: <div data-testid="settings" /> },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
}

describe("FORK: Settings without the 1.24 rows", () => {
  it("Appearance draws no Large-screen layout row and no Pane navigation row", async () => {
    renderAt("/settings/appearance", <SettingsAppearanceRoute />);
    // A row every build draws, so the page is known to have rendered.
    expect(await screen.findByText("Hand")).toBeInTheDocument();
    expect(screen.queryByText("Large-screen layout")).toBeNull();
    expect(screen.queryByText("Pane navigation")).toBeNull();
  });

  it("System draws no Report a problem row", async () => {
    renderAt("/settings/system", <SettingsSystemRoute />);
    expect(await screen.findByText("Paired devices")).toBeInTheDocument();
    expect(screen.queryByText("Offer a report when sending fails")).toBeNull();
    expect(screen.queryByRole("button", { name: "Report a problem" })).toBeNull();
  });
});
