import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PaneStrip } from "@/components/pane-strip";
import { TabStrip } from "@/components/tab-strip";
import { composerLayout } from "@/lib/composer-layout";
import { DEFAULT_FONT, fontClass } from "@/lib/design";
import { tabLook, useTabLook } from "@/lib/tab-look";
import { useActiveTheme } from "@/lib/theme/store";
import type { AgentView, TabView } from "@/lib/types";

// FORK — NO NEW DEFAULT LOOK (the 1.27 merge, 2026-11-08; lib/fork-shape.ts FORK_NEW_LOOK_ON).
// Upstream 1.27.0 folds "Collie New" into the default theme `collie`, whose file now names the folder
// tab (`tabs: folder`) and the chat-box composer (`composer: box`), and makes Atkinson Hyperlegible the
// default face over a crossed grain. Off here: the default theme on screen still names both words,
// and the tab row, the pane row and the composer read them as `plain` and `field`; the default face is
// the system one and the page carries no grain. Upstream's own cases (tab-look.test.ts,
// composer-layout.test.ts, tab-strip.test.tsx, pane-strip.test.tsx) run with the look.

vi.mock("@/lib/fork-shape", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/fork-shape")>()),
  FORK_NEW_LOOK_ON: false,
}));

const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");

const tabs: TabView[] = [
  { tabId: "w1:t1", workspaceId: "w1", number: 1, label: "Alpha", focused: true, paneCount: 2 },
  { tabId: "w1:t2", workspaceId: "w1", number: 2, label: "Beta", focused: false, paneCount: 1 },
];

function pane(paneId: string, agent: string): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "proj",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent,
    status: "idle",
    cwd: "/home/proj",
    focused: false,
    kind: "agent",
  };
}

describe("FORK: the 1.27 default look is off", () => {
  it("leaves the default theme's words in its file, so the gate is what turns them off", () => {
    const { result } = renderHook(() => useActiveTheme());
    expect(result.current.id).toBe("collie");
    expect(result.current.theme.surface?.tabs).toBe("folder");
    expect(result.current.theme.surface?.composer).toBe("box");
  });

  it("reads every tab word as plain, and the theme on screen as plain", () => {
    expect(tabLook("folder")).toBe("plain");
    expect(tabLook(undefined)).toBe("plain");
    expect(renderHook(() => useTabLook()).result.current).toBe("plain");
  });

  it("reads every composer word as field, so the composer gets the fork's field", () => {
    expect(composerLayout("box")).toBe("field");
    expect(composerLayout(undefined)).toBe("field");
  });

  it("draws the tab row without a folder tab under the default theme", () => {
    render(
      <TabStrip
        workspaceId="w1"
        tabs={tabs}
        agents={[]}
        selected="w1:t1"
        onSelect={vi.fn()}
        onNewTab={vi.fn()}
        allowAll={false}
      />,
    );
    const open = screen.getByRole("button", { name: "Alpha" });
    expect(open.className).not.toMatch(/border-x|bg-background|rounded-t|shadow-|tab-active/);
    expect(open.className).toMatch(/(?:^|\s)font-semibold(?=\s|$)/);
    const nav = screen.getByRole("navigation", { name: "Tabs" });
    expect(nav.className).not.toMatch(/shadow-|pt-1\.5/);
    expect(screen.getByRole("button", { name: "New tab" }).className).not.toMatch(/(?:^|\s)ml-3(?=\s|$)/);
  });

  it("draws the open pane as the fork's tonal pill, not a ringed cell", () => {
    render(<PaneStrip panes={[pane("w1:p1", "claude"), pane("w1:p2", "codex")]} currentPaneId="w1:p1" onSelect={vi.fn()} />);
    expect(screen.getByRole("navigation", { name: "Panes" }).className).toMatch(/(?:^|\s)bg-chrome(?=\s|$)/);
    const open = screen.getByRole("button", { name: /claude/ });
    expect(open.className).toMatch(/(?:^|\s)bg-control-on(?=\s|$)/);
    expect(open.className).not.toMatch(/ring-tab-active|tab-active/);
  });

  it("keeps the system face as the default, with Atkinson an opt-in class", () => {
    expect(DEFAULT_FONT).toBe("system");
    expect(fontClass(DEFAULT_FONT)).toBe("");
    expect(fontClass("atkinson")).toBe("font-atkinson");
    const css = read("../index.css");
    const stack = /--font-sans:\s*([\s\S]*?);/.exec(css)?.[1] ?? "";
    expect(stack).not.toContain("Atkinson");
    expect(read("../../public/theme-init.js")).toContain('d.font === "atkinson") root.classList.add("font-atkinson")');
    expect(read("../../index.html")).not.toMatch(/rel="preload"[^>]*atkinson/);
  });

  it("paints no grain behind the page", () => {
    const css = read("../index.css");
    expect(/^\s*--ground-image:\s*none;/m.test(css)).toBe(true);
    expect(css).not.toMatch(/^\s*--ground-image:\s*repeating-linear-gradient/m);
  });
});
