import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { server } from "@/test/setup";
import { DocPanel } from "./doc-panel";

// The document panel's browser half, and the back stack that joins it to the framed document.

const recent = {
  ok: true,
  documents: [
    { slug: "medium-digest-2026-09-10", title: "Medium Digest｜2026/09/10", summary: "Ten pieces.", updatedAt: "2026-09-10T02:00:00Z" },
    { slug: "herdr-interface-anatomy", title: "Herdr 介面解剖", updatedAt: "2026-09-06T13:46:34Z" },
  ],
  nextCursor: "1",
};

const found = {
  ok: true,
  documents: [{ slug: "collie-optimization-review-2026-09-06", title: "Collie 優化研究" }],
};

function serveDocs() {
  const seen: string[] = [];
  server.use(
    http.get("/api/docs/tags", () =>
      HttpResponse.json({ ok: true, tags: [{ path: "ai_agent", count: 20 }, { path: "ai", count: 4 }] }),
    ),
    http.get("/api/docs", ({ request }) => {
      const url = new URL(request.url);
      seen.push(url.search);
      if (url.searchParams.get("q")) return HttpResponse.json(found);
      if (url.searchParams.get("cursor") === "1") {
        return HttpResponse.json({ ok: true, documents: [{ slug: "older-doc", title: "Older" }] });
      }
      return HttpResponse.json(recent);
    }),
  );
  return seen;
}

describe("DocPanel", () => {
  it("opens on the browser when given no document: recent rows and the tag chips", async () => {
    serveDocs();
    render(<DocPanel open onClose={vi.fn()} initial={null} paneId="w1:p1" />);
    expect(await screen.findByText("Medium Digest｜2026/09/10")).toBeInTheDocument();
    expect(screen.getByText("Ten pieces.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /ai_agent/ })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Documents" })).toBeInTheDocument();
  });

  it("a row frames the document from Collie's own origin, and Back returns to the browser", async () => {
    serveDocs();
    const user = userEvent.setup();
    render(<DocPanel open onClose={vi.fn()} initial={null} paneId="w1:p1" />);
    await user.click(await screen.findByRole("button", { name: /Herdr 介面解剖/ }));
    const frame = await screen.findByTitle("herdr-interface-anatomy");
    expect(frame).toHaveAttribute("src", "/api/doc/herdr-interface-anatomy");
    expect(frame).toHaveAttribute("sandbox", "");
    await user.click(screen.getByRole("button", { name: "Documents" }));
    expect(await screen.findByText("Medium Digest｜2026/09/10")).toBeInTheDocument();
  });

  it("a document opened from a link is one tap from the browser", async () => {
    serveDocs();
    const user = userEvent.setup();
    render(
      <DocPanel
        open
        onClose={vi.fn()}
        initial={{ slug: "notes", path: "/api/doc/notes", href: "https://knowledge.agnex.dev/d/notes" }}
        paneId="w1:p1"
      />,
    );
    expect(screen.getByTitle("notes")).toHaveAttribute("src", "/api/doc/notes");
    // The URL line names which document this is, as before.
    expect(screen.getByRole("dialog", { name: "notes" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Documents" }));
    expect(await screen.findByText("Medium Digest｜2026/09/10")).toBeInTheDocument();
  });

  it("typing searches after a pause, a tag chip filters at once, and More pages the list", async () => {
    const seen = serveDocs();
    const user = userEvent.setup();
    render(<DocPanel open onClose={vi.fn()} initial={null} paneId="w1:p1" />);
    await screen.findByText("Medium Digest｜2026/09/10");

    await user.type(screen.getByPlaceholderText(/search the knowledge base/i), "collie");
    expect(await screen.findByText("Collie 優化研究")).toBeInTheDocument();
    expect(seen.some((s) => s.includes("q=collie"))).toBe(true);
    expect(screen.getByText("Results")).toBeInTheDocument();

    await user.clear(screen.getByPlaceholderText(/search the knowledge base/i));
    await screen.findByText("Medium Digest｜2026/09/10");
    await user.click(await screen.findByRole("button", { name: /ai_agent/ }));
    await waitFor(() => expect(seen.some((s) => s.includes("tag=ai_agent"))).toBe(true));

    await user.click(screen.getByRole("button", { name: "More" }));
    expect(await screen.findByText("Older")).toBeInTheDocument();
    expect(screen.getByText("Medium Digest｜2026/09/10")).toBeInTheDocument();
  });

  it("says the store is unreachable rather than showing an empty list", async () => {
    server.use(
      http.get("/api/docs/tags", () => new HttpResponse(null, { status: 503 })),
      http.get("/api/docs", () => new HttpResponse("the document store is not answering", { status: 503 })),
    );
    render(<DocPanel open onClose={vi.fn()} initial={null} paneId="w1:p1" />);
    expect(await screen.findByText(/Couldn't reach the document store/)).toBeInTheDocument();
  });
});
