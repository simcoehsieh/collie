import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { server } from "@/test/setup";
import { fixtureAgents } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { __resetDiffCache } from "@/lib/api";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { clearStatus } from "@/lib/status";
import { __resetStripsCollapsed } from "@/lib/strips-collapsed";
import { __resetZen } from "@/lib/zen";
import { AgentChat } from "./agent-chat";

// FORK — THE PANE MENU REACHES THE WORKSPACE'S CHANGES AGAIN (survey round 3). The ⋮'s "What changed"
// opens the fork's diff sheet; its "Workspace changes" goes one level down to upstream's Changes view
// for the same pane, which nothing on a phone reached once the belt pill and the dashboard footer were
// switched off. This is the end-to-end path through the pane view, router and all.

const stat = {
  ok: true,
  mode: "stat",
  cwd: "/home/you/webapp",
  repoRoot: "/home/you/webapp",
  branch: "main",
  files: [],
  truncated: false,
};

beforeAll(() => {
  // jsdom doesn't implement scrollTo; the terminal mirror's auto-scroll calls it.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  __resetZen();
  __resetStripsCollapsed();
  __resetOperatorCommands();
  __resetDiffCache();
  server.use(http.get(/\/api\/pane\/[^/]+\/diff/, () => HttpResponse.json(stat)));
});

function renderPane(agent: (typeof fixtureAgents)[number]) {
  const props: ComponentProps<typeof AgentChat> = {
    paneId: agent.paneId,
    agent,
    agents: [agent],
    shellPanes: [],
    tabs: [],
    text: "recent pane output",
    onBack: vi.fn(),
    onSelect: vi.fn(),
  };
  const router = createMemoryRouter([
    { path: "/", element: withHeaderHost(<AgentChat {...props} />) },
    { path: "/pane/:paneId/changes/*", element: <div>workspace changes route</div> },
  ]);
  render(<RouterProvider router={router} />);
  return router;
}

describe("AgentChat — the diff sheet's door to the workspace's Changes", () => {
  it("goes down to the pane's Changes route, closing the sheet on the way", async () => {
    const user = userEvent.setup();
    const agent = fixtureAgents[0]!;
    const router = renderPane(agent);
    await user.click(screen.getByRole("button", { name: "Pane actions" }));
    await user.click(screen.getByRole("button", { name: "What changed" }));
    await user.click(await screen.findByRole("button", { name: "Workspace changes" }));
    expect(await screen.findByText("workspace changes route")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/pane/${encodeURIComponent(agent.paneId)}/changes`);
  });

  it("offers no door on a pane that reports no folder — there is no workspace to read", async () => {
    const user = userEvent.setup();
    renderPane({ ...fixtureAgents[0]!, cwd: "" });
    await user.click(screen.getByRole("button", { name: "Pane actions" }));
    await user.click(screen.getByRole("button", { name: "What changed" }));
    expect(await screen.findByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Workspace changes" })).toBeNull();
  });
});
