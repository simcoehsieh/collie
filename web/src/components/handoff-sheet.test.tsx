import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { HANDOFF_SENTINEL } from "@/lib/handoff";
import { fixtureArtifact } from "@/test/artifacts";
import { server } from "@/test/setup";
import type { AgentStatus, AgentView, Launcher } from "@/lib/types";
import { HandoffSheet } from "./handoff-sheet";

// FORK — the handoff sheet (components/handoff-sheet.tsx). Pinned: the summary ask goes to the pane
// as a reply and the handoff waits for the pane to work and stop; skipping the summary hands off at
// once; a failure stays on the form with its reason; the current agent's own row is never offered.

const pane: AgentView = {
  paneId: "w1:p1",
  workspaceId: "w1",
  workspaceLabel: "webapp",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: "claude",
  status: "done",
  cwd: "/home/you/webapp",
  focused: false,
};

const launchers: Launcher[] = [
  { command: "claude", label: "claude" },
  { command: "codex", label: "codex" },
  { command: "agy", label: "agy" },
];

function renderSheet(status: AgentStatus, onLaunched = vi.fn(), onClose = vi.fn()) {
  const view = render(
    <HandoffSheet open onClose={onClose} pane={pane} status={status} launchers={launchers} onLaunched={onLaunched} />,
  );
  const rerenderWith = (next: AgentStatus, open = true) =>
    view.rerender(
      <HandoffSheet open={open} onClose={onClose} pane={pane} status={next} launchers={launchers} onLaunched={onLaunched} />,
    );
  return { onLaunched, onClose, rerenderWith };
}

function bridge() {
  const replies: { text: string; submit: boolean }[] = [];
  const handoffs: { command: string; instruction: string }[] = [];
  server.use(
    http.post("/api/pane/w1%3Ap1/reply", async ({ request }) => {
      // SAFETY: the sheet's own client wrote this body (lib/api.ts sendReply) — the shape it names.
      replies.push((await request.json()) as { text: string; submit: boolean });
      return HttpResponse.json({ ok: true });
    }),
    http.post("/api/pane/w1%3Ap1/handoff", async ({ request }) => {
      // SAFETY: as above, for lib/api.ts handoffPane.
      handoffs.push((await request.json()) as { command: string; instruction: string });
      return HttpResponse.json({
        ok: true,
        pane: { paneId: "w1:p7", workspaceId: "w1", workspaceLabel: "webapp", tabId: "w1:t7", cwd: "/home/you/webapp" },
        artifact: fixtureArtifact({ id: "h1-00000001", title: "Handoff · claude → codex", kind: "markdown", ext: "md" }),
      });
    }),
  );
  return { replies, handoffs };
}

describe("HandoffSheet", () => {
  it("sends a selected Codex model and only that model's supported effort", async () => {
    const { handoffs } = bridge();
    server.use(http.get("/api/launchers", () => HttpResponse.json({ launchers, home: "/home/you", handoffModels: [
      { id: "codex-test", label: "Test Codex", efforts: ["low", "high"], defaultEffort: "low" },
      { id: "codex-other", label: "Other Codex", efforts: ["medium"], defaultEffort: "medium" },
    ] })));
    const user = userEvent.setup();
    renderSheet("done");
    await screen.findByRole("option", { name: "Test Codex" });
    await user.selectOptions(screen.getByLabelText("Codex model"), "codex-test");
    expect(screen.getByLabelText("Reasoning effort")).toHaveValue("low");
    await user.selectOptions(screen.getByLabelText("Reasoning effort"), "high");
    await user.selectOptions(screen.getByLabelText("Codex model"), "codex-other");
    expect(screen.getByLabelText("Reasoning effort")).toHaveValue("medium");
    expect(screen.queryByRole("option", { name: "high" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /Ask claude/ }));
    await user.click(screen.getByRole("button", { name: "Hand off to codex" }));
    await waitFor(() => expect(handoffs).toEqual([{ command: "codex", instruction: "", model: "codex-other", effort: "medium" }]));
  });

  it("closing while the summary request is pending prevents a delayed handoff", async () => {
    const { handoffs } = bridge();
    let finish: (() => void) | undefined;
    server.use(http.post("/api/pane/w1%3Ap1/reply", async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return HttpResponse.json({ ok: true });
    }));
    const user = userEvent.setup();
    const { rerenderWith } = renderSheet("done");
    await user.click(screen.getByRole("button", { name: "Hand off to codex" }));
    await waitFor(() => expect(finish).toBeDefined());
    rerenderWith("working", false);
    finish?.();
    rerenderWith("done", false);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(handoffs).toEqual([]);
  });

  it("offers every other harness, never the pane's own", () => {
    renderSheet("done");
    const group = screen.getByRole("radiogroup", { name: "Who takes over" });
    expect(group).toHaveTextContent("codex");
    expect(group).toHaveTextContent("agy");
    expect(screen.queryByRole("radio", { name: "claude" })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "codex" })).toHaveAttribute("aria-checked", "true");
  });

  it("asks the pane for a summary, waits for it to work and stop, then hands off and opens the new pane", async () => {
    const { replies, handoffs } = bridge();
    const user = userEvent.setup();
    const { onLaunched, onClose, rerenderWith } = renderSheet("done");
    await user.click(screen.getByRole("radio", { name: "agy" }));
    await user.type(screen.getByLabelText("What should they do next"), "Finish the tests");
    await user.click(screen.getByRole("button", { name: "Hand off to agy" }));
    await waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]?.text.startsWith(HANDOFF_SENTINEL)).toBe(true);
    expect(replies[0]?.submit).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for claude to write the summary…");
    // Still `done` from before the ask: not settled yet.
    expect(handoffs).toHaveLength(0);
    rerenderWith("working");
    expect(handoffs).toHaveLength(0);
    rerenderWith("done");
    await waitFor(() => expect(handoffs).toHaveLength(1));
    expect(handoffs[0]).toEqual({ command: "agy", instruction: "Finish the tests" });
    await waitFor(() => expect(onLaunched).toHaveBeenCalledWith("w1:p7", expect.objectContaining({ id: "h1-00000001" })));
    expect(onClose).toHaveBeenCalled();
  });

  it("hands off at once when the summary is not wanted", async () => {
    const { replies, handoffs } = bridge();
    const user = userEvent.setup();
    const { onLaunched } = renderSheet("working");
    await user.click(screen.getByRole("checkbox", { name: "Ask claude to write a handoff summary first" }));
    await user.click(screen.getByRole("button", { name: "Hand off to codex" }));
    await waitFor(() => expect(onLaunched).toHaveBeenCalledWith("w1:p7", expect.anything()));
    expect(replies).toHaveLength(0);
    expect(handoffs).toEqual([{ command: "codex", instruction: "" }]);
  });

  it("'hand off now' skips the rest of a summary being written", async () => {
    const { handoffs } = bridge();
    const user = userEvent.setup();
    const { onLaunched, rerenderWith } = renderSheet("done");
    await user.click(screen.getByRole("button", { name: "Hand off to codex" }));
    rerenderWith("working");
    await user.click(await screen.findByRole("button", { name: "Hand off now, without the rest" }));
    await waitFor(() => expect(handoffs).toHaveLength(1));
    await waitFor(() => expect(onLaunched).toHaveBeenCalled());
  });

  it("a refused handoff stays on the form and says why", async () => {
    server.use(
      http.post("/api/pane/w1%3Ap1/handoff", () =>
        HttpResponse.json({ ok: false, error: "command not allowlisted", code: "launch.not_allowlisted" }),
      ),
    );
    const user = userEvent.setup();
    const { onLaunched } = renderSheet("done");
    await user.click(screen.getByRole("checkbox", { name: /Ask claude/ }));
    await user.click(screen.getByRole("button", { name: "Hand off to codex" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Handoff failed:/);
    expect(onLaunched).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Hand off to codex" })).toBeEnabled();
  });

  it("says so when no launcher starts another harness", () => {
    render(<HandoffSheet open onClose={vi.fn()} pane={pane} status="done" launchers={[{ command: "claude", label: "claude" }]} onLaunched={vi.fn()} />);
    expect(screen.getByText(/No launcher starts another agent/)).toBeInTheDocument();
  });
});
