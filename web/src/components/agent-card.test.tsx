import { render, within } from "@testing-library/react";

import { AgentCard } from "./agent-card";
import { fixtureAgents } from "@/test/handlers";
import type { AgentView } from "@/lib/types";

// The row's ANATOMY, which is the thing that keeps getting re-argued: line 1 is the pane's own title
// beside a small agent tile, line 2 is `space · tab` — the address — and line 2 exists only when it
// has something to say. Addressed through `data-slot` rather than class names: the classes are a
// layout decision and are meant to move; which line a fact lands on is the contract.
//
// The cwd is left matching the space name on purpose in most cases here: `paneParts` drops a path
// that only repeats the space (lib/pane-name.ts), so that keeps each case carrying exactly the
// fields it is about.

const agent = (over: Partial<AgentView> = {}): AgentView => ({ ...fixtureAgents[0]!, ...over });

const line1 = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-slot="agent-row-title"]');
const line2 = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-slot="agent-row-detail"]');

describe("AgentCard's two lines", () => {
  it("leads with the pane title and the agent tile, and puts space then tab beneath", () => {
    const { container } = render(
      <AgentCard agent={agent({ tabLabel: "review", sessionName: "rewrite the loader" })} onClick={() => {}} />,
    );

    const top = line1(container)!;
    expect(top).toHaveTextContent("rewrite the loader");
    // The tile is the agent's own mark, inline on line 1 — not a 36px column ahead of the text.
    expect(within(top).getByRole("img", { name: "claude logo" })).toBeInTheDocument();
    // The space and the tab are NOT on line 1; that is the whole change.
    expect(top).not.toHaveTextContent("webapp");
    expect(top).not.toHaveTextContent("review");

    // Space first, then the separator, then the tab — in that order, in one line.
    expect(line2(container)).toHaveTextContent(/^webapp\s*·\s*review$/);
  });

  it("shows the space alone, with no separator, when there is no tab", () => {
    const { container } = render(
      <AgentCard agent={agent({ tabLabel: undefined, sessionName: "rewrite the loader" })} onClick={() => {}} />,
    );

    expect(line1(container)).toHaveTextContent("rewrite the loader");
    expect(line2(container)).toHaveTextContent("webapp");
    expect(line2(container)).not.toHaveTextContent("·");
  });

  it("falls back to the tab on line 1, and leaves the space alone beneath", () => {
    const { container } = render(<AgentCard agent={agent({ tabLabel: "review" })} onClick={() => {}} />);

    expect(line1(container)).toHaveTextContent("review");
    expect(line2(container)).toHaveTextContent("webapp");
    expect(line2(container)).not.toHaveTextContent("·");
  });

  it("is a ONE-line row of the space alone when there is neither a tab nor a pane title", () => {
    const { container } = render(<AgentCard agent={agent()} onClick={() => {}} />);

    expect(line1(container)).toHaveTextContent("webapp");
    expect(line2(container)).toBeNull();
  });

  // In a list already grouped under its space and tab, repeating them says nothing — so the pane's
  // own name takes line 1 and the path is all that is left for line 2. Same two shapes.
  it("leads with the pane's own name in a tab-scoped list", () => {
    const { container } = render(
      <AgentCard
        agent={agent({ tabLabel: "review", paneLabel: "logs", cwd: "/home/you/webapp/api" })}
        onClick={() => {}}
        scope="tab"
      />,
    );

    const top = line1(container)!;
    expect(top).toHaveTextContent("logs");
    expect(top).not.toHaveTextContent("webapp");
    expect(within(top).getByRole("img", { name: "claude logo" })).toBeInTheDocument();

    expect(line2(container)).toHaveTextContent("webapp/api");
    expect(line2(container)).not.toHaveTextContent("review");
  });
});

// FORK: the pin glyph and the hold.
describe("AgentCard — pinned", () => {
  it("wears the pin glyph only when pinned, and the row carries its pane id for the hotkeys", () => {
    const { container, rerender } = render(<AgentCard agent={agent()} onClick={() => {}} />);
    expect(container.querySelector('[aria-label="Pinned"]')).toBeNull();
    expect(container.querySelector("[data-pane-row]")!.getAttribute("data-pane-row")).toBe(agent().paneId);
    rerender(<AgentCard agent={agent()} onClick={() => {}} pinned />);
    expect(container.querySelector('[aria-label="Pinned"]')).not.toBeNull();
  });
});

// ── FORK: THE AGENT'S OWN STATUS LINE ────────────────────────────────────────
// `claude` / `working` is what every row already says; what it is working ON is the thing only the
// agent knows, and `collie beacon status "<line>"` is how it says so. Rendered as TEXT under the
// name and nothing more: the row still sorts, badges and opens exactly as it did.
describe("AgentCard — the agent's status line", () => {
  const statusLine = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[data-slot="agent-status-line"]');

  it("renders the sentence the agent published, under the pane's name", () => {
    const { container } = render(
      <AgentCard
        agent={agent({ statusLine: "rewriting the journal adapter", statusLineAt: Date.now() - 60_000 })}
        onClick={() => {}}
      />,
    );
    expect(statusLine(container)).toHaveTextContent("rewriting the journal adapter");
  });

  it("renders nothing at all when no agent has published one", () => {
    const { container } = render(<AgentCard agent={agent()} onClick={() => {}} />);
    expect(statusLine(container)).toBeNull();
  });

  // STALE IS DIMMED AND NEVER HIDDEN. An agent that said "running the migration" forty minutes ago
  // is still telling you the most useful thing anyone knows about that pane; a row that emptied
  // itself would only make you wonder whether the feature broke.
  it("keeps an old line and marks its age instead of dropping it", () => {
    const { container } = render(
      <AgentCard
        agent={agent({ statusLine: "running the migration", statusLineAt: Date.now() - 40 * 60_000 })}
        onClick={() => {}}
      />,
    );
    const row = statusLine(container)!;
    expect(row).toHaveTextContent("running the migration");
    expect(row).toHaveTextContent("40m");
    expect(row.className).toContain("text-muted-foreground/60");
  });

  it("a fresh line carries no age at all — the sentence is the whole of it", () => {
    const { container } = render(
      <AgentCard
        agent={agent({ statusLine: "reading the adapter", statusLineAt: Date.now() - 60_000 })}
        onClick={() => {}}
      />,
    );
    expect(statusLine(container)).toHaveTextContent(/^reading the adapter$/);
  });

  // It is CONTENT, not chrome (DESIGN.md § "Chrome wears the app face") — the words are the agent's.
  it("wears the content face, not the app's own", () => {
    const { container } = render(
      <AgentCard agent={agent({ statusLine: "planning", statusLineAt: Date.now() })} onClick={() => {}} />,
    );
    expect(statusLine(container)!.querySelector(".font-content")).not.toBeNull();
  });
});
