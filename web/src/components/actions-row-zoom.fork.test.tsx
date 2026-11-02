// FORK: no pinned pills on the belt (lib/belt-pins.ts), and upstream 1.25's Zoom pill stands in that
// pinned block, so it is off under the same gate. Its door is the "Zoom" row of the grouped pane menu
// (pane-actions-sheet.tsx). Upstream's actions-row.test.tsx runs with the pill (MODE `test`).

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

describe("the belt without its pinned Zoom pill (fork)", () => {
  it("draws no Zoom pill when the pane offers one, and keeps Stop at the belt's start", () => {
    render(
      <ActionsRow
        general={[keys]}
        agent="claude"
        onRun={took}
        zoom={{ onClick: vi.fn(), label: "Zoom output" }}
        stop={{ onStop: vi.fn(async () => {}), paneId: "w1:p1", running: true }}
      />,
    );
    expect(screen.queryByRole("button", { name: "Zoom output" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keys" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
  });
});
