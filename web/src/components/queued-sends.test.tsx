import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { server } from "@/test/setup";
import { __resetSendQueue, enqueueSend, queuedForPane } from "@/lib/send-queue";
import { QueuedSends } from "./queued-sends";
import { __resetLocale, setLocale, whenLocaleReady } from "@/lib/i18n";

// The rows above the composer: what is waiting, why, and the two taps.

beforeEach(() => { __resetSendQueue(); __resetLocale(); });

describe("QueuedSends", () => {
  it("names saved uncertain rows and their resend action in Traditional Chinese", async () => {
    act(() => setLocale("zh-TW"));
    await act(() => whenLocaleReady("zh-TW"));
    enqueueSend({ paneId: "w1:p1", text: "原文", kind: "message", agent: null, possiblyDelivered: true });
    render(<QueuedSends paneId="w1:p1" />);
    expect(screen.getByText("保留的訊息")).toBeInTheDocument();
    expect(screen.getByText(/可能已送出，請先看畫面/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再送一次訊息 1：原文" })).toHaveTextContent("再送一次");
    expect(screen.getByRole("button", { name: "展開完整訊息 1：原文" })).toBeInTheDocument();
  });
  it("names uncertain delivery and expands the complete unmodified message", async () => {
    const user = userEvent.setup();
    const text = "First line\nSecond line\nFinal sentinel <script>kept as text</script>";
    enqueueSend({ paneId: "w1:p1", text, kind: "message", agent: null, possiblyDelivered: true });
    const { container } = render(<QueuedSends paneId="w1:p1" />);
    expect(screen.getByText(/May already have been sent; check the pane first/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /^Full message 1:/ })).toBeNull();
    const expand = screen.getByRole("button", { name: /^Show full message 1:/ });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    await user.click(expand);
    const expanded = screen.getByRole("button", { name: /^Collapse message 1:/ });
    expect(expanded).toHaveAttribute("aria-expanded", "true");
    const full = screen.getByRole("textbox", { name: /^Full message 1:/ });
    expect(full).toHaveValue(text);
    expect(expanded).toHaveAttribute("aria-controls", full.id);
    expect(full).toHaveAttribute("readonly");
    expect(full.closest("button")).toBeNull();
    await user.tab();
    expect(full).toHaveFocus();
    expect(container.querySelector("script")).toBeNull();
    await user.click(expanded);
    expect(screen.queryByRole("textbox", { name: /^Full message 1:/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Send again, message 1:/ })).toHaveTextContent("Send again");
    expect(screen.getByRole("button", { name: /^Discard message 1:/ })).toHaveTextContent("Discard");
  });
  it("renders nothing while the pane has nothing waiting, and the rows when it does", () => {
    const { container } = render(<QueuedSends paneId="w1:p1" />);
    expect(container.querySelector('[data-slot="queued-sends"]')).toBeNull();
    act(() => {
      enqueueSend({ paneId: "w1:p1", text: "ship it", kind: "message", agent: "claude" });
    });
    expect(screen.getByText("ship it")).toBeInTheDocument();
    expect(screen.getByText("Saved messages")).toBeInTheDocument();
  });

  it("keeps the uncertainty warning and shows a forced resend's refusal, including after reload", async () => {
    const user = userEvent.setup();
    server.use(http.post(/\/api\/pane\/[^/]+\/reply$/, () =>
      HttpResponse.json({ ok: false, error: "The pane is showing a dialog" })));
    enqueueSend({ paneId: "w1:p1", text: "check first", kind: "message", agent: null, possiblyDelivered: true });
    const view = render(<QueuedSends paneId="w1:p1" />);
    await user.click(screen.getByRole("button", { name: /^Send again, message 1:/ }));
    await waitFor(() => expect(screen.getByText("The pane is showing a dialog")).toBeInTheDocument());
    expect(screen.getByText(/May already have been sent; check the pane first/)).toBeInTheDocument();
    const raw = localStorage.getItem("collie:send-queue:v1")!;
    view.unmount();
    __resetSendQueue();
    localStorage.setItem("collie:send-queue:v1", raw);
    render(<QueuedSends paneId="w1:p1" />);
    expect(screen.getByText("The pane is showing a dialog")).toBeInTheDocument();
    expect(screen.getByText(/May already have been sent; check the pane first/)).toBeInTheDocument();
    expect(queuedForPane(undefined, "w1:p1")[0]?.possiblyDelivered).toBe(true);
  });

  it("distinguishes identical previews and resends only the chosen row's complete text", async () => {
    const user = userEvent.setup();
    const posted: string[] = [];
    server.use(http.post<never, { text: string }>(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
      posted.push((await request.json()).text);
      return HttpResponse.json({ ok: true });
    }));
    const first = "Same preview\nSame second line\nFirst tail";
    const second = "Same preview\nSame second line\nSecond tail";
    for (const text of [first, second]) {
      enqueueSend({ paneId: "w1:p1", text, kind: "message", agent: null, possiblyDelivered: true });
    }
    render(<QueuedSends paneId="w1:p1" />);
    expect(screen.getByRole("button", { name: /^Show full message 1:/ })).toBeInTheDocument();
    const expand = screen.getByRole("button", { name: /^Show full message 2:/ });
    await user.click(expand);
    const full = screen.getByRole("textbox", { name: /^Full message 2:/ });
    expect(full).toHaveValue(second);
    expect(screen.getByRole("button", { name: /^Collapse message 2:/ })).toHaveAttribute("aria-controls", full.id);
    expect(screen.getByRole("button", { name: /^Discard message 1:/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Discard message 2:/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Send again, message 2:/ }));
    await waitFor(() => expect(queuedForPane(undefined, "w1:p1").map((row) => row.text)).toEqual([first]));
    expect(posted).toEqual([second]);
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
    await user.click(screen.getByRole("button", { name: /^Discard message 1:/ }));
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
    await user.click(screen.getByRole("button", { name: /^Send now, message 1:/ }));
    await waitFor(() => expect(queuedForPane(undefined, "w1:p1")).toEqual([]));
    expect(posted).toEqual(["ls -la"]);
  });
});
