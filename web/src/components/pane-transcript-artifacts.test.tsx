import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetArtifacts } from "@/lib/artifacts";
import { __resetHistoryCache } from "@/lib/api";
import { fixtureTranscript } from "@/test/handlers";
import { fixtureArtifact } from "@/test/artifacts";
import { server } from "@/test/setup";
import { PaneTranscript } from "./pane-transcript";

// FORK: the artifacts a pane's turns made, drawn under the turn that made each (lib/artifacts.ts
// attaches; components/pane-transcript.tsx mounts). Pinned: the card sits inside the right turn,
// another pane's artifact is not here, and a tap hands the artifact up — the transcript does not
// navigate on its own (it is rendered without a router in every other case in this tree).

function history() {
  server.use(
    http.get(/\/api\/pane\/[^/]+\/history/, () =>
      HttpResponse.json({
        paneId: "w1:p1",
        available: true,
        entries: fixtureTranscript,
        hasMore: false,
        total: fixtureTranscript.length,
        fileTruncated: false,
      }),
    ),
  );
}

beforeEach(() => {
  __resetArtifacts();
  __resetHistoryCache();
});
afterEach(() => __resetArtifacts());

describe("PaneTranscript — artifacts under their turns", () => {
  it("draws this pane's artifact inside the turn that made it, and hands a tap up", async () => {
    history();
    const mine = fixtureArtifact({ id: "a1-00000001", createdMs: Date.parse("2026-07-25T06:22:30.000Z") });
    const theirs = fixtureArtifact({
      id: "a2-00000002",
      title: "Someone else's",
      createdMs: Date.parse("2026-07-25T06:22:31.000Z"),
      pane: { paneId: "w2:p1", workspaceId: "w2", workspaceLabel: "collie", agent: "codex" },
    });
    server.use(http.get("/api/artifacts", () => HttpResponse.json({ ok: true, artifacts: [mine, theirs] })));
    const onOpenArtifact = vi.fn();
    render(
      <PaneTranscript
        paneId="w1:p1"
        agent="claude"
        working={false}
        mirrorText="some screen"
        onShowTerminal={() => {}}
        onOpenArtifact={onOpenArtifact}
      />,
    );
    const card = await screen.findByRole("button", { name: "Open Q3 report" });
    // Inside the assistant turn (t2), not the user's question before it.
    expect(card.closest("[data-turn]")?.getAttribute("data-turn")).toBe("t2");
    expect(screen.queryByRole("button", { name: "Open Someone else's" })).not.toBeInTheDocument();
    await userEvent.setup().click(card);
    expect(onOpenArtifact).toHaveBeenCalledWith(mine);
  });
});
