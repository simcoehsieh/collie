import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { __resetDiffCache } from "@/lib/api";
import { PaneTranscript, latestTodo } from "./pane-transcript";
import type { TranscriptEntry } from "@/lib/types";

// Chat mode's surface. Three things are pinned beyond "it renders the thread": the plan is PINNED
// at the top (the state of the job, not a turn), a pane you have not opened for an hour leads with
// a rollup of DERIVED facts, and a working pane says out loud that the live view is the terminal —
// because a streaming turn has not been written to the harness's JSONL yet and simply cannot be here.

const HOUR = 60 * 60 * 1000;

const turn = (uuid: string, text: string, at = Date.now()): TranscriptEntry => ({
  uuid,
  ts: new Date(at).toISOString(),
  role: "assistant",
  parts: [{ kind: "text", text }],
});

function serveHistory(entries: TranscriptEntry[]) {
  server.use(
    http.get(/\/api\/pane\/[^/]+\/history/, () =>
      HttpResponse.json({
        paneId: "w1:p1",
        available: true,
        entries,
        hasMore: false,
        total: entries.length,
        fileTruncated: false,
      }),
    ),
  );
}

function serveDiff(files: { path: string; additions: number; deletions: number }[]) {
  server.use(
    http.get(/\/api\/pane\/[^/]+\/diff/, () =>
      HttpResponse.json({
        ok: true,
        mode: "stat",
        cwd: "/home/you/collie",
        repoRoot: "/home/you/collie",
        branch: "wt/chat",
        files: files.map((f) => ({ ...f, status: "M", staged: false, binary: false })),
        truncated: false,
      }),
    ),
  );
}

function renderTranscript(over: Partial<React.ComponentProps<typeof PaneTranscript>> = {}) {
  return render(
    <PaneTranscript
      paneId="w1:p1"
      agent="claude"
      working={false}
      mirrorText="some screen"
      onShowTerminal={() => {}}
      {...over}
    />,
  );
}

beforeEach(() => __resetDiffCache());

describe("latestTodo", () => {
  it("takes the LAST plan in the window — a re-plan replaces the one before it", () => {
    const entries: TranscriptEntry[] = [
      { uuid: "p1", ts: "", role: "assistant", parts: [{ kind: "todo", items: [{ text: "old", status: "pending" }] }] },
      { uuid: "p2", ts: "", role: "assistant", parts: [{ kind: "todo", items: [{ text: "new", status: "pending" }] }] },
    ];
    expect(latestTodo(entries)).toEqual([{ text: "new", status: "pending" }]);
  });

  it("is null when the harness has no such tool, which is the whole of 'skip gracefully'", () => {
    expect(latestTodo([turn("a", "hello")])).toBeNull();
    expect(latestTodo([])).toBeNull();
  });

  it("an emptied plan pins nothing rather than an empty card", () => {
    const empty: TranscriptEntry = { uuid: "p", ts: "", role: "assistant", parts: [{ kind: "todo", items: [] }] };
    expect(latestTodo([empty])).toBeNull();
  });
});

describe("PaneTranscript", () => {
  it("renders the thread", async () => {
    serveHistory([turn("a", "All 114 tests pass.")]);
    renderTranscript();
    expect(await screen.findByText("All 114 tests pass.")).toBeInTheDocument();
  });

  it("pins the newest plan above the thread, with its progress", async () => {
    serveHistory([
      {
        uuid: "p1",
        ts: new Date().toISOString(),
        role: "assistant",
        parts: [
          {
            kind: "todo",
            items: [
              { text: "Read the adapter", status: "completed" },
              { text: "Write the card", status: "in_progress" },
            ],
          },
        ],
      },
      turn("a", "on it"),
    ]);
    const { container } = renderTranscript();
    await waitFor(() => expect(container.querySelectorAll('[data-slot="todo-card"]').length).toBeGreaterThan(0));
    // Two copies on purpose: the pinned one at the top, and the turn that wrote it, in place.
    const cards = container.querySelectorAll('[data-slot="todo-card"]');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent("1/2");
    expect(cards[0]).toHaveTextContent("Write the card");
  });

  it("says the live view is the terminal while the pane is working", async () => {
    serveHistory([turn("a", "thinking")]);
    renderTranscript({ working: true });
    expect(await screen.findByRole("button", { name: /live output is in Terminal/i })).toBeInTheDocument();
  });

  it("says nothing about the terminal once the pane is at rest", async () => {
    serveHistory([turn("a", "done")]);
    renderTranscript({ working: false });
    await screen.findByText("done");
    expect(screen.queryByRole("button", { name: /live output is in Terminal/i })).not.toBeInTheDocument();
  });

  it("offers the terminal when the pane has no transcript to show", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/history/, () =>
        HttpResponse.json({ paneId: "w1:p1", available: false, reason: "no-log" }),
      ),
    );
    const user = userEvent.setup();
    const onShowTerminal = vi.fn();
    renderTranscript({ onShowTerminal });
    await user.click(await screen.findByRole("button", { name: /show the terminal/i }));
    expect(onShowTerminal).toHaveBeenCalled();
  });
});

describe("PaneTranscript — while you were away", () => {
  const longAgo = Date.now() - 3 * HOUR;

  it("leads with the rollup on a pane not opened for an hour", async () => {
    serveDiff([{ path: "a.ts", additions: 12, deletions: 3 }]);
    serveHistory([
      { uuid: "t", ts: new Date(Date.now() - HOUR).toISOString(), role: "assistant", parts: [{ kind: "tool", name: "Read", summary: "a.ts" }] },
      turn("a", "Shall I push?", Date.now() - 30 * 60_000),
    ]);
    const { container } = renderTranscript({ lastSeenAt: longAgo });
    const card = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('[data-slot="away-card"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(card).toHaveTextContent("2 agent turns");
    // The diff stat is fetched from the SAME endpoint the Changes sheet uses.
    await waitFor(() => expect(card).toHaveTextContent("1 files +12 −3"));
    // …and the standing question is called out with its age.
    expect(card).toHaveTextContent(/question has been waiting/i);
  });

  it("shows nothing on a pane you opened five minutes ago", async () => {
    serveHistory([turn("a", "hello")]);
    const { container } = renderTranscript({ lastSeenAt: Date.now() - 5 * 60_000 });
    await screen.findByText("hello");
    expect(container.querySelector('[data-slot="away-card"]')).toBeNull();
  });

  it("shows nothing when nothing happened while you were away", async () => {
    serveHistory([turn("a", "hello", Date.now() - 5 * HOUR)]);
    const { container } = renderTranscript({ lastSeenAt: longAgo });
    await screen.findByText("hello");
    expect(container.querySelector('[data-slot="away-card"]')).toBeNull();
  });

  it("a tap dismisses it", async () => {
    serveHistory([turn("a", "did a thing")]);
    const user = userEvent.setup();
    const { container } = renderTranscript({ lastSeenAt: longAgo });
    await waitFor(() => expect(container.querySelector('[data-slot="away-card"]')).not.toBeNull());
    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(container.querySelector('[data-slot="away-card"]')).toBeNull();
  });

  // A rollup an agent WROTE is a rollup the reader cannot check, on the one screen whose job is to
  // be trusted after an absence. Every number on the card is a count of something already in hand.
  it("asks no model and posts nothing — the only reads are history and the diff stat", async () => {
    const paths: string[] = [];
    server.use(
      http.get(/\/api\/.*/, ({ request }) => {
        paths.push(new URL(request.url).pathname);
        return HttpResponse.json({ paneId: "w1:p1", available: true, entries: [turn("a", "did a thing")], hasMore: false, total: 1, fileTruncated: false });
      }),
    );
    const { container } = renderTranscript({ lastSeenAt: longAgo });
    await waitFor(() => expect(container.querySelector('[data-slot="away-card"]')).not.toBeNull());
    for (const path of paths) expect(path).toMatch(/\/(history|diff)$/);
  });
});
