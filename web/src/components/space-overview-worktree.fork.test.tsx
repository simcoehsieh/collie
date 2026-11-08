import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceView } from "@/lib/types";
import { SpaceOverview } from "./space-overview";

// FORK — NO SECOND LINE ON A WORKTREE SPACE ROW (the 1.27 merge, 2026-11-08; lib/fork-shape.ts
// FORK_BRANCH_LABEL_ON). Upstream 1.27.0 (M81 spec 06) gives a worktree space's dashboard row a second
// line, `repo · branch · from base`. The row's standing shape here is one line, and the line leads
// with the branch the fork keeps off rows. Upstream's cases run in space-overview.test.tsx with it.
// The gate flips per case; the "on" twin proves the off case is not passing by accident.

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

beforeEach(() => {
  gates.branch = false;
});

const REPO = "/home/op/code/openplate-workspace";
const worktree: WorkspaceView = {
  workspaceId: "w2",
  number: 2,
  label: "worktree-eager-summit-7987",
  focused: false,
  activeTabId: "w2:t1",
  tabCount: 1,
  paneCount: 1,
  repoRoot: REPO,
  isWorktree: true,
  folder: "/home/op/.herdr/worktrees/openplate-workspace/worktree-eager-summit-7987",
  gitHead: { kind: "branch", name: "worktree/eager-summit-7987" },
  base: "main",
};

function mount() {
  render(
    <SpaceOverview workspaces={[worktree]} agents={[]} onOpen={vi.fn()} onNewSpace={vi.fn()} open onOpenChange={vi.fn()} />,
  );
}

describe("SpaceOverview — FORK_BRANCH_LABEL_ON and a worktree space", () => {
  it("draws the repo · branch · from base line while the gate is on (the twin)", () => {
    gates.branch = true;
    mount();
    expect(document.querySelector('[data-slot="space-row-worktree"]')).not.toBeNull();
  });

  it("draws the row on one line with the gate off: its label, no branch, no base", () => {
    mount();
    const row = screen.getByRole("button", { name: /worktree-eager-summit-7987/ });
    expect(row.querySelector('[data-slot="space-row-worktree"]')).toBeNull();
    expect(row.querySelector('[data-slot="branch-label"]')).toBeNull();
    expect(row).not.toHaveTextContent("from main");
  });
});
