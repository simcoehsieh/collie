import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "@/test/setup";
import { __resetDiffCache } from "@/lib/api";
import { __resetNotes, notesForPane } from "@/lib/notes";
import { DiffSheet, newSideRange, splitHunks } from "./diff-sheet";

// The Changes sheet: the file list, one file's patch, and the three refusals the bridge answers
// with — each read through MSW the way the real bridge answers.

const FACE = { className: "", style: undefined };

const stat = {
  ok: true,
  mode: "stat",
  cwd: "/home/op/git/proj",
  repoRoot: "/home/op/git/proj",
  branch: "main",
  files: [
    { path: "a.ts", status: "M", staged: false, additions: 3, deletions: 1, binary: false },
    { path: "new.txt", status: "?", staged: false, additions: 12, deletions: 0, binary: false },
    { path: "logo.png", status: "A", staged: true, additions: 0, deletions: 0, binary: true },
  ],
  truncated: false,
};

const patch = {
  ok: true,
  mode: "patch",
  path: "a.ts",
  patch: "diff --git a/a.ts b/a.ts\n@@ -1,2 +1,3 @@\n one\n-two\n+two!\n+three\n",
  truncated: false,
};

function serveDiff() {
  server.use(
    http.get(/\/api\/pane\/[^/]+\/diff/, ({ request }) => {
      const url = new URL(request.url);
      if (url.searchParams.get("mode") === "patch") {
        return HttpResponse.json(patch, { headers: { etag: '"p1"' } });
      }
      return HttpResponse.json(stat, { headers: { etag: '"s1"' } });
    }),
  );
}

function renderSheet(open = true, onClose = vi.fn()) {
  return render(
    <DiffSheet open={open} onClose={onClose} paneId="w1:p1" fontSize={12} mirrorFace={FACE} home="/home/op" />,
  );
}

beforeEach(() => {
  __resetDiffCache();
  __resetNotes();
});

describe("DiffSheet", () => {
  it("lists the changed files with counts, and shortens the repo root", async () => {
    serveDiff();
    renderSheet();
    expect(await screen.findByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("new.txt")).toBeInTheDocument();
    expect(screen.getByText("+3")).toBeInTheDocument();
    expect(screen.getByText("−1")).toBeInTheDocument();
    expect(screen.getByText("binary")).toBeInTheDocument();
    expect(screen.getByText("staged")).toBeInTheDocument();
    expect(screen.getByText("main · ~/git/proj")).toBeInTheDocument();
  });

  it("a row opens the patch with added and removed lines tinted, and Back returns to the list", async () => {
    serveDiff();
    const user = userEvent.setup();
    renderSheet();
    await user.click(await screen.findByRole("button", { name: /a\.ts/ }));
    const added = await screen.findByText("+two!");
    expect(added.className).toContain("text-status-done");
    expect(screen.getByText("-two").className).toContain("text-status-blocked");
    // The hunk header's tint moved out to the row that carries the note gesture, so the class is
    // read off that row rather than off the text node inside it.
    const header = screen.getByText("@@ -1,2 +1,3 @@").closest('[data-slot="diff-hunk"]');
    expect(header?.className).toContain("text-primary");
    // The title names the file while the patch is showing.
    expect(screen.getByRole("dialog", { name: "a.ts" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /back to the file list/i }));
    expect(await screen.findByText("new.txt")).toBeInTheDocument();
  });

  it("copies the file's path from the patch view", async () => {
    serveDiff();
    // AFTER `setup()`: user-event installs its own clipboard stub there, and would replace this one.
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderSheet();
    await user.click(await screen.findByRole("button", { name: /a\.ts/ }));
    await screen.findByText("+two!");
    await user.click(screen.getByRole("button", { name: /copy path/i }));
    expect(writeText).toHaveBeenCalledWith("a.ts");
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("says the work tree is clean when nothing changed", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/diff/, () => HttpResponse.json({ ...stat, files: [] }, { headers: { etag: '"e"' } })),
    );
    renderSheet();
    expect(await screen.findByText(/work tree is clean/)).toBeInTheDocument();
  });

  it("names each refusal: not a repo, outside the jail, and anything else", async () => {
    server.use(http.get(/\/api\/pane\/[^/]+\/diff/, () => new HttpResponse("not a git work tree", { status: 404 })));
    const first = renderSheet();
    expect(await screen.findByText(/not in a Git work tree/)).toBeInTheDocument();
    first.unmount();

    server.use(
      http.get(/\/api\/pane\/[^/]+\/diff/, () => new HttpResponse("outside the allowed directories", { status: 403 })),
    );
    const second = renderSheet();
    expect(await screen.findByText(/outside what Collie may read/)).toBeInTheDocument();
    second.unmount();

    server.use(http.get(/\/api\/pane\/[^/]+\/diff/, () => new HttpResponse("boom", { status: 500 })));
    renderSheet();
    expect(await screen.findByText(/Couldn't read the changes/)).toBeInTheDocument();
  });

  it("Refresh re-reads, and a 304 keeps the list on screen", async () => {
    let calls = 0;
    server.use(
      http.get(/\/api\/pane\/[^/]+\/diff/, ({ request }) => {
        calls += 1;
        if (request.headers.get("if-none-match") === '"s1"') return new HttpResponse(null, { status: 304 });
        return HttpResponse.json(stat, { headers: { etag: '"s1"' } });
      }),
    );
    const user = userEvent.setup();
    renderSheet();
    expect(await screen.findByText("a.ts")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(calls).toBe(2));
    expect(screen.getByText("a.ts")).toBeInTheDocument();
  });

  // ── FORK: the hop to the file viewer ──────────────────────────────────────────────────────────
  //
  // A SECOND affordance on the row, never a replacement for the first: the main tap still opens the
  // patch, which is what this sheet is for. It exists because "+82 −11" is not a file you can read.
  it("a row offers the file itself beside its patch, and the main tap still opens the patch", async () => {
    serveDiff();
    const onOpenFile = vi.fn();
    const user = userEvent.setup();
    render(
      <DiffSheet
        open
        onClose={vi.fn()}
        paneId="w1:p1"
        fontSize={12}
        mirrorFace={FACE}
        home="/home/op"
        onOpenFile={onOpenFile}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Open a.ts" }));
    expect(onOpenFile).toHaveBeenCalledWith("a.ts");
    // The row's own tap is untouched. Addressed by the row's WHOLE name — status letter, path and
    // counts — because "Open a.ts" now matches a bare /a\.ts/ too, which is exactly the ambiguity
    // two controls on one row creates.
    await user.click(screen.getByText("a.ts").closest("button")!);
    expect(await screen.findByText(/two!/)).toBeInTheDocument();
    // And the patch view offers the same hop, which is exactly where the question "what does the
    // rest of this say" arrives: a hunk carries three lines of context.
    await user.click(screen.getByRole("button", { name: "Open file" }));
    expect(onOpenFile).toHaveBeenCalledTimes(2);
  });

  it("a DELETED file gets no viewer button — there is nothing left on disk to open", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/diff/, () =>
        HttpResponse.json(
          { ...stat, files: [{ path: "gone.ts", status: "D", staged: true, additions: 0, deletions: 9, binary: false }] },
          { headers: { etag: '"s2"' } },
        ),
      ),
    );
    render(
      <DiffSheet open onClose={vi.fn()} paneId="w1:p1" fontSize={12} mirrorFace={FACE} onOpenFile={vi.fn()} />,
    );
    expect(await screen.findByText("gone.ts")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open gone.ts" })).not.toBeInTheDocument();
  });

  it("offers no viewer at all when the caller wired none", async () => {
    serveDiff();
    renderSheet();
    expect(await screen.findByText("a.ts")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open a.ts" })).not.toBeInTheDocument();
  });

  it("renders nothing while closed", () => {
    serveDiff();
    renderSheet(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  // FORK: anchored notes.
  it("a hold on a hunk opens the note sheet, and the saved note pins a number on that hunk", async () => {
    serveDiff();
    const user = userEvent.setup();
    renderSheet();
    await user.click(await screen.findByRole("button", { name: /a\.ts/ }));
    const row = (await screen.findByText("@@ -1,2 +1,3 @@")).closest('[data-slot="diff-hunk"]');
    if (row === null) throw new Error("the hunk header carries no note row");
    // `contextmenu` is `useLongPress`'s other trigger — what Android raises at the end of a hold and
    // what a desk raises on a right-click — and it needs no fake timers to reach.
    fireEvent.contextMenu(row);

    await user.type(await screen.findByRole("textbox"), "this drops the guard");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByLabelText("Note 1")).toBeInTheDocument();
    expect(notesForPane(undefined, "w1:p1")[0]?.anchor).toEqual({
      kind: "diff",
      file: "a.ts",
      hunkHeader: "@@ -1,2 +1,3 @@",
      lineRange: "1-3",
      excerpt: "@@ -1,2 +1,3 @@\n one\n-two\n+two!\n+three",
    });
  });
});

// FORK: the two pure functions a note anchored to a hunk is built out of. They decide what an agent
// is told to open, so they are tested away from the rendering.
describe("splitHunks", () => {
  it("keeps git's preamble out of the hunks and gives each hunk its own body", () => {
    const split = splitHunks([
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,3 @@",
      " one",
      "+two",
      "@@ -9,1 +10,1 @@",
      "-nine",
    ]);
    expect(split.preamble).toHaveLength(3);
    expect(split.hunks.map((h) => h.header)).toEqual(["@@ -1,2 +1,3 @@", "@@ -9,1 +10,1 @@"]);
    expect(split.hunks[0]?.body).toEqual([" one", "+two"]);
    expect(split.hunks[1]?.body).toEqual(["-nine"]);
  });

  it("reports no hunks for a patch that is all preamble (a binary file)", () => {
    expect(splitHunks(["diff --git a/x.png b/x.png", "Binary files differ"]).hunks).toEqual([]);
  });
});

describe("newSideRange", () => {
  it("names the NEW side's lines, which is what the agent will open", () => {
    expect(newSideRange("@@ -4,7 +12,9 @@")).toBe("12-20");
    expect(newSideRange("@@ -4,7 +12 @@")).toBe("12");
    expect(newSideRange("@@ -4,7 +12,1 @@")).toBe("12");
  });

  it("has nothing to say about a pure deletion or a header it cannot read", () => {
    expect(newSideRange("@@ -4,7 +12,0 @@")).toBeUndefined();
    expect(newSideRange("not a hunk header")).toBeUndefined();
  });
});
