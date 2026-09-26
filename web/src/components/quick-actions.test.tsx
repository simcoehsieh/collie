import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { server } from "@/test/setup";
import { QuickActionsContent } from "./quick-actions";

// FORK — the Codex model group in the Quick dock (2026-09-26). Pinned: it draws only when the
// composer hands it a `codex` prop, efforts appear for the tapped model only, and one effort tap
// fires ONE pick with that model and effort — never a reply typed into the pane.

const catalog = {
  launchers: [],
  home: "/home/you",
  handoffModels: [
    { id: "gpt-6-sol", label: "GPT-6-Sol", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "gpt-6-luna", label: "GPT-6-Luna", efforts: ["low", "medium"], defaultEffort: "medium" },
  ],
};

describe("QuickActionsContent — Codex model group", () => {
  it("picks a model, then an effort, and sends exactly that pair", async () => {
    server.use(http.get("/api/launchers", () => HttpResponse.json(catalog)));
    const onSend = vi.fn(async () => true);
    const onPick = vi.fn(async () => true);
    render(<QuickActionsContent onSend={onSend} onClose={() => {}} agent="codex" isShell={false} codex={{ onPick }} />);

    const sol = await screen.findByRole("button", { name: "GPT-6-Sol" });
    expect(screen.queryByRole("button", { name: "high" })).toBeNull();
    await userEvent.click(sol);
    await userEvent.click(screen.getByRole("button", { name: "high" }));

    await waitFor(() => expect(onPick).toHaveBeenCalledWith("gpt-6-sol", "high"));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("is absent without the codex prop", async () => {
    server.use(http.get("/api/launchers", () => HttpResponse.json(catalog)));
    render(<QuickActionsContent onSend={async () => true} onClose={() => {}} agent="claude" isShell={false} />);
    // The ordinary groups render; no catalog button ever appears.
    await screen.findByRole("button", { name: "commit and push" });
    expect(screen.queryByRole("button", { name: "GPT-6-Sol" })).toBeNull();
  });
});
