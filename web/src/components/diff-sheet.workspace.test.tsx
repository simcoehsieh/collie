import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "@/test/setup";
import { __resetDiffCache } from "@/lib/api";
import { __resetLocale, setLocale } from "@/lib/i18n";
import { __resetNotes } from "@/lib/notes";
import { DiffSheet } from "./diff-sheet";

// FORK — THE DIFF SHEET'S DOOR TO THE WORKSPACE'S CHANGES (survey round 3). The sheet reads one repo,
// the pane's own; upstream's Changes view reads every repo of the workspace, and with the belt pill
// and the dashboard footer both off by standing decision, this labelled button on the list's tool
// row is its door. What is pinned: it is there only when it can lead somewhere, it is a real labelled
// target with a hit area, it hands over without doing anything else, and the repo line it sits under
// stays put in a patch.

const FACE = { className: "", style: undefined };

const stat = {
  ok: true,
  mode: "stat",
  cwd: "/home/op/git/proj",
  repoRoot: "/home/op/git/proj",
  branch: "main",
  files: [{ path: "a.ts", status: "M", staged: false, additions: 3, deletions: 1, binary: false }],
  truncated: false,
};

const patch = {
  ok: true,
  mode: "patch",
  path: "a.ts",
  patch: "diff --git a/a.ts b/a.ts\n@@ -1,1 +1,2 @@\n one\n+two\n",
  truncated: false,
};

beforeEach(() => {
  __resetDiffCache();
  __resetNotes();
  server.use(
    http.get(/\/api\/pane\/[^/]+\/diff/, ({ request }) =>
      new URL(request.url).searchParams.get("mode") === "patch" ? HttpResponse.json(patch) : HttpResponse.json(stat),
    ),
  );
});

function renderSheet(onWorkspaceChanges?: () => void) {
  return render(
    <DiffSheet
      open
      onClose={vi.fn()}
      paneId="w1:p1"
      fontSize={12}
      mirrorFace={FACE}
      home="/home/op"
      onOpenFile={vi.fn()}
      onWorkspaceChanges={onWorkspaceChanges}
    />,
  );
}

describe("DiffSheet — the workspace's Changes", () => {
  it("offers a labelled door on the list's tool row, and hands over on a tap", async () => {
    const user = userEvent.setup();
    const go = vi.fn();
    renderSheet(go);
    const door = await screen.findByRole("button", { name: "Workspace changes" });
    expect(door).toHaveAttribute("title", "Open every repo's changes in this workspace");
    // A real hit area, not a bare 32px face (ui/hit-area.tsx; measured in e2e/hit-areas.spec.ts).
    expect(door.querySelector(':scope > [data-slot="hit-area"]')).not.toBeNull();
    await user.click(door);
    expect(go).toHaveBeenCalledTimes(1);
  });

  it("draws no door when there is nowhere to go — a pane with no folder", async () => {
    renderSheet(undefined);
    expect(await screen.findByText("a.ts")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Workspace changes" })).toBeNull();
  });

  it("leaves the door off a patch's row, and keeps the repo line under the title there", async () => {
    const user = userEvent.setup();
    renderSheet(vi.fn());
    await user.click(await screen.findByText("a.ts"));
    expect(await screen.findByRole("button", { name: /back to the file list/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Workspace changes" })).toBeNull();
    expect(screen.getByText("main · ~/git/proj")).toBeInTheDocument();
  });

  it("says it in Traditional Chinese", async () => {
    setLocale("zh-TW");
    try {
      renderSheet(vi.fn());
      expect(await screen.findByRole("button", { name: "工作區變更" })).toBeInTheDocument();
    } finally {
      localStorage.clear();
      __resetLocale();
    }
  });
});
