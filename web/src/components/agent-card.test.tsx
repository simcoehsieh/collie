import { cleanup, render, within } from "@testing-library/react";

import { AgentCard } from "./agent-card";
import { fixtureAgents } from "@/test/handlers";
import type { AgentView } from "@/lib/types";

// The row's ANATOMY, which is the thing that keeps getting re-argued: line 1 is the pane's NAME
// beside a small agent tile, line 2 is its PLACE, `space › tab`. One name, one place, the same way
// round on every surface (lib/pane-name.ts). Addressed through `data-slot` rather than class names:
// the classes are a layout decision and are meant to move; which line a fact lands on is the
// contract.

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

    // Space first, then the crumb, then the tab — in that order, in one line.
    expect(line2(container)).toHaveTextContent(/^webapp\s*›\s*review$/);
  });

  it("shows the space alone, with no separator, when there is no tab", () => {
    const { container } = render(
      <AgentCard agent={agent({ tabLabel: undefined, sessionName: "rewrite the loader" })} onClick={() => {}} />,
    );

    expect(line1(container)).toHaveTextContent("rewrite the loader");
    expect(line2(container)).toHaveTextContent("webapp");
    expect(line2(container)).not.toHaveTextContent("›");
  });

  it("NEVER leads with the place: a pane with no name of its own reads as its agent", () => {
    const { container } = render(<AgentCard agent={agent({ tabLabel: "review" })} onClick={() => {}} />);

    // The old rule promoted the tab to line 1 here, so one pane was called "review" on this screen
    // and something else on the next. The agent word is the floor, and the place stays on line 2.
    expect(line1(container)).toHaveTextContent("claude");
    expect(line2(container)).toHaveTextContent(/^webapp\s*›\s*review$/);
  });

  it("still shows the place beneath a pane that has neither a tab nor a name", () => {
    const { container } = render(<AgentCard agent={agent()} onClick={() => {}} />);

    expect(line1(container)).toHaveTextContent("claude");
    expect(line2(container)).toHaveTextContent("webapp");
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

// ── FORK: A TAB NAMED AFTER THE HARNESS IS NOT AN ADDRESS ───────────────────
// Tabs opened from `launchers.toml` are called `claude` / `codex` / `agy`, so line 2 repeated in
// words the tile already on line 1. A tab with a name of its own still shows it.
describe("AgentCard — line 2 withholds a tab that just names the agent", () => {
  const at = (over: Partial<AgentView>) =>
    render(
      <AgentCard agent={agent(over)} onClick={() => {}} scope="place" statusStyle="dot" density="row" />,
    ).container;

  it("drops the tab when it is the agent's own name, in any spelling", () => {
    for (const tabLabel of ["claude", "Claude", "claude-code", "codex"]) {
      const c = at({ tabLabel, agent: tabLabel.startsWith("codex") ? "codex" : "claude" });
      expect(c.querySelector('[data-slot="agent-row-detail"]')).toBeNull();
      cleanup();
    }
  });

  it("keeps a tab that names something", () => {
    const c = at({ tabLabel: "develop", agent: "claude" });
    expect(c.querySelector('[data-slot="agent-row-detail"]')).toHaveTextContent("develop");
  });
});

// ── FORK: THE ROW IS ONE LINE, AND IT IS NOT THE HARNESS'S NAME ─────────────
// Upstream 1.10.0 gave a named one-pane tab's row the agent's self-written title on line 2. Here
// every pane comes out of `launchers.toml`, so its tab is CALLED `claude` — which made line 1 say
// in words what the tile says in a picture, and pushed the only distinguishing text into grey on
// line 2. The operator's standing shape (2026-09-16): the title moves up and line 2 goes away.
// Pinned here so an upstream merge cannot quietly hand the second line back.
describe("AgentCard — a row named after the harness takes its title instead", () => {
  const at = (over: Partial<AgentView>) =>
    render(
      <AgentCard agent={agent(over)} onClick={() => {}} scope="place" statusStyle="dot" density="row" />,
    ).container;

  it("promotes the title to line 1 and leaves no line 2", () => {
    const c = at({ soleTabName: "claude", agent: "claude", terminalTitle: "Transcript 空間問題" });
    expect(c.querySelector('[data-slot="agent-row-title"]')).toHaveTextContent("Transcript 空間問題");
    expect(c.querySelector('[data-slot="agent-row-detail"]')).toBeNull();
  });

  it("leaves a pane with a name of its own alone, both lines", () => {
    const c = at({ soleTabName: "develop", agent: "claude", terminalTitle: "Transcript 空間問題" });
    expect(c.querySelector('[data-slot="agent-row-title"]')).toHaveTextContent("develop");
    expect(c.querySelector('[data-slot="agent-row-detail"]')).toHaveTextContent("Transcript 空間問題");
  });

  it("does not promote a stale title", () => {
    const c = at({
      soleTabName: "claude",
      agent: "claude",
      terminalTitle: "Transcript 空間問題",
      terminalTitleStale: true,
    });
    expect(c.querySelector('[data-slot="agent-row-title"]')).toHaveTextContent("claude");
  });
});

// ── FORK: THE ROW DOES NOT NAME THE MODEL ───────────────────────────────────
// It did, on its own line and then at the end of the name line. The operator's call (2026-09-15):
// the agent's icon already answers "which agent is this", which is what the dashboard is asked, and
// the model and effort belong on the pane's own header. Pinned so neither spelling creeps back.
describe("AgentCard — the model stays off the row", () => {
  it("draws no model run and no model line, even when the bridge has read both", () => {
    const { container } = render(
      <AgentCard agent={agent({ model: "claude-fable-5-1", effort: "xhigh" })} onClick={() => {}} />,
    );
    expect(container.querySelector('[data-slot="agent-model-run"]')).toBeNull();
    expect(container.querySelector('[data-slot="agent-model-line"]')).toBeNull();
    expect(container.textContent).not.toContain("fable-5-1");
  });
});

// A list already grouped by WORKSPACE (lib/pane-groups.ts) has said the workspace in its heading, so
// the row's line 2 carries the TAB and nothing else — blank when that tab has no name of its own.
// The row states its own height, and its address and cache reading ride at the end of line 1
// instead of in the trailing column.
describe("AgentCard in a workspace group", () => {
  const row = (over: Partial<AgentView> = {}) =>
    render(
      <AgentCard
        agent={agent({ tabLabel: "review", paneLabel: "logs", cwd: "/home/you/webapp/api", ...over })}
        onClick={() => {}}
        scope="place"
        statusStyle="dot"
        density="row"
      />,
    );

  it("keeps line 1 and puts the tab, alone, on line 2", () => {
    const { container } = row();
    expect(line1(container)).toHaveTextContent("logs");
    expect(line2(container)).toHaveTextContent("review");
    // Not the workspace: the heading above said it. Not the cwd either — that is `tab`'s answer.
    expect(line2(container)).not.toHaveTextContent("webapp");
    expect(container.textContent).not.toContain("webapp/api");
  });

  it("shows the tab's position when it carries no name of its own", () => {
    const { container } = row({ tabLabel: "3" });
    const detail = line2(container)!;
    expect(detail).not.toBeNull();
    expect(detail.textContent).toBe("tab 3");
    expect(detail.className).toMatch(/(?:^|\s)h-4(?=\s|$)/);
  });

  it("centres the name when the raw tab label carries no digit at all", () => {
    const { container } = row({ tabLabel: "" });
    // No slot at all: the row's own `items-center` puts the name in the middle instead.
    expect(line2(container)).toBeNull();
    expect(line1(container)).toHaveTextContent("logs");
  });

  // FORK: …and stops stating it the moment the row has a third line. The beacon sentence and the
  // model run are what this fork's dashboard is FOR on a herd of identical `claude · working` rows,
  // so a row carrying one grows instead of clipping it inside a stated 44px box (which is what the
  // 1.9.0 merge shipped for one afternoon).
  it("stops stating the height for a beacon sentence, and for nothing else", () => {
    // The sentence is the one thing that cannot ride the name line, so it is the one thing that
    // makes the row taller. The model run moved ONTO that line in the same edit precisely so a row
    // with a reading and a row without still read as one list.
    const said = row({ statusLine: "抓 Gmail 的 digest" });
    expect(said.container.querySelector("button")!.className).not.toMatch(/(?:^|\s)h-11(?=\s|$)/);
    cleanup();
    const ran = row({ model: "claude-opus-5", effort: "medium" });
    expect(ran.container.querySelector("button")!.className).toMatch(/(?:^|\s)h-11(?=\s|$)/);
  });

  // A `<button>` centres its text by default. Losing `text-left` off this element (the 1.9.0 merge
  // did, for one afternoon) centres line 2 under the name on every row of the dashboard.
  it("keeps the row's text left, because the row box is a button", () => {
    const { container } = row();
    expect(container.querySelector("button")!.className).toMatch(/(?:^|\s)text-left(?=\s|$)/);
  });

  it("states the row's height rather than letting its contents set it", () => {
    for (const over of [{}, { tabLabel: "3" }]) {
      const { container } = row(over);
      // FORK: the button IS the row box here — this fork's card nests `Shell > button` so the
      // long-press lands on the same element the pitch is stated on, where upstream nests
      // `button > Shell`. Same class, one level up.
      expect(container.querySelector("button")!.className).toMatch(/(?:^|\s)h-11(?=\s|$)/);
    }
  });

  it("withholds the bridge's hint, which is the one fact that would change a row's height", () => {
    const { container } = row({ hint: "waiting on a build" });
    expect(container.textContent).not.toContain("waiting on a build");
  });

  it("puts the meta at the end of line 1, not in a slot of its own", () => {
    const { container } = row();
    const title = container.querySelector('[data-slot="agent-row-title"]')!;
    expect(title.querySelector('[data-slot="pane-meta"]')).not.toBeNull();
    const detail = line2(container);
    expect(detail?.querySelector('[data-slot="pane-meta"]')).toBeNull();
  });
});

describe("AgentCard's unseen marker", () => {
  it("renders a labelled dot right after the name when unseen, and nothing when it isn't", () => {
    const { container, rerender } = render(<AgentCard agent={agent()} onClick={() => {}} unseen />);
    const title = container.querySelector<HTMLElement>('[data-slot="agent-row-title"]')!;
    expect(within(title).getByRole("img", { name: "unseen" })).toBeInTheDocument();

    rerender(<AgentCard agent={agent()} onClick={() => {}} />);
    expect(within(title).queryByRole("img", { name: "unseen" })).not.toBeInTheDocument();
  });

  // Regression: the dot used to land at the FAR end of the row, next to the host chip, because the
  // name span was `flex-1` and grew to fill the line before the dot ever got a turn. It has to sit
  // right beside the name it marks, "billing webhooks •" reading as one unit — never off beside the
  // meta at the other edge.
  it("sits directly after the name, not after the trailing meta", () => {
    const { container } = render(
      <AgentCard
        agent={agent({ sessionName: "billing webhooks", host: "lodge" })}
        onClick={() => {}}
        unseen
      />,
    );
    const title = container.querySelector<HTMLElement>('[data-slot="agent-row-title"]')!;
    const name = within(title).getByText("billing webhooks");
    const dot = within(title).getByRole("img", { name: "unseen" });
    const meta = title.querySelector('[data-slot="pane-meta"]')!;
    // The dot is the name's very next element sibling…
    expect(name.nextElementSibling).toBe(dot);
    // …and the meta comes after the dot, never before it.
    expect(dot.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The name no longer claims the row's spare width itself — it truncates on its own content,
    // and `PaneMeta`'s `ml-auto` is what pins the meta to the end instead.
    expect(name.className).not.toMatch(/flex-1/);
    expect(meta.className).toMatch(/(?:^|\s)ml-auto(?=\s|$)/);
  });
});

// A flat row states its own height whatever scope it's in — the urgent sections of the dashboard
// (agent-list.tsx) render at `scope="herd"`, `density="row"`, and must match the 44px of a
// workspace-grouped row (`scope="place"`) exactly, or the two kinds of row stop reading as one list.
describe("AgentCard — a flat row states its height on every scope, not just \"place\"", () => {
  it("states h-11 for scope=\"herd\" once density is \"row\"", () => {
    const { container } = render(
      <AgentCard agent={agent()} onClick={() => {}} scope="herd" density="row" />,
    );
    // FORK: the button is the row box — see the note in the group suite above.
    expect(container.querySelector("button")!.className).toMatch(/(?:^|\s)h-11(?=\s|$)/);
  });

  it("withholds the bridge's hint on that same flat row", () => {
    const { container } = render(
      <AgentCard
        agent={agent({ hint: "waiting on a build" })}
        onClick={() => {}}
        scope="herd"
        density="row"
      />,
    );
    expect(container.textContent).not.toContain("waiting on a build");
  });
});

// EVERY SCOPE NOW SHARES ONE SHAPE: the meta rides the end of line 1, baseline-aligned with the
// name, and line 2 is whatever that scope's own text is — never the meta. The corner column that
// used to set herd/tab rows apart from a place row is gone (2026-09-14); a herd card and a
// workspace-grouped row differ only in what line 2 says.
describe("AgentCard — the meta rides line 1 on every scope", () => {
  for (const scope of ["herd", "tab", "place"] as const) {
    it(`scope="${scope}" puts the pane's address and cache reading at the end of line 1`, () => {
      const { container } = render(<AgentCard agent={agent()} onClick={() => {}} scope={scope} />);
      const title = container.querySelector('[data-slot="agent-row-title"]')!;
      const meta = title.querySelector('[data-slot="pane-meta"]');
      expect(meta).not.toBeNull();
      // Baseline-aligned with the name, not centred with the dot and the tile.
      expect(meta?.className).toMatch(/(?:^|\s)self-baseline(?=\s|$)/);
      const name = title.querySelector("span.font-medium")!;
      expect(name.className).toMatch(/(?:^|\s)self-baseline(?=\s|$)/);
    });
  }
});
