// FORK: no model tag in a pane's corner (lib/fork-shape.ts `FORK_MODEL_TAG_ON`), and so none of what
// upstream 1.24 put in it: the context dots, the 5-hour and 7-day limit dots, the session cost. The
// large-screen column (upstream 1.24.0, itself off here under FORK_WIDE_LAYOUT_ON) drew the tag on its
// own; this file turns the tag gate off and pins that the column draws none of it either.

import { render, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { AgentView } from "@/lib/types";
import { server } from "@/test/setup";
import { PaneColumnBody } from "./strip-column";

vi.mock("@/lib/fork-shape", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/fork-shape")>()),
  FORK_MODEL_TAG_ON: false,
}));

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

const PANE: AgentView = {
  paneId: "w1:p1",
  workspaceId: "w1",
  workspaceLabel: "alpha",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: "claude",
  paneLabel: "w1:p1",
  status: "working",
  cwd: "/home/me/proj",
  focused: false,
  kind: "agent",
  model: "claude-opus-4-1",
  effort: "high",
  usage: { context: 42, limits: [{ window: "5h", used: 30 }, { window: "7d", used: 60 }], cost: 1.25 },
};

describe("the large-screen column without the model tag (fork)", () => {
  it("draws no model, no usage dots and no cost on the column's corner", async () => {
    server.use(http.get("/api/pane/:id", () => HttpResponse.json({ text: "preview rows", truncated: false, revision: 1 })));
    const router = createMemoryRouter([{ path: "/", element: <PaneColumnBody pane={PANE} scope={{}} onIntent={vi.fn()} /> }]);
    const { container } = render(<RouterProvider router={router} />);
    await waitFor(() => expect(container.textContent).toContain("preview rows"));
    expect(container.textContent).not.toContain("Opus 4.1");
    expect(container.textContent).not.toContain("$1.25");
    expect(container.querySelector('[data-slot="model-tag"]')).toBeNull();
  });
});
