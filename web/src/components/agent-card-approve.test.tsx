import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { AgentCard } from "./agent-card";
import { __resetPeekCache } from "@/hooks/use-prompt-peek";
import { server } from "@/test/setup";
import { fixtureAgents } from "@/test/handlers";
import type { AgentView } from "@/lib/types";

// FORK: a blocked row offers Yes / No beneath its title when the dialog waiting in the pane is a
// yes/no one. Driven end to end through MSW: the row reads the pane (the same fixture capture the
// Claude grammar is verified against), lifts the dialog, and a tap sends the option's own keys —
// through the guarded path, so the pane is read AGAIN before the keys go out.

const PANES_DIR = join(__dirname, "..", "fixtures", "panes");
const fixture = (name: string) => readFileSync(join(PANES_DIR, `${name}.txt`), "utf8");

const agent = (over: Partial<AgentView> = {}): AgentView => ({ ...fixtureAgents[0]!, ...over });

let reads = 0;
let posted: { keys?: string[]; expected_prompt?: string } | undefined;

function servePane(name: string, revision = 7) {
  server.use(
    http.get("/api/pane/:id", () => {
      reads++;
      return HttpResponse.json({ paneId: "w1:p1", text: fixture(name), truncated: false, revision });
    }),
    http.post<never, { keys: string[]; expected_prompt?: string }>("/api/pane/:id/keys", async ({ request }) => {
      posted = await request.json();
      return HttpResponse.json({ ok: true });
    }),
  );
}

beforeEach(() => {
  __resetPeekCache();
  reads = 0;
  posted = undefined;
});

describe("AgentCard — approve from the row", () => {
  it("offers Yes and No for a permission prompt, and Yes sends the plain Yes's own keys, bound", async () => {
    servePane("claude--permission-bash");
    const user = userEvent.setup();
    render(<AgentCard agent={agent()} onClick={() => {}} />);

    const yes = await screen.findByRole("button", { name: /^yes: yes$/i });
    const no = screen.getByRole("button", { name: /^no: no$/i });
    expect(no).toBeInTheDocument();
    // The question is shown, so the operator knows what they are saying yes to.
    expect(screen.getByText("Do you want to proceed?")).toBeInTheDocument();
    expect(reads).toBe(1);

    await user.click(yes);

    await waitFor(() => expect(posted).toBeDefined());
    expect(posted!.keys).toEqual(["1"]); // option 1 — not "2. Yes, and don't ask again"
    expect(posted!.expected_prompt).toContain("Do you want to proceed?");
    // The guard read the pane again before typing.
    expect(reads).toBe(2);
    // The strip stays, says so, and takes no second answer for the same dialog.
    await screen.findByText(/^sent$/i);
    expect(yes).toBeDisabled();
    expect(no).toBeDisabled();
  });

  it("a dialog that moved on under the peek is refused and re-read", async () => {
    // First read (the peek) sees revision 7; the guard's fresh read sees 8 → "changed".
    let revision = 7;
    server.use(
      http.get("/api/pane/:id", () => {
        reads++;
        return HttpResponse.json({ paneId: "w1:p1", text: fixture("claude--permission-bash"), truncated: false, revision: revision++ });
      }),
      http.post<never, { keys: string[]; expected_prompt?: string }>("/api/pane/:id/keys", async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );
    const user = userEvent.setup();
    render(<AgentCard agent={agent()} onClick={() => {}} />);
    await user.click(await screen.findByRole("button", { name: /^yes: yes$/i }));
    await screen.findByText(/prompt changed/i);
    expect(posted).toBeUndefined();
    // Peek, guard, re-peek.
    expect(reads).toBe(3);
    expect(screen.getByRole("button", { name: /^yes: yes$/i })).toBeEnabled();
  });

  it("No sends the No option's keys", async () => {
    servePane("claude--permission-bash");
    const user = userEvent.setup();
    render(<AgentCard agent={agent()} onClick={() => {}} />);
    await user.click(await screen.findByRole("button", { name: /^no: no$/i }));
    await waitFor(() => expect(posted?.keys).toEqual(["3"]));
  });

  it("offers nothing for a pick that is not yes/no, and never reads a pane that is not blocked", async () => {
    servePane("claude--select-menu");
    const { unmount } = render(<AgentCard agent={agent()} onClick={() => {}} />);
    await waitFor(() => expect(reads).toBe(1));
    expect(screen.queryByRole("button", { name: /^yes/i })).not.toBeInTheDocument();
    unmount();

    render(<AgentCard agent={agent({ status: "working" })} onClick={() => {}} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(reads).toBe(1);
    expect(screen.queryByRole("button", { name: /^yes/i })).not.toBeInTheDocument();
  });

  it("reads once for the same blocked transition however many times the row renders", async () => {
    servePane("claude--permission-bash");
    const view = render(<AgentCard agent={agent()} onClick={() => {}} />);
    await screen.findByRole("button", { name: /^yes: yes$/i });
    view.rerender(<AgentCard agent={agent()} onClick={() => {}} />);
    view.rerender(<AgentCard agent={agent()} onClick={() => {}} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(reads).toBe(1);
  });

  it("the row's own tap still opens the pane, and the approve buttons do not", async () => {
    servePane("claude--permission-bash");
    const user = userEvent.setup();
    let opened = 0;
    render(<AgentCard agent={agent()} onClick={() => opened++} />);
    await screen.findByRole("button", { name: /^yes: yes$/i });
    await user.click(screen.getByRole("button", { name: /^no: no$/i }));
    await waitFor(() => expect(posted).toBeDefined());
    expect(opened).toBe(0);
    await user.click(screen.getByRole("button", { name: /webapp/ }));
    expect(opened).toBe(1);
  });
});
