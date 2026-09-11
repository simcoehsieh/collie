import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "@/test/setup";
import { __resetFileCache } from "@/lib/api";
import type { PaneFileResponse } from "@/lib/types";
import { FileSheet, INITIAL_LINES } from "./file-sheet";

// FORK. The file viewer: one file of the pane's work tree, read-only.
//
// What it has to get right is what the Changes sheet next door cannot do — show a file that has no
// patch — and what it has to NOT do is wrap a long line or render 5,000 rows on open.

const FACE = { className: "", style: undefined };

const body = (over: Partial<PaneFileResponse> = {}): PaneFileResponse => ({
  ok: true,
  mode: "file",
  path: "src/a.ts",
  text: "one\ntwo\nthree\n",
  bytes: 14,
  truncated: false,
  ...over,
});

/** The bridge's own answer, or a refusal. `null` + a status is how each 4xx case is written. */
function serveFile(answer: PaneFileResponse | null = body(), status = 200) {
  server.use(
    http.get(/\/api\/pane\/[^/]+\/file/, () =>
      answer === null
        ? new HttpResponse("refused", { status })
        : HttpResponse.json(answer, { headers: { etag: '"f1"' } }),
    ),
  );
}

function renderSheet(props: Partial<Parameters<typeof FileSheet>[0]> = {}) {
  return render(
    <FileSheet
      open
      onClose={vi.fn()}
      paneId="w1:p1"
      path="src/a.ts"
      fontSize={12}
      mirrorFace={FACE}
      {...props}
    />,
  );
}

beforeEach(() => __resetFileCache());

describe("FileSheet", () => {
  it("shows the file with a line-number gutter the copy leaves behind", async () => {
    serveFile();
    renderSheet();
    expect(await screen.findByText("two")).toBeInTheDocument();
    const gutter = screen.getByText("2");
    // `select-none` is the whole point of the gutter's own class: dragging across a numbered listing
    // and pasting the numbers with the code is the classic annoyance this avoids.
    expect(gutter.className).toContain("select-none");
  });

  it("says which file, and how much of it there is", async () => {
    serveFile();
    renderSheet();
    expect(await screen.findByRole("dialog", { name: "src/a.ts" })).toBeInTheDocument();
    expect(screen.getByText("3 lines · 14 bytes")).toBeInTheDocument();
  });

  it("PANS a long line rather than wrapping it", async () => {
    // A wrapped 200-column line stops being the line the agent is talking about. Same answer
    // markdown-text.tsx gives a table: the container scrolls and the content keeps its width.
    const wide = "x".repeat(400);
    serveFile(body({ text: `${wide}\n` }));
    renderSheet();
    expect(await screen.findByText(wide)).toBeInTheDocument();
    const listing = document.querySelector('[data-slot="file-body"]');
    // The <pre> keeps its content's width; the box AROUND it is the scroller. Swap those two and
    // the pane scrolls the whole sheet sideways instead of the code.
    expect(listing?.className).toContain("min-w-max");
    expect(listing?.parentElement?.className).toContain("overflow-auto");
  });

  it("renders a window of a long file, and grows it on demand", async () => {
    // 5,000 lines at 390px is 5,000 DOM rows before wrapping is even considered; routes/history.tsx
    // already measured what that costs. The data is all in memory, so growing is a render.
    const long = Array.from({ length: INITIAL_LINES + 50 }, (_, i) => `line ${String(i + 1)}`).join("\n");
    serveFile(body({ text: long }));
    const user = userEvent.setup();
    renderSheet();
    expect(await screen.findByText(`line ${String(INITIAL_LINES)}`)).toBeInTheDocument();
    expect(screen.queryByText(`line ${String(INITIAL_LINES + 1)}`)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /50 more lines/ }));
    expect(await screen.findByText(`line ${String(INITIAL_LINES + 50)}`)).toBeInTheDocument();
  });

  it("offers a Preview only for a page this bridge could frame", async () => {
    serveFile();
    const onPreview = vi.fn();
    const { rerender } = renderSheet({ onPreview });
    expect(await screen.findByText("two")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Preview" })).not.toBeInTheDocument();

    serveFile(body({ path: "out/report.html", text: "<h1>hi</h1>\n" }));
    rerender(
      <FileSheet
        open
        onClose={vi.fn()}
        paneId="w1:p1"
        path="out/report.html"
        fontSize={12}
        mirrorFace={FACE}
        onPreview={onPreview}
      />,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Preview" }));
    expect(onPreview).toHaveBeenCalledWith("out/report.html");
  });

  it("a binary says so rather than showing a screenful of nothing", async () => {
    // The bridge answers 415 because the file IS there and the operator asked for the right thing —
    // what it cannot do is show it. A 404 would send them looking for a path that exists.
    serveFile(null, 415);
    renderSheet();
    expect(await screen.findByText("Not a text file.")).toBeInTheDocument();
  });

  it("each refusal says its own thing", async () => {
    serveFile(null, 403);
    const { unmount } = renderSheet();
    expect(await screen.findByText(/outside what Collie may read/)).toBeInTheDocument();
    unmount();

    serveFile(null, 404);
    renderSheet();
    expect(await screen.findByText(/No such file/)).toBeInTheDocument();
  });

  it("says when what it is showing is only the head of the file", async () => {
    serveFile(body({ truncated: true, bytes: 900_000 }));
    renderSheet();
    expect(await screen.findByText(/Cut short/)).toBeInTheDocument();
  });
});
