import type { ComponentProps } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { PaneBody } from "@/lib/chat-gate";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import type { AgentView, WorkspaceView } from "@/lib/types";
import { fixtureAgents, paneTextWithDraft } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { AgentChat } from "./agent-chat";

// FORK — THE 1.27 MERGE'S SHAPES, AS THE PANE VIEW DRAWS THEM (2026-11-08).
//
// FORK_BRANCH_LABEL_ON: upstream 1.27.0 (#666) names a worktree pane's REPOSITORY on the header's line 2,
// before the branch. The line here is the workspace and the model (the operator's call), so with the
// gate off a worktree pane keeps its workspace's own name. The gate flips per case, and the "on" twin
// is what proves the off case is not passing by accident.
//
// THE ZOOM DOOR IN THE ⋮: upstream 1.27.0 draws the belt's Zoom pill only in the Screen view. This
// install draws no pinned block (FORK_BELT_PINS_ON), so Zoom opens from the pane menu's View row, and
// that row stays in BOTH views: the zoomed output reads the live screen, whichever body is shown.

const gates = vi.hoisted(() => ({ branch: false }));
vi.mock("@/lib/fork-shape", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fork-shape")>();
  return {
    ...actual,
    get FORK_BRANCH_LABEL_ON() {
      return gates.branch;
    },
  };
});
vi.mock("@/lib/belt-pins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/belt-pins")>()),
  FORK_BELT_PINS_ON: false,
}));
interface Gate {
  body: PaneBody;
}
const body = vi.hoisted((): Gate => ({ body: "terminal" }));
vi.mock("@/lib/chat-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat-gate")>()),
  paneBody: (): PaneBody => body.body,
}));

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  gates.branch = false;
  body.body = "terminal";
  localStorage.clear();
});

function renderChat(overrides: Partial<ComponentProps<typeof AgentChat>> = {}, rootSpaces?: readonly WorkspaceView[]) {
  const agent = fixtureAgents[0]!;
  const props: ComponentProps<typeof AgentChat> = {
    paneId: agent.paneId,
    agent,
    agents: fixtureAgents,
    shellPanes: [],
    tabs: [],
    text: paneTextWithDraft("recent pane output"),
    onBack: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
  const element = withHeaderHost(<AgentChat {...props} />);
  const router =
    rootSpaces === undefined
      ? createMemoryRouter([{ path: "/", element }])
      : createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", loader: () => null, element }], {
          hydrationData: { loaderData: { [ROOT_ROUTE_ID]: { workspaces: rootSpaces } } },
        });
  return render(<RouterProvider router={router} />);
}

describe("AgentChat header — FORK_BRANCH_LABEL_ON and a worktree pane's repository", () => {
  const space: WorkspaceView = {
    workspaceId: "w1",
    number: 1,
    label: "lucky-meadow-d1ec",
    focused: false,
    activeTabId: "w1:t1",
    tabCount: 1,
    paneCount: 1,
    repoRoot: "/home/k/projects/membero",
    isWorktree: true,
  };
  const worktreeAgent = (): AgentView => ({
    ...fixtureAgents[0]!,
    workspaceId: "w1",
    workspaceLabel: "lucky-meadow-d1ec",
    gitHead: { kind: "branch", name: "fix-login" },
  });
  const place = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-slot="pane-place"]')!;

  it("names the repository and the branch while the gate is on (the twin)", () => {
    gates.branch = true;
    const agent = worktreeAgent();
    const { container } = renderChat({ agent, agents: [agent, ...fixtureAgents.slice(1)] }, [space]);
    expect(place(container)).toHaveTextContent("membero");
    expect(place(container).parentElement!.querySelector('[data-slot="branch-label"]')).not.toBeNull();
  });

  it("keeps the workspace's own name and draws no branch with the gate off", () => {
    const agent = worktreeAgent();
    const { container } = renderChat({ agent, agents: [agent, ...fixtureAgents.slice(1)] }, [space]);
    expect(place(container)).toHaveTextContent("lucky-meadow-d1ec");
    expect(place(container)).not.toHaveTextContent("membero");
    expect(place(container).parentElement!.querySelector('[data-slot="branch-label"]')).toBeNull();
  });
});

describe("AgentChat — the ⋮'s Zoom row in both views", () => {
  it.each(["terminal", "chat"] as const)("offers Zoom output from the pane menu in the %s body", async (shown) => {
    body.body = shown;
    // The device chose Off for the belt pill: the menu row is not the pill, and stays.
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ zoomPill: "off" }));
    const user = userEvent.setup();
    const onOpen = vi.fn();
    renderChat({ zoom: { open: false, onOpen, onClose: vi.fn() } });
    await user.click(await screen.findByRole("button", { name: "Pane actions" }));
    const view = await screen.findByRole("group", { name: "View" });
    await user.click(within(view).getByRole("button", { name: "Zoom output" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
