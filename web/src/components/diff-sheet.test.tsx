import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "@/test/setup";
import { __resetDiffCache } from "@/lib/api";
import { DiffSheet } from "./diff-sheet";

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

beforeEach(() => __resetDiffCache());

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
    expect(screen.getByText("@@ -1,2 +1,3 @@").className).toContain("text-primary");
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

  it("renders nothing while closed", () => {
    serveDiff();
    renderSheet(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
