// FORK: no Report a problem on this install (lib/fork-shape.ts `FORK_REPORT_ON`). Upstream's cases in
// composer-report.test.tsx run WITH the three-failed-sends card, because the gate is on under vitest;
// this file turns it off the way the production bundle has it.

import type { ComponentProps } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { markLive, resetLiveness } from "@/lib/liveness";
import { clearStatus } from "@/lib/status";
import { server } from "@/test/setup";
import { Composer } from "./composer";

vi.mock("@/lib/fork-shape", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/fork-shape")>()),
  FORK_REPORT_ON: false,
}));

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  resetLiveness();
  markLive("w1:p1");
});
afterEach(() => cleanup());

function renderComposer() {
  const props: ComponentProps<typeof Composer> = {
    paneId: "w1:p1",
    agent: "claude",
    isShell: false,
    gone: false,
    readOnly: false,
    surface: { revision: 1, turn: "idle", modal: "none", composer: "empty" },
    text: "pane output",
    terminalDraft: null,
    rawTerminalDraft: null,
    prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true, controlsOpen: true, paneView: {}, stretchText: false },
    display: { open: false, onToggle: vi.fn() },
    onSent: vi.fn(),
  };
  const router = createMemoryRouter([{ path: "/", element: <Composer {...props} /> }]);
  return render(<RouterProvider router={router} />);
}

describe("Composer without Report a problem (fork)", () => {
  it("three failed sends in a row float no report card", async () => {
    const user = userEvent.setup();
    const ids: string[] = [];
    server.use(
      http.post(/\/api\/send$/, async ({ request }) => {
        // SAFETY: the composer under test is the only poster, and its body carries the request id.
        const { id } = (await request.json()) as { id: string };
        ids.push(id);
        return HttpResponse.json({ receipt: { outcome: "unknown", reason: "crash", keys: [] }, offers: ["keys"] });
      }),
    );
    const { container } = renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);
    for (let i = 0; i < 3; i++) {
      await user.type(box, `try ${String(i)}`);
      await user.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(ids).toHaveLength(i + 1));
      await user.clear(box);
    }
    // The third refusal has landed (its sentence is up) and still no card stands above the box.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Report this problem" })).toBeNull());
    expect(container.querySelector('[data-slot="report-card"]')).toBeNull();
    expect(ids).toHaveLength(3);
  });
});
