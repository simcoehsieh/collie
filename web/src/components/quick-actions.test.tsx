import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { server } from "@/test/setup";
import { __resetLocale, setLocale } from "@/lib/i18n";
import type { ModelFacts } from "@/lib/model-label";
import { CodexFactsContext } from "./codex-model-group";
import { QuickActionsContent } from "./quick-actions";

// FORK — the Codex model group in the Quick dock (2026-09-26), folded to one row under the
// operator's own phrases (survey round 3). Pinned: it draws only when the composer hands it a `codex`
// prop and the host has a catalog; it opens as ONE row naming what the pane is on; the row sits
// after every phrase group; and one effort tap fires ONE pick with that model and effort — never a
// reply typed into the pane.

const catalog = {
  launchers: [],
  home: "/home/you",
  handoffModels: [
    { id: "gpt-6-sol", label: "GPT-6-Sol", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "gpt-6-luna", label: "GPT-6-Luna", efforts: ["low", "medium"], defaultEffort: "medium" },
  ],
};

function renderCodex(facts: ModelFacts | null = { model: "gpt-6-sol", effort: "high" }) {
  const onSend = vi.fn(async () => true);
  const onPick = vi.fn(async () => true);
  render(
    <CodexFactsContext.Provider value={facts}>
      <QuickActionsContent onSend={onSend} onClose={() => {}} agent="codex" isShell={false} codex={{ onPick }} />
    </CodexFactsContext.Provider>,
  );
  return { onSend, onPick };
}

describe("QuickActionsContent — Codex model group", () => {
  it("picks a model, then an effort, and sends exactly that pair", async () => {
    server.use(http.get("/api/launchers", () => HttpResponse.json(catalog)));
    const { onSend, onPick } = renderCodex();

    await userEvent.click(await screen.findByRole("button", { name: "Model / effort: gpt-6-sol·high" }));
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
    expect(screen.queryByRole("button", { name: /^Model \/ effort/ })).toBeNull();
  });

  it("opens folded: one row that names what the pane is on, and no catalog until it is tapped", async () => {
    server.use(http.get("/api/launchers", () => HttpResponse.json(catalog)));
    renderCodex({ model: "gpt-6-luna", effort: "low" });
    const row = await screen.findByRole("button", { name: "Model / effort: gpt-6-luna·low" });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "GPT-6-Sol" })).toBeNull();
    await userEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("button", { name: "GPT-6-Sol" })).toBeInTheDocument();
  });

  it("says so when the pane's log has not named a model yet", async () => {
    server.use(http.get("/api/launchers", () => HttpResponse.json(catalog)));
    renderCodex(null);
    expect(await screen.findByRole("button", { name: "Model / effort: not read yet" })).toBeInTheDocument();
  });

  it("sits under the operator's phrases, not above them", async () => {
    server.use(http.get("/api/launchers", () => HttpResponse.json(catalog)));
    renderCodex();
    const row = await screen.findByRole("button", { name: /^Model \/ effort/ });
    const phrase = screen.getByRole("button", { name: "commit and push" });
    expect(phrase.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // …and under the folded "others" group's button too: it is the last thing in the dock.
    const buttons = screen.getAllByRole("button");
    expect(buttons.at(-1)).toBe(row);
  });

  it("draws nothing on a host with no Codex catalog", async () => {
    server.use(http.get("/api/launchers", () => HttpResponse.json({ ...catalog, handoffModels: [] })));
    renderCodex();
    await screen.findByRole("button", { name: "commit and push" });
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Model \/ effort/ })).toBeNull());
  });

  describe("in the operator's language", () => {
    afterEach(() => {
      localStorage.clear();
      __resetLocale();
    });

    it("names the row in Traditional Chinese", async () => {
      setLocale("zh-TW");
      server.use(http.get("/api/launchers", () => HttpResponse.json(catalog)));
      renderCodex();
      expect(await screen.findByRole("button", { name: "模型／推理強度：gpt-6-sol·high" })).toBeInTheDocument();
    });
  });
});
