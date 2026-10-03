import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { server } from "@/test/setup";
import { fixtureAgents } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { clearStatus } from "@/lib/status";
import { __resetStripsCollapsed } from "@/lib/strips-collapsed";
import { __resetZen } from "@/lib/zen";
import { AgentChat } from "./agent-chat";

// FORK — THE CODEX ROW NAMES WHAT THE PANE IS ON (survey round 3). The model and effort the agent's
// own log last stated ride the snapshot (bridge/session-facts.ts); the pane view hands them to the
// Quick dock's Codex row through a context, past a composer that never reads them. This walks that
// path through the real pane view: a Codex pane on gpt-6-astra at high opens Quick on one row that
// says so, folded, under the phrases.

beforeAll(() => {
  // jsdom doesn't implement scrollTo; the terminal mirror's auto-scroll calls it.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  __resetZen();
  __resetStripsCollapsed();
  __resetOperatorCommands();
  server.use(
    http.get("/api/launchers", () =>
      HttpResponse.json({
        launchers: [],
        home: "/home/you",
        handoffModels: [{ id: "gpt-6-astra", label: "GPT-6-Astra", efforts: ["low", "high"], defaultEffort: "low" }],
      }),
    ),
  );
});

it("a Codex pane's Quick opens on one folded row naming the pane's model and effort", async () => {
  const user = userEvent.setup();
  const agent = { ...fixtureAgents[0]!, agent: "codex", status: "idle" as const, model: "gpt-6-astra", effort: "high" };
  const props: ComponentProps<typeof AgentChat> = {
    paneId: agent.paneId,
    agent,
    agents: [agent],
    shellPanes: [],
    tabs: [],
    text: "› ",
    onBack: vi.fn(),
    onSelect: vi.fn(),
  };
  render(
    <RouterProvider router={createMemoryRouter([{ path: "/", element: withHeaderHost(<AgentChat {...props} />) }])} />,
  );
  await user.click(screen.getByRole("button", { name: "Quick" }));
  const row = await screen.findByRole("button", { name: "Model / effort: gpt-6-astra·high" });
  expect(row).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("button", { name: "GPT-6-Astra" })).toBeNull();
});
