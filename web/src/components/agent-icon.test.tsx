import { render, screen } from "@testing-library/react";

import { AgentIcon } from "./agent-icon";

describe("AgentIcon", () => {
  it.each(["claude", "codex", "pi", "opencode", "agy", "antigravity", "omp"])(
    "renders the %s brand logo as an inline-SVG app-icon tile",
    (agent) => {
      const { container } = render(<AgentIcon agent={agent} />);
      const svg = container.querySelector("svg");
      expect(svg).not.toBeNull();
      // The tile carries its own solid brand background (theme-independent contrast), whatever the
      // mark inside it turns out to be.
      expect(svg!.querySelector("rect")?.getAttribute("fill")).toMatch(/^#[0-9a-fA-F]{6}$/);

      // A mark is EITHER a painted path or the brand's own artwork. Antigravity is the second: there
      // is no official vector to take a path from, and the alternative to embedding Google's own file
      // was to trace it by hand — which is exactly how the wrong mark shipped before (see
      // agent-icon-data.ts). Both kinds are asserted here rather than one being exempted, so a brand
      // that renders NEITHER still fails.
      const artwork = svg!.querySelector("image");
      if (artwork) {
        // Embedded, not fetched: a remote href would need a host in the CSP, would tell that host
        // which agents you run, and would show nothing offline.
        expect(artwork.getAttribute("href")).toMatch(/^data:image\/[a-z+]+;base64,/);
      } else {
        expect(svg!.querySelector("path")).not.toBeNull();
        // Every painted mark is painted one of exactly two ways: filled — a flat brand colour or a
        // reference to the tile's own gradient — or outlined, the only shape allowed to declare
        // `fill="none"`, and then the stroke is what carries it. A mark with neither is invisible.
        const mark = svg!.querySelector("g")!;
        const fill = mark.getAttribute("fill");
        if (fill === "none") expect(mark.getAttribute("stroke")).toMatch(/^#[0-9a-fA-F]{6}$/);
        else expect(fill).toMatch(/^(#[0-9a-fA-F]{6}|url\(#[A-Za-z0-9_-]+\))$/);
      }
      expect(screen.getByRole("img", { name: `${agent} logo` })).toBeInTheDocument();
    },
  );

  // The fork change this file exists to hold honest. Upstream drew Antigravity as a triangle "A" in
  // white on Google blue, with no source cited beside it — every other entry names one — and it is
  // simply not the mark: the real one is a rounded arch with a four-colour gradient on a transparent
  // ground. Pinned as a SHAPE of fact, not as bytes: artwork, embedded, on the tile the brand is
  // presented on.
  it("draws Antigravity as embedded artwork, not as a hand-drawn path", () => {
    for (const agent of ["agy", "antigravity"]) {
      const { container, unmount } = render(<AgentIcon agent={agent} />);
      const svg = container.querySelector("svg")!;
      expect(svg.querySelector("path"), `${agent} should not carry a traced path`).toBeNull();
      expect(svg.querySelector("image")?.getAttribute("href")).toMatch(/^data:image\/webp;base64,/);
      // On white, which is the ground the transparent mark is presented on.
      expect(svg.querySelector("rect")?.getAttribute("fill")).toBe("#FFFFFF");
      unmount();
    }
  });

  it.each([
    ["claude-code"],
    ["codex-cli"],
    ["opencode-dev"],
    ["pi-go"],
    ["PI"],
    ["agy-cli"],
    ["antigravity-dev"],
    ["omp-dev"],
    ["OMP"],
  ])("resolves label variant '%s' to a brand logo", (variant) => {
    const { container } = render(<AgentIcon agent={variant} />);
    // Either kind of mark counts — what this pins is that the VARIANT resolved to a brand at all,
    // rather than falling through to the initials tile, which renders no <svg> whatsoever.
    expect(container.querySelector("svg path, svg image")).not.toBeNull();
  });

  // omp's official mark is a three-stop gradient (omp.sh/favicon.svg), and its tile is the only one
  // AgentIcon paints with `url(#…)`: the gradient must be in the document, and the reference must
  // resolve to it — a dangling reference paints nothing at all, on every surface at once.
  it("paints omp's mark with its own gradient, referenced by a resolvable id", () => {
    const { container } = render(<AgentIcon agent="omp" />);
    const svg = container.querySelector("svg")!;
    const ref = svg.querySelector("g")!.getAttribute("fill")!;
    const id = ref.match(/^url\(#(.+)\)$/)?.[1];
    expect(id).toBeTruthy();
    const grad = svg.querySelector("linearGradient")!;
    expect(grad.getAttribute("id")).toBe(id);
    expect([...grad.querySelectorAll("stop")].map((s) => s.getAttribute("stop-color"))).toEqual([
      "#ED4ABF",
      "#9B4DFF",
      "#5AD8E6",
    ]);
  });

  // Two tiles share one document (the dashboard renders a column of them), so a shared gradient id
  // would point every mark at whichever tile mounted first.
  it("gives each mounted gradient tile its own id", () => {
    const { container } = render(
      <>
        <AgentIcon agent="omp" />
        <AgentIcon agent="omp" />
      </>,
    );
    const ids = [...container.querySelectorAll("linearGradient")].map((g) => g.getAttribute("id"));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("keeps a flat-brand tile free of gradient machinery", () => {
    const { container } = render(<AgentIcon agent="claude" />);
    expect(container.querySelector("linearGradient")).toBeNull();
    expect(container.querySelector("svg g")?.getAttribute("fill")).toBe("#FFFFFF");
  });

  it("falls back to an initials tile for unknown agents", () => {
    render(<AgentIcon agent="gemini" />);
    const el = screen.getByRole("img", { name: "gemini icon" });
    expect(el).toHaveTextContent("GE");
    expect(el.querySelector("svg")).toBeNull(); // fallback is text, not a brand mark
  });

  it("renders a fallback (no crash) for null / undefined agents", () => {
    const { rerender } = render(<AgentIcon agent={null} />);
    expect(screen.getByRole("img")).toBeInTheDocument();
    rerender(<AgentIcon agent={undefined} />);
    expect(screen.getByRole("img")).toBeInTheDocument();
  });

  it("forwards className for sizing", () => {
    const { container } = render(<AgentIcon agent="claude" className="size-9" />);
    expect(container.querySelector("svg")?.getAttribute("class")).toContain("size-9");
  });
});
