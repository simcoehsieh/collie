import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComponentProps } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";

import { fixtureAgents, fixtureTabs, paneTextWithDraft } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { AgentChat } from "./agent-chat";

// FORK — THE 1.25 MERGE'S GATES, AS THE PANE VIEW DRAWS THEM (2026-11-02).
//
// FORK_PANE_NAV_ON: upstream 1.24.0's two-finger / Joystick pane navigation reads "off" on this
// install whatever the device stored, so no Joystick handle stands above the belt.
// FORK_REPORT_ON: upstream 1.24.1's Report a problem has no door here: no row in the ⋮ and no Report
// button on the "Collie cannot read this dialog" card.
// Both gates flip per case (a hoisted switch behind getters), so each "off" case has its "on" twin in
// the same render path, and the twin is what proves the off case is not passing by accident.

const gates = vi.hoisted(() => ({ paneNav: false, report: false }));
vi.mock("@/lib/fork-shape", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fork-shape")>();
  return {
    ...actual,
    get FORK_PANE_NAV_ON() {
      return gates.paneNav;
    },
    get FORK_REPORT_ON() {
      return gates.report;
    },
  };
});
const liveness = vi.hoisted(() => ({ live: true }));
vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => liveness.live,
  useLive: () => liveness.live,
}));

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  gates.paneNav = false;
  gates.report = false;
});

function renderChat(overrides: Partial<ComponentProps<typeof AgentChat>> = {}) {
  const agent = fixtureAgents[0]!;
  const props: ComponentProps<typeof AgentChat> = {
    paneId: agent.paneId,
    agent,
    agents: fixtureAgents,
    shellPanes: [],
    tabs: fixtureTabs,
    text: paneTextWithDraft("recent pane output"),
    onBack: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
  const router = createMemoryRouter([{ path: "/", element: withHeaderHost(<AgentChat {...props} />) }]);
  return render(<RouterProvider router={router} />);
}

const handle = () => document.querySelector('[data-slot="pane-nav-handle"]');

describe("AgentChat — FORK_PANE_NAV_ON", () => {
  beforeEach(() => {
    localStorage.setItem("collie:display-prefs:v4", JSON.stringify({ paneNav: "joystick" }));
  });

  it("draws the Joystick handle the device chose while the gate is on (the twin)", async () => {
    gates.paneNav = true;
    renderChat();
    await waitFor(() => expect(handle()).not.toBeNull());
  });

  it("draws no Joystick handle with the gate off, though the device chose the Joystick", async () => {
    renderChat();
    await screen.findByRole("button", { name: "Pane actions" });
    expect(handle()).toBeNull();
  });
});

describe("AgentChat — FORK_REPORT_ON", () => {
  // A claude screen no grammar reads: the unread-dialog card (.adr/0053), which carries upstream's
  // Report button when the pane view hands it a handler.
  const UNREAD = readFileSync(
    join(import.meta.dirname, "..", "fixtures", "panes", "claude-lab--menu-status-screen--w82.txt"),
    "utf8",
  );

  it("offers Report a problem on the card and in the ⋮ while the gate is on (the twin)", async () => {
    gates.report = true;
    const user = userEvent.setup();
    renderChat({ text: UNREAD });
    expect(await screen.findByRole("button", { name: "Report a problem" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pane actions" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Report a problem" })).toBeInTheDocument();
  });

  it("offers no Report a problem on the card nor in the ⋮ with the gate off", async () => {
    const user = userEvent.setup();
    renderChat({ text: UNREAD });
    await user.click(await screen.findByRole("button", { name: "Pane actions" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("group", { name: "Manage" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Report a problem" })).toBeNull();
  });
});
