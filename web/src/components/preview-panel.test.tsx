import { render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { server } from "@/test/setup";

import { PreviewPanel } from "./preview-panel";

// FORK. The panel that frames an HTML file the AGENT wrote.
//
// The load-bearing assertion here is the sandbox, and it is the same one bridge/preview.test.ts
// makes about the response's own CSP. Both halves say it because either alone would be the only
// thing between an agent-written page — often generated out of things it read on the open web — and
// Collie's origin, its localStorage and its `/api/*` with the Access cookie attached. A single
// `allow-scripts` or `allow-same-origin` on this element undoes the whole design in one word, and
// fails nothing else: the page would simply render, and look right.

const PANE = "w1:p1";
const PATH = "/home/op/proj/out/report.html";

describe("PreviewPanel", () => {
  it("frames the page from Collie's own origin, sandboxed with nothing granted", async () => {
    render(<PreviewPanel open onClose={vi.fn()} paneId={PANE} path={PATH} />);
    const frame = await screen.findByTitle("report.html");
    expect(frame.getAttribute("data-src")).toContain(
      `/api/preview/file?pane=${encodeURIComponent(PANE)}&path=${encodeURIComponent(PATH)}`,
    );
    // Exactly `""` — not "some tokens", not "no allow-scripts". Any token at all is a decision that
    // has to be made deliberately, and this is where it would first be noticed.
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-");
  });

  it("names the page by its file name and the path underneath it", () => {
    // The frame is an opaque origin, so the panel cannot read the page's own <title> across it —
    // if the chrome does not say which file this is, nothing does.
    render(<PreviewPanel open onClose={vi.fn()} paneId={PANE} path={PATH} />);
    expect(screen.getByRole("dialog", { name: "report.html" })).toBeInTheDocument();
    expect(screen.getByText(PATH)).toBeInTheDocument();
  });

  it("Reload re-fetches by remounting the frame — the only lever a parent has on an opaque origin", async () => {
    const user = userEvent.setup();
    let reads = 0;
    server.use(http.get("/api/preview/file", () => (reads++, new HttpResponse("<p>page</p>", { headers: { "content-type": "text/html" } }))));
    render(<PreviewPanel open onClose={vi.fn()} paneId={PANE} path={PATH} />);
    await waitFor(() => expect(screen.getByTitle("report.html")).toHaveAttribute("data-phase", "ready"));
    const settled = reads;
    expect(settled).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(reads).toBe(settled + 1));
  });

  it("the width toggle sets the FRAME's width, because that is what a media query reads", async () => {
    const user = userEvent.setup();
    render(<PreviewPanel open onClose={vi.fn()} paneId={PANE} path={PATH} />);
    const frame = await screen.findByTitle("report.html");
    // "Fit" is where a fresh open lands: the operator asked to see the page, not to see it at
    // whatever width they were checking a different page at ten minutes ago.
    expect(screen.getByRole("button", { name: "Fit" })).toHaveAttribute("aria-pressed", "true");
    expect(frame).toHaveStyle({ width: "100%" });
    await user.click(screen.getByRole("button", { name: "390" }));
    expect(frame).toHaveStyle({ width: "390px" });
    await user.click(screen.getByRole("button", { name: "768" }));
    expect(frame).toHaveStyle({ width: "768px" });
  });

  it("offers the one way out of the app, at the bridge's own same-origin URL", async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    vi.stubGlobal("open", open);
    render(<PreviewPanel open onClose={vi.fn()} paneId={PANE} path={PATH} />);
    await user.click(screen.getByRole("button", { name: "Open in browser" }));
    // FORK: the tab opens inside the tap and is pointed at the page once the token-carrying read lands.
    expect(open).toHaveBeenCalledWith("", "_blank");
    vi.unstubAllGlobals();
  });

  it("with no path it frames nothing at all", () => {
    // Closing clears the path so the frame unmounts and the megabyte it was holding goes with it —
    // the same reason DocPanel drops its document on close.
    render(<PreviewPanel open onClose={vi.fn()} paneId={PANE} path={null} />);
    expect(screen.queryByTitle("report.html")).not.toBeInTheDocument();
  });
});
