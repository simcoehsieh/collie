// FORK: no Switch mark and no Changes pill on the belt (lib/belt-pins.ts). Upstream's cases in
// actions-row.test.tsx run WITH them, because the gate is on under vitest; this file turns it off the
// way the production bundle has it, and pins what the operator sees.

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

describe("the belt without its pinned pills (fork)", () => {
  it("draws neither the Switch mark nor the Changes pill, even when the pane offers both", () => {
    render(
      <ActionsRow
        general={[keys]}
        agent="claude"
        onRun={took}
        handle={{ ref: vi.fn(), onClick: vi.fn(), label: "Switch pane", alert: true }}
        changes={{ onClick: vi.fn(), label: "Changes" }}
      />,
    );
    expect(screen.queryByRole("button", { name: "Switch pane" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Changes" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keys" })).toBeInTheDocument();
  });

  it("keeps the belt as the switcher's drag surface", () => {
    const ref = vi.fn();
    render(<ActionsRow general={[keys]} agent="claude" onRun={took} handle={{ ref, onClick: vi.fn(), label: "Switch pane" }} />);
    const belt = document.querySelector('[data-slot="composer-actions"]');
    expect(belt).not.toBeNull();
    expect(ref).toHaveBeenCalledWith(belt);
  });
});
