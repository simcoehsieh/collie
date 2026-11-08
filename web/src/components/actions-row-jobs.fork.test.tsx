// FORK: no pinned pills on the belt (lib/belt-pins.ts), and upstream 1.27's jobs mark (issue 670, ADR
// 0128) stands in that pinned block, so it is off under the same gate. Upstream's actions-row.test.tsx
// runs with the mark (MODE `test`); this file turns the gate off the way the production bundle has it.

import { render, screen } from "@testing-library/react";
import { Keyboard } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { __resetHarnessBar } from "@/lib/harness-bar-pref";
import { ActionsRow, type GeneralAction } from "./actions-row";

vi.mock("@/lib/belt-pins", () => ({ FORK_BELT_PINS_ON: false }));

afterEach(() => {
  __resetHarnessBar();
  localStorage.clear();
});

const took = async () => true;
const keys: GeneralAction = { id: "keys", icon: Keyboard, label: "Keys", onSelect: vi.fn() };

describe("the belt without its pinned jobs mark (fork)", () => {
  it("draws no jobs mark when the pane has a job running", () => {
    render(
      <ActionsRow
        general={[keys]}
        agent="claude"
        onRun={took}
        jobs={{ count: 2, onClick: vi.fn(), label: "Jobs 2", expanded: false }}
      />,
    );
    expect(screen.getByRole("button", { name: "Keys" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Jobs 2" })).not.toBeInTheDocument();
    expect(document.querySelector('[data-slot="belt-jobs"]')).toBeNull();
  });
});
