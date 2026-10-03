import { useState, type ComponentProps } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { http, HttpResponse } from "msw";
import { server } from "@/test/setup";
import { clearStatus, useStatus } from "@/lib/status";
import { Composer } from "./composer";
import { BottomSheet } from "./ui/sheet";

type Props = ComponentProps<typeof Composer>;

function rig(overrides: Partial<Props> = {}) {
  let update: (next: Partial<Props>) => void = () => { throw new Error("Rig not mounted"); };
  function Rig() {
    const actionStatus = useStatus();
    const [props, setProps] = useState<Props>({
      paneId: "w1:p1", agent: "claude", isShell: false, status: "working", gone: false,
      readOnly: false, dialogPresent: false, text: "working", terminalDraft: null,
      rawTerminalDraft: null,
      prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system",
        rawTerminal: false, tapToFocus: true, expandClippedReply: true, controlsOpen: true, paneView: {} },
      display: { open: false, onToggle: vi.fn() }, onSent: vi.fn(), ...overrides,
    });
    update = (next) => act(() => setProps((current) => ({ ...current, ...next })));
    return <><Composer {...props} /><output aria-label="Action status">{actionStatus?.text ?? ""}</output></>;
  }
  const router = createMemoryRouter([{ path: "/", element: <Rig /> }]);
  const view = render(<RouterProvider router={router} />);
  return { ...view, update: (next: Partial<Props>) => update(next) };
}

describe("Composer — deliberate interrupt without a recall", () => {
  let keys: string[][];
  let keyTargets: string[];
  beforeEach(() => {
    clearStatus();
    keys = [];
    keyTargets = [];
    server.use(http.post<never, { keys: string[] }>(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
      keys.push((await request.json()).keys);
      keyTargets.push(decodeURIComponent(new URL(request.url).pathname));
      return HttpResponse.json({ ok: true });
    }));
  });
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  it.each(["claude", "codex"])("requires two taps and sends %s's declared key without restoring text", async (agent) => {
    rig({ agent });
    fireEvent.click(screen.getByRole("button", { name: "Interrupt agent" }));
    expect(keys).toEqual([]);
    expect(screen.getByRole("button", { name: "Tap again to interrupt" })).toHaveTextContent("Tap again to interrupt");
    fireEvent.click(screen.getByRole("button", { name: "Tap again to interrupt" }));
    await waitFor(() => expect(keys).toEqual([["Escape"]]));
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Stop and edit what you sent" })).toBeNull();
  });

  it("expires after two seconds, so the next tap only arms again", () => {
    vi.useFakeTimers();
    rig();
    fireEvent.click(screen.getByRole("button", { name: "Interrupt agent" }));
    expect(screen.getByRole("status", { name: "Action status" })).toHaveTextContent("Tap again to interrupt");
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByRole("status", { name: "Action status" })).toBeEmptyDOMElement();
    fireEvent.click(screen.getByRole("button", { name: "Interrupt agent" }));
    expect(screen.getByRole("button", { name: "Tap again to interrupt" })).toBeInTheDocument();
    expect(keys).toEqual([]);
  });

  it.each([
    { agent: "agy" }, { agent: "antigravity" }, { agent: undefined, isShell: true },
    { agent: "claude", isShell: true }, { status: "idle" as const },
    { status: "blocked" as const }, { dialogPresent: true }, { readOnly: true }, { gone: true },
  ])("does not offer interrupt for %j", (props) => {
    rig(props);
    expect(screen.queryByRole("button", { name: "Interrupt agent" })).toBeNull();
    expect(keys).toEqual([]);
  });

  it.each([
    { paneId: "w1:p2" }, { scope: { host: "other" } }, { dialogPresent: true },
    { display: { open: true, onToggle: vi.fn() } }, { status: "idle" as const },
  ])("disarms when the pane or interaction changes: %j", async (next) => {
    const view = rig();
    fireEvent.click(screen.getByRole("button", { name: "Interrupt agent" }));
    view.update(next);
    view.update({ dialogPresent: false, status: "working", display: { open: false, onToggle: vi.fn() } });
    // The second physical press after switching must only arm the new pane, never send Esc.
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /^(Interrupt agent|Tap again to interrupt)$/ })));
    expect(keys).toEqual([]);
    expect(screen.getByRole("button", { name: "Tap again to interrupt" })).toHaveTextContent("Tap again to interrupt");
    fireEvent.click(screen.getByRole("button", { name: "Tap again to interrupt" }));
    await waitFor(() => expect(keys).toEqual([["Escape"]]));
    expect(keyTargets).toEqual([`/api/pane/${"paneId" in next ? next.paneId : "w1:p1"}/keys`]);
  });

  it("disarms on a draft and does not rearm when the draft clears", () => {
    rig();
    fireEvent.click(screen.getByRole("button", { name: "Interrupt agent" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "a new message" } });
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Interrupt agent" })).toBeInTheDocument();
    expect(keys).toEqual([]);
  });

  it("disarms when another app sheet takes focus", () => {
    rig();
    fireEvent.click(screen.getByRole("button", { name: "Interrupt agent" }));
    const sheet = render(<BottomSheet open onClose={vi.fn()} title="Pane actions">actions</BottomSheet>);
    expect(screen.queryByRole("button", { name: "Tap again to interrupt" })).toBeNull();
    sheet.unmount();
    expect(screen.getByRole("button", { name: "Interrupt agent" })).toBeInTheDocument();
    expect(keys).toEqual([]);
  });

  it.each(["visibilitychange", "pagehide", "blur"])("disarms on leaving via %s", (event) => {
    rig();
    fireEvent.click(screen.getByRole("button", { name: "Interrupt agent" }));
    if (event === "visibilitychange") {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      fireEvent(document, new Event(event));
    } else fireEvent(window, new Event(event));
    expect(screen.queryByRole("button", { name: "Tap again to interrupt" })).toBeNull();
    expect(keys).toEqual([]);
  });
});
