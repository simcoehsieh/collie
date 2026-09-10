import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { server } from "@/test/setup";
import { __resetSendQueue, enqueueSend, queuedForPane } from "@/lib/send-queue";
import { QueuedSends } from "./queued-sends";

// The rows above the composer: what is waiting, why, and the two taps.

beforeEach(() => __resetSendQueue());

describe("QueuedSends", () => {
  it("renders nothing while the pane has nothing waiting, and the rows when it does", () => {
    const { container } = render(<QueuedSends paneId="w1:p1" />);
    expect(container.querySelector('[data-slot="queued-sends"]')).toBeNull();
    act(() => {
      enqueueSend({ paneId: "w1:p1", text: "ship it", kind: "message", agent: "claude" });
    });
    expect(screen.getByText("ship it")).toBeInTheDocument();
    expect(screen.getByText("Waiting to send")).toBeInTheDocument();
  });

  it("only this pane's rows", () => {
    enqueueSend({ paneId: "w1:p2", text: "elsewhere", kind: "message", agent: null });
    render(<QueuedSends paneId="w1:p1" />);
    expect(screen.queryByText("elsewhere")).not.toBeInTheDocument();
  });

  it("an answer says it is waiting for a tap, and a held row carries the pane's reason", () => {
    enqueueSend({ paneId: "w1:p1", text: "y", kind: "answer", agent: "claude", status: "blocked" });
    render(<QueuedSends paneId="w1:p1" />);
    expect(screen.getByText(/Waiting for you/)).toBeInTheDocument();
  });

  it("Discard drops the row", async () => {
    const user = userEvent.setup();
    enqueueSend({ paneId: "w1:p1", text: "never mind", kind: "message", agent: null });
    render(<QueuedSends paneId="w1:p1" />);
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(queuedForPane(undefined, "w1:p1")).toEqual([]);
  });

  it("Send now sends THAT row through the guarded reply", async () => {
    const user = userEvent.setup();
    const posted: string[] = [];
    server.use(
      http.post<never, { text?: string }>(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
        posted.push((await request.json()).text ?? "");
        return HttpResponse.json({ ok: true });
      }),
    );
    // No adapter for a shell, so the send is the one-shot reply and completes without an echo.
    enqueueSend({ paneId: "w1:p1", text: "ls -la", kind: "message", agent: null });
    render(<QueuedSends paneId="w1:p1" />);
    await user.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(queuedForPane(undefined, "w1:p1")).toEqual([]));
    expect(posted).toEqual(["ls -la"]);
  });
});
