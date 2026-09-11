import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CinemaCapsule } from "./cinema-capsule";

// FORK: cinema mode folds the header and both strips away, so this capsule is the ONLY thing left
// answering "what am I looking at, and is it alright". What is pinned is that it keeps answering
// both halves, and that it is a way out rather than a label.
describe("CinemaCapsule", () => {
  it("names the pane and offers the way back", async () => {
    const user = userEvent.setup();
    const onExit = vi.fn();
    render(<CinemaCapsule name="docs" status="working" onExit={onExit} />);

    expect(screen.getByText("docs")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Show the header and strips again" });
    await user.click(button);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("carries the pane's status, which is the half no other surface is left to carry", () => {
    const { container } = render(<CinemaCapsule name="docs" status="blocked" onExit={vi.fn()} />);
    // The dot is colour-only and deliberately unnamed here (the capsule's own label is the
    // accessible name for the control) — so it is found as the element it is, not by text.
    expect(container.querySelector(".bg-status-blocked, .border-status-blocked")).not.toBeNull();
  });

  it("draws no dot for a shell pane, which has no agent status to report", () => {
    const { container } = render(<CinemaCapsule name="bash" onExit={vi.fn()} />);
    expect(screen.getByText("bash")).toBeInTheDocument();
    expect(container.querySelector('[class*="status-"]')).toBeNull();
  });

  it("stays 28px drawn, and buys its tap floor without taking the mirror's pixels", () => {
    render(<CinemaCapsule name="docs" onExit={vi.fn()} />);
    const button = screen.getByRole("button");
    // h-7 = 28px drawn; the hit box is the transparent `before:-inset-2`, the same technique the
    // strips use (ui/labelled-strip.tsx) — a control floating over a terminal must not physically
    // occupy 44px of the thing it floats over.
    expect(button.className).toMatch(/(?:^|\s)h-7(?=\s|$)/);
    expect(button.className).toContain("before:-inset-2");
  });
});
