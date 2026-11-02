// FORK: no Report a problem on this install (lib/fork-shape.ts `FORK_REPORT_ON`). Upstream's cases in
// unread-dialog-block.test.tsx run WITH the Report row, because the gate is on under vitest; this file
// turns it off the way the production bundle has it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { buildBlocks } from "@/lib/harness";
import { UnreadDialogBlock } from "./unread-dialog-block";

vi.mock("@/lib/fork-shape", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/fork-shape")>()),
  FORK_REPORT_ON: false,
}));

const SCREEN = readFileSync(
  join(import.meta.dirname, "..", "fixtures", "panes", "claude-lab--menu-status-screen--w82.txt"),
  "utf8",
);

describe("the unread-dialog card without Report a problem (fork)", () => {
  it("draws no Report row even when a handler is passed, and keeps its key", () => {
    const block = buildBlocks(splitLines(parseAnsi(SCREEN)), { agent: "claude" }).find((b) => b.kind === "unread-dialog");
    if (!block || block.kind !== "unread-dialog") throw new Error("the fixture produced no card");
    const { container } = render(
      <UnreadDialogBlock cancel={block.cancel} lines={block.lines} onAction={vi.fn()} onReport={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: "Report a problem" })).toBeNull();
    expect(container.querySelector('[data-slot="unread-dialog-report"]')).toBeNull();
    expect(screen.getByRole("button", { name: /esc/i })).toBeInTheDocument();
  });
});
