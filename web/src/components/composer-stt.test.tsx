import { useState } from "react";
import type { ComponentProps } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { clearStatus, useStatus } from "@/lib/status";
import type { BridgeConfig } from "@/lib/types";
import { __resetHandsFree, setHandsFreeEnabled } from "@/lib/stt";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { server } from "@/test/setup";
import { sendAnswer, sendHandler } from "@/test/handlers";
import {
  FakeMediaRecorder,
  installFakeMediaRecorder,
  uninstallFakeMediaRecorder,
} from "@/test/media-recorder";
import { Composer } from "./composer";

// M46 spec 11 turns every send off for a pane the bridge has not answered lately (lib/liveness.ts).
// These suites drive sends against a mocked network and never poll first, so they pin the pane live;
// the gating itself is covered by liveness.test.ts and the *-offline suites.
vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => true,
  useLive: () => true,
}));

// The composer's microphone (ADR 0029). Two gates decide whether it is drawn at all — the bridge
// publishing a provider, and this browser being able to record — and jsdom fails the second one by
// default, so every case that wants a button installs the fake recorder first.
//
// The send path is asserted AT THE NETWORK, never with a spy on `sendGuardedReply`: hands-free is
// specified as "through the same guarded path a typed reply takes", and the only evidence that
// distinguishes that from a shortcut is the guard's own two-call shape on the wire — type with
// `submit:false`, verify, then submit.

const CONFIG_WITH_STT: BridgeConfig = {
  push: false,
  vapidPublicKey: "",
  stt: { provider: "openai-compatible", available: true },
};

/** `/api/config` answering with a given stt block (or none), counting the reads. */
function configHandler(config: BridgeConfig, onRead?: () => void) {
  return http.get("/api/config", () => {
    onRead?.();
    return HttpResponse.json(config);
  });
}

/** The transcription endpoint, answering with one transcript and counting the posts. */
function sttHandler(text: string, onPost?: (contentType: string | null) => void) {
  return http.post("/api/stt", ({ request }) => {
    onPost?.(request.headers.get("content-type"));
    return HttpResponse.json({ ok: true, text });
  });
}

/** The transcription endpoint refusing, exactly as bridge/stt/http.ts does. */
function sttRefusal(status: number, error: string) {
  return http.post("/api/stt", () => HttpResponse.json({ ok: false, error }, { status }));
}

/** The fake bridge's Send Protocol, calling back with each request's body (M56 spec 06: one request per text). */
function replyHandler(onBody: (body: { text: string; mode: string }) => void) {
  return sendHandler((request) => {
    onBody({ text: request.text, mode: request.mode });
    return sendAnswer(request.id, "sent");
  });
}

function StatusSentinel() {
  const status = useStatus();
  return <div data-testid="status">{status?.text ?? ""}</div>;
}

function baseProps(
  overrides: Partial<ComponentProps<typeof Composer>>,
): ComponentProps<typeof Composer> {
  return {
    paneId: "w1:p1",
    agent: "claude",
    isShell: false,
    gone: false,
    readOnly: false,
    surface: { revision: 1, turn: "idle", modal: "none", composer: "empty" },
    text: "pane output",
    terminalDraft: null,
    rawTerminalDraft: null,
    prefs: {
      wrap: true,
      fontSize: 11,
      draftFontSize: 14,
      chatFontSize: 14,
      fontFamily: "system",
      rawTerminal: false,
      tapToFocus: true,
      expandClippedReply: true,
      controlsOpen: true,
      paneView: {},
      stretchText: false,
    },
    display: { open: false, onToggle: vi.fn() },
    onSent: vi.fn(),
    ...overrides,
  };
}

function renderComposer(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const props = baseProps(overrides);
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <>
          <StatusSentinel />
          <Composer {...props} />
        </>
      ),
    },
  ]);
  render(<RouterProvider router={router} />);
  return props;
}

/** Same composer, plus a control that changes the pane it addresses IN PLACE. */
function renderSwitchablePane() {
  function Harness() {
    const [paneId, setPaneId] = useState("w1:p1");
    return (
      <>
        <StatusSentinel />
        <button type="button" onClick={() => setPaneId("w2:p1")}>
          switch pane
        </button>
        <Composer {...baseProps({ paneId })} />
      </>
    );
  }
  const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
  render(<RouterProvider router={router} />);
}

/** Tap the mic, wait for the recorder the tap created. */
async function startRecording(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /record a voice message/i }));
  await waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1));
  return FakeMediaRecorder.instances[0]!;
}

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  __resetHandsFree();
  // The config store caches one successful read for the life of a page; each case is a page.
  __resetOperatorCommands();
  installFakeMediaRecorder();
});
afterEach(() => {
  uninstallFakeMediaRecorder();
  __resetHandsFree();
  __resetOperatorCommands();
});

describe("Composer — the record button is drawn only when there is a microphone", () => {
  it("renders no microphone when the bridge publishes no stt capability", async () => {
    let reads = 0;
    server.use(configHandler({ push: false, vapidPublicKey: "" }, () => (reads += 1)));
    renderComposer();
    await waitFor(() => expect(reads).toBe(1));
    expect(screen.queryByRole("button", { name: /record a voice message/i })).toBeNull();
    // …and the field reserves no strip at all, so a collie without one loses no width to it. It
    // was `pr-11` while the attach button stood in the field's corner; the button is the field's
    // sibling on the box's one row now (ADR 0057) and nothing inside the field reserves width.
    expect(screen.getByPlaceholderText(/type a reply/i).className).not.toMatch(/(?:^|\s)pr-/);
  });

  it("renders no microphone in an insecure context, even with a provider configured", async () => {
    // The guard #115 forgot: over plain HTTP `navigator.mediaDevices` is simply absent, so a button
    // would render and do nothing. Nothing on the phone fixes that, so it is hidden, not disabled.
    uninstallFakeMediaRecorder();
    let reads = 0;
    server.use(configHandler(CONFIG_WITH_STT, () => (reads += 1)));
    renderComposer();
    await waitFor(() => expect(reads).toBe(1));
    expect(screen.queryByRole("button", { name: /record a voice message/i })).toBeNull();
  });

  it("renders a disabled microphone wearing the bridge's reason when the provider can't serve", async () => {
    server.use(
      configHandler({
        push: false,
        vapidPublicKey: "",
        stt: { provider: "codex", available: false, reason: "codex is not signed in" },
      }),
    );
    renderComposer();
    const button = await screen.findByRole("button", { name: /codex is not signed in/i });
    expect(button).toBeDisabled();
  });
});

// FORK: the microphone is its own control inside the field, beside the attach clip, and the round
// button at the end of the row is always Send. Upstream shares one round button between the two
// (microphone on an empty box, Send once there is text), which read as the send key turning into a
// microphone. Here the glyphs never swap; Send is simply off while there is nothing to send.
describe("Composer — the microphone sits beside the clip, and Send is always Send", () => {
  it("draws both on an empty box: an enabled microphone and a disabled Send", async () => {
    let reads = 0;
    server.use(configHandler(CONFIG_WITH_STT, () => (reads += 1)));
    renderComposer();
    await waitFor(() => expect(reads).toBe(1));

    expect(await screen.findByRole("button", { name: /record a voice message/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^send$/i })).toBeDisabled();
    // The microphone is a sibling of the field in the box now (FORK: its own control, never the
    // end button), so the field reserves no horizontal strip for it — or for anything.
    expect(screen.getByPlaceholderText(/type a reply/i).className).not.toMatch(/(?:^|\s)pr-/);
  });

  it("lights Send on the first character, and keeps the microphone where it was", async () => {
    const user = userEvent.setup();
    server.use(configHandler(CONFIG_WITH_STT));
    renderComposer();
    const box = await screen.findByPlaceholderText(/type a reply/i);
    await screen.findByRole("button", { name: /record a voice message/i });

    await user.type(box, "x");
    await waitFor(() => expect(screen.getByRole("button", { name: /^send$/i })).toBeEnabled());
    expect(screen.getByRole("button", { name: /record a voice message/i })).toBeEnabled();

    await user.clear(box);
    await waitFor(() => expect(screen.getByRole("button", { name: /^send$/i })).toBeDisabled());
  });

  // ADR 0060: a chip is something to send. FORK: the microphone is its own control and stays
  // put; what a chips-only box changes is that Send comes on.
  it("a box holding only chips turns Send on, and the microphone stays", async () => {
    server.use(
      configHandler(CONFIG_WITH_STT),
      http.post(/\/api\/pane\/[^/]+\/upload$/, () => HttpResponse.json({ ok: true, path: "/a.png" })),
    );
    renderComposer();
    const box = await screen.findByPlaceholderText(/type a reply/i);
    await screen.findByRole("button", { name: /record a voice message/i });

    // SAFETY: `getByTestId` throws when the element is absent, and this id is on an `<input>`.
    const photos = screen.getByTestId("attach-photos") as HTMLInputElement;
    fireEvent.change(photos, { target: { files: [new File(["x"], "a.png", { type: "image/png" })] } });
    await waitFor(() => expect(box).toHaveValue("[Image #1] "));
    fireEvent.change(box, { target: { value: "" } });

    expect(screen.getByRole("button", { name: /record a voice message/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^send$/i })).toBeEnabled();
  });


  it("whitespace alone is not text — Send stays off over a box holding only spaces", async () => {
    const user = userEvent.setup();
    server.use(configHandler(CONFIG_WITH_STT));
    renderComposer();
    const box = await screen.findByPlaceholderText(/type a reply/i);
    await screen.findByRole("button", { name: /record a voice message/i });

    await user.type(box, "   ");
    expect(screen.getByRole("button", { name: /^send$/i })).toBeDisabled();
  });

  it("is one button that starts and stops the clip, and hands back to idle with the text landed", async () => {
    const user = userEvent.setup();
    server.use(configHandler(CONFIG_WITH_STT), sttHandler("done"));
    renderComposer();
    const recorder = await startRecording(user);
    expect(await screen.findByRole("button", { name: /stop recording/i })).toBeInTheDocument();

    act(() => recorder.finish());
    await waitFor(() => expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue("done"));
    expect(screen.getByRole("button", { name: /^send$/i })).toBeEnabled();
    expect(await screen.findByRole("button", { name: /record a voice message/i })).toBeEnabled();
  });
});

// FORK (2026-09-20): the microphone survives a physical keyboard. Three earlier attempts at
// "terminal typing on a desktop" armed the streaming mode on arrival, and `micShown` is
// `stt !== null && !direct.active` — so on a Mac the button was simply absent, and nobody noticed
// until the operator said "make sure voice input and attachments still work". There is no mode to
// arm any more (composer.tsx, `terminalNative`); this pins that from the outside.
describe("Composer — the microphone on a physical keyboard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is drawn and enabled on a fine pointer", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("pointer: fine"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    server.use(configHandler(CONFIG_WITH_STT));
    renderComposer();

    expect(await screen.findByRole("button", { name: /record a voice message/i })).toBeEnabled();
  });
});

describe("Composer — a finished clip", () => {
  it("lands in the draft at the caret", async () => {
    const user = userEvent.setup();
    let posted: string | null = null;
    server.use(
      configHandler(CONFIG_WITH_STT),
      sttHandler("there", (contentType) => (posted = contentType)),
    );
    renderComposer();
    // The microphone is the primary button only while the box is EMPTY, so recording starts first
    // and the typing happens DURING the clip — which is the one way a transcript can still meet a
    // non-empty draft, and the reason the caret insert below is not dead code.
    const recorder = await startRecording(user);
    expect(await screen.findByRole("group", { name: /voice input/i })).toBeInTheDocument();
    const box = screen.getByPlaceholderText(/type a reply/i);
    // The takeover makes the box inert, so a person can no longer type during a clip; a draft can
    // still appear under it (a restored or terminal-side one), which is the case this pins.
    fireEvent.change(box, { target: { value: "hello world" } });
    // Caret between the two words — dictating a clause into the middle of a sentence is the point.
    act(() => {
      if (box instanceof HTMLTextAreaElement) box.setSelectionRange(5, 5);
    });
    act(() => recorder.finish());

    await waitFor(() => expect(box).toHaveValue("hello there world"));
    // One clip, one POST, and the container names itself so the bridge can pick a demuxer.
    expect(posted).toMatch(/^audio\//);
    // The takeover is gone and the composer is back.
    await waitFor(() => expect(screen.queryByRole("group", { name: /voice input/i })).toBeNull());
  });

  it("is discarded — and never uploaded — when the pane changes mid-recording", async () => {
    const user = userEvent.setup();
    let posts = 0;
    server.use(
      configHandler(CONFIG_WITH_STT),
      sttHandler("never sent", () => (posts += 1)),
    );
    renderSwitchablePane();
    const recorder = await startRecording(user);
    expect(await screen.findByRole("group", { name: /voice input/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "switch pane" }));
    // Whatever the browser delivers after the discard belongs to an operation that no longer exists.
    act(() => recorder.finish());

    await waitFor(() => expect(screen.queryByRole("group", { name: /voice input/i })).toBeNull());
    expect(posts).toBe(0);
  });
});

describe("Composer — hands-free", () => {
  it("routes the transcript through the Send Protocol when the draft is empty", async () => {
    const user = userEvent.setup();
    setHandsFreeEnabled(true);
    const bodies: { text: string; mode: string }[] = [];
    server.use(
      configHandler(CONFIG_WITH_STT),
      sttHandler("ship it"),
      ...replyHandler((body) => bodies.push(body)),
    );
    renderComposer();
    const recorder = await startRecording(user);
    act(() => recorder.finish());

    // The same one Send Protocol request the Send button makes: the bridge's guard, never around it.
    await waitFor(() => expect(bodies).toEqual([{ text: "ship it", mode: "send" }]));
    expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue("");
  });

  it("falls back to inserting when the draft already holds text", async () => {
    const user = userEvent.setup();
    setHandsFreeEnabled(true);
    let replies = 0;
    server.use(
      configHandler(CONFIG_WITH_STT),
      sttHandler("and this"),
      ...replyHandler(() => (replies += 1)),
    );
    renderComposer();
    // Typed DURING the clip — see the caret case above for why that is the only way here.
    const recorder = await startRecording(user);
    const box = screen.getByPlaceholderText(/type a reply/i);
    fireEvent.change(box, { target: { value: "typed by hand" } });
    act(() => recorder.finish());

    // Merging dictated words onto typed ones and sending the result would send a sentence nobody
    // has read, so the two are combined in the box and the operator still presses Send.
    await waitFor(() => expect(box).toHaveValue("typed by hand and this"));
    expect(replies).toBe(0);
  });
});

describe("Composer — a refused transcription", () => {
  it.each([
    [429, "two recordings are already being transcribed", /busy/i],
    [413, "the recording is larger than 8 MiB", /too long/i],
    [504, "the transcriber timed out", /didn't answer in time/i],
  ])("says what %i means, in the composer's words", async (status, serverError, expected) => {
    const user = userEvent.setup();
    server.use(configHandler(CONFIG_WITH_STT), sttRefusal(status, serverError));
    renderComposer();
    const recorder = await startRecording(user);
    act(() => recorder.finish());

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent(expected));
    // Nothing reached the draft, and the audio is not held for a retry — the takeover is gone, so
    // there is no clip left to stop or discard.
    expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue("");
    await waitFor(() => expect(screen.queryByRole("group", { name: /voice input/i })).toBeNull());
  });
});

// THE VOICE TAKEOVER (design 3.3). A tap on the mic covers the whole chrome block without adding a
// pixel to it. jsdom has no layout, so the zero-shift property is pinned by its CAUSES: the takeover
// is an `absolute inset-0` SIBLING of the composer (inside agent-chat's `relative` chrome block, which
// this suite does not mount), and the real composer stays in flow beneath it, invisible and inert,
// the same nodes, never remounted. The measured proof is the browser case in
// web/e2e/voice-takeover.spec.ts.
describe("Composer — the voice takeover", () => {
  function block(): HTMLElement {
    const box = document.querySelector('[data-slot="composer-box"]');
    const el = box?.closest("div.relative.bg-chrome");
    if (!(el instanceof HTMLElement)) throw new Error("no composer block");
    return el;
  }

  it("covers the block with an absolute sibling, and leaves the real composer in flow, inert and unseen", async () => {
    const user = userEvent.setup();
    server.use(configHandler(CONFIG_WITH_STT));
    renderComposer();
    await screen.findByRole("button", { name: /record a voice message/i });
    const blockBefore = block();
    const boxBefore = document.querySelector('[data-slot="composer-box"]');
    const fieldBefore = screen.getByPlaceholderText(/type a reply/i);
    expect(screen.queryByRole("group", { name: /voice input/i })).toBeNull();
    expect(blockBefore).not.toHaveAttribute("inert");

    await user.click(screen.getByRole("button", { name: /record a voice message/i }));
    const region = await screen.findByRole("group", { name: /voice input/i });

    // The takeover is positioned over the whole box, and takes no place in the flow.
    expect(region.className).toMatch(/\babsolute\b/);
    expect(region.className).toMatch(/\binset-0\b/);
    expect(region.parentElement).toBe(block().parentElement);
    // The composer stays laid out: the same nodes, not remounted, hidden and inert in place.
    expect(block()).toBe(blockBefore);
    expect(document.querySelector('[data-slot="composer-box"]')).toBe(boxBefore);
    expect(screen.getByPlaceholderText(/type a reply/i)).toBe(fieldBefore);
    expect(block()).toHaveAttribute("inert");
    expect(block().className).toContain("invisible");
    expect(block().className).not.toMatch(/\bhidden\b|\bcontents\b/);
  });

  it("gives the block back with the same nodes when the clip is thrown away", async () => {
    const user = userEvent.setup();
    server.use(configHandler(CONFIG_WITH_STT));
    renderComposer();
    const fieldBefore = screen.getByPlaceholderText(/type a reply/i);
    await user.click(await screen.findByRole("button", { name: /record a voice message/i }));
    await user.click(await screen.findByRole("button", { name: /discard recording/i }));
    await waitFor(() => expect(screen.queryByRole("group", { name: /voice input/i })).toBeNull());
    expect(screen.getByPlaceholderText(/type a reply/i)).toBe(fieldBefore);
    expect(block()).not.toHaveAttribute("inert");
    expect(block().className).not.toContain("invisible");
  });

  it("wears the block's own bottom padding, with the keyboard up or down", async () => {
    const user = userEvent.setup();
    server.use(configHandler(CONFIG_WITH_STT));
    renderComposer({ composing: true });
    await user.click(await screen.findByRole("button", { name: /record a voice message/i }));
    const region = await screen.findByRole("group", { name: /voice input/i });
    expect(block().className).toMatch(/\bpb-2\b/);
    expect(region.className).toMatch(/\bpb-2\b/);
  });

  it("OK finishes and transcribes, and the transcript lands in the box", async () => {
    const user = userEvent.setup();
    server.use(configHandler(CONFIG_WITH_STT), sttHandler("hello"));
    renderComposer();
    const recorder = await startRecording(user);
    act(() => recorder.emit(1024));
    await user.click(await screen.findByRole("button", { name: /finish and transcribe/i }));
    expect(recorder.state).toBe("inactive");
    await waitFor(() => expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue("hello"));
    await waitFor(() => expect(screen.queryByRole("group", { name: /voice input/i })).toBeNull());
  });

  it("cancels an in-flight transcription from the bin: the request is aborted and the answer dropped", async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let aborted = false;
    let started = false;
    server.use(
      configHandler(CONFIG_WITH_STT),
      http.post("/api/stt", async ({ request }) => {
        started = true;
        request.signal.addEventListener("abort", () => {
          aborted = true;
        });
        await gate;
        return HttpResponse.json({ ok: true, text: "never lands" });
      }),
    );
    renderComposer();
    const recorder = await startRecording(user);
    act(() => recorder.finish());
    await waitFor(() => expect(started).toBe(true));
    const ok = await screen.findByRole("button", { name: /finish and transcribe/i });
    expect(ok).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/transcribing/i);

    await user.click(screen.getByRole("button", { name: /discard recording/i }));
    await waitFor(() => expect(screen.queryByRole("group", { name: /voice input/i })).toBeNull());
    await waitFor(() => expect(aborted).toBe(true));
    release();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue("");
    expect(screen.getByTestId("status")).toHaveTextContent("");
  });

  it("discards on Escape without uploading", async () => {
    const user = userEvent.setup();
    let posts = 0;
    server.use(configHandler(CONFIG_WITH_STT), sttHandler("x", () => (posts += 1)));
    renderComposer();
    const recorder = await startRecording(user);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("group", { name: /voice input/i })).toBeNull());
    act(() => recorder.finish());
    expect(posts).toBe(0);
  });

  it("moves focus to OK on open and back to the round button on close", async () => {
    const user = userEvent.setup();
    server.use(configHandler(CONFIG_WITH_STT));
    renderComposer();
    await user.click(await screen.findByRole("button", { name: /record a voice message/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /finish and transcribe/i })).toHaveFocus());
    await user.click(screen.getByRole("button", { name: /discard recording/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /record a voice message/i })).toHaveFocus());
  });

  it("says OK will send when hands-free will send the transcript", async () => {
    const user = userEvent.setup();
    setHandsFreeEnabled(true);
    server.use(configHandler(CONFIG_WITH_STT));
    renderComposer();
    await user.click(await screen.findByRole("button", { name: /record a voice message/i }));
    expect(await screen.findByRole("button", { name: /transcribe and send/i })).toBeInTheDocument();
  });

  it("mirrors for the left hand: OK takes the mic's side", async () => {
    const user = userEvent.setup();
    server.use(configHandler(CONFIG_WITH_STT));
    renderComposer({ hand: "left" });
    await user.click(await screen.findByRole("button", { name: /record a voice message/i }));
    const row = (await screen.findByRole("group", { name: /voice input/i })).querySelector('[data-slot="voice-takeover-row"]');
    expect(row?.className).toContain("flex-row-reverse");
    expect(document.querySelector('[data-slot="composer-box"]')?.className).toContain("flex-row-reverse");
  });

  it("the armed strip is gone: no Stop link and no 'Recording m:ss' line", async () => {
    const user = userEvent.setup();
    server.use(configHandler(CONFIG_WITH_STT));
    renderComposer();
    await startRecording(user);
    await screen.findByRole("group", { name: /voice input/i });
    expect(screen.queryByRole("button", { name: /^stop$/i })).toBeNull();
    expect(screen.queryByText(/^recording /i)).toBeNull();
  });
});
