// The free-text reply since M56 spec 06: one Send Protocol request, its request id and the meaning of
// its answer. The phone reads nothing before a send and sends no key of its own; the bridge's Send
// Protocol owns the guard against issue #34 (bridge/surface/protocol.test.ts pins it on fake panes).

import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { recordedSends, sendAnswer, sendHandler } from "@/test/handlers";
import { plainFailureMessage } from "./api";
import { modeFor, sendGuardedReply, sendText } from "./reply-action";

// M46 spec 11: the pane is pinned live here; reply-action-offline.test.ts covers the gate itself.
vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => true,
  useLive: () => true,
}));

let minted = 0;
const mint = () => `test-request-${String(++minted).padStart(4, "0")}`;

/** Every request the phone made, by method and path, to prove nothing else went out. */
function watchOtherCalls() {
  const calls: string[] = [];
  server.events.on("request:start", ({ request }) => {
    calls.push(`${request.method} ${new URL(request.url).pathname}`);
  });
  return calls;
}

afterEach(() => server.events.removeAllListeners());

describe("sendText", () => {
  it("is one request to /api/send and nothing else: no pane read, no key", async () => {
    const calls = watchOtherCalls();
    const out = await sendText({ paneId: "w1:p1", text: "ship it please", held: null, mint });
    expect(out).toMatchObject({ status: "answered", reading: { clear: true, note: "sent" } });
    expect(calls).toEqual(["POST /api/send"]);
    expect(recordedSends()).toEqual([{ id: "test-request-0001", pane: "w1:p1", text: "ship it please", mode: "send" }]);
  });

  it("sends a reserved lead as a command, and an offer's mode and rows hash as given", async () => {
    await sendText({ paneId: "w1:p1", text: "/compact", held: null, mint });
    await sendText({ paneId: "w1:p1", text: "the rest", mode: "append", held: null, mint });
    await sendText({ paneId: "w1:p1", text: "check this", mode: "send", rowsHash: "0abc12", held: null, mint });
    expect(recordedSends().map(({ mode, rowsHash }) => ({ mode, rowsHash }))).toEqual([
      { mode: "command", rowsHash: undefined },
      { mode: "append", rowsHash: undefined },
      { mode: "send", rowsHash: "0abc12" },
    ]);
  });

  it("a resend names the old request id and sends an empty text; a plain send carries no resendOf", async () => {
    await sendText({ paneId: "w1:p1", text: "", mode: "send", resendOf: "req00001", held: null, mint });
    await sendText({ paneId: "w1:p1", text: "plain", held: null, mint });
    const [resend, plain] = recordedSends();
    expect(resend).toMatchObject({ text: "", mode: "send", resendOf: "req00001" });
    expect(resend!.id).not.toBe("req00001");
    expect(plain).not.toHaveProperty("resendOf");
  });

  it("a resend keeps its request id across a lost answer, and another old id is a new intent", async () => {
    server.use(http.post("/api/send", () => HttpResponse.error()));
    const first = await sendText({ paneId: "w1:p1", text: "", mode: "send", resendOf: "req00001", held: null, mint });
    expect(first.status).toBe("noAnswer");
    if (first.status !== "noAnswer") return;
    server.resetHandlers();
    await sendText({ paneId: "w1:p1", text: "", mode: "send", resendOf: "req00001", held: first.intent, mint });
    await sendText({ paneId: "w1:p1", text: "", mode: "send", resendOf: "req00002", held: first.intent, mint });
    const ids = recordedSends().map((s) => s.id);
    expect(ids[0]).toBe(first.intent.requestId);
    expect(ids[1]).not.toBe(first.intent.requestId);
  });

  it("modeFor: a slash command, a shell line or a file mention at the start is a command", () => {
    expect(modeFor("/model")).toBe("command");
    expect(modeFor("  !ls")).toBe("command");
    expect(modeFor("@src/app.ts look here")).toBe("command");
    expect(modeFor("look at @src/app.ts")).toBe("send");
  });

  it("a refusal keeps the draft and carries the bridge's surface and sentence", async () => {
    server.use(
      ...sendHandler((request) =>
        sendAnswer(request.id, "refused", "not_free", {
          offers: ["keys"],
          surface: { revision: 4, turn: "running", modal: "none", composer: "empty" },
          detail: "The agent is working.",
        }),
      ),
    );
    const out = await sendText({ paneId: "w1:p1", text: "hello there", held: null, mint });
    expect(out).toMatchObject({
      status: "answered",
      reading: { clear: false, note: "notFree", surface: "running", detail: "The agent is working.", offers: [] },
    });
  });

  it("no answer keeps the intent: the next tap on the same text asks for the same request id", async () => {
    server.use(http.post("/api/send", () => HttpResponse.error()));
    const first = await sendText({ paneId: "w1:p1", text: "same words", held: null, mint });
    expect(first.status).toBe("noAnswer");
    if (first.status !== "noAnswer") return;
    server.resetHandlers();
    await sendText({ paneId: "w1:p1", text: "same words", held: first.intent, mint });
    expect(recordedSends().map((s) => s.id)).toEqual([first.intent.requestId]);
    // Another text is another intent, with a new id.
    await sendText({ paneId: "w1:p1", text: "other words", held: first.intent, mint });
    expect(recordedSends()[1]!.id).not.toBe(first.intent.requestId);
  });

  it("a pane on a crew member goes through its reply route, and the answer comes back under send", async () => {
    const calls = watchOtherCalls();
    const out = await sendText({ paneId: "w1:p1", text: "from the lead", scope: { host: "workshop" }, held: null, mint });
    expect(out).toMatchObject({ status: "answered", reading: { clear: true } });
    expect(calls).toEqual(["POST /api/pane/w1%3Ap1/reply"]);
    expect(recordedSends()).toEqual([{ id: expect.stringMatching(/^test-request-/u), pane: "w1:p1", text: "from the lead", mode: "send", host: "workshop" }]);
  });

  it("a refusal whose body is not JSON says its status and its first line, not that the phone cannot read it", async () => {
    server.use(http.post("/api/send", () => new HttpResponse("the send protocol does not cross a crew link yet\nsecond line", { status: 400 })));
    const out = await sendText({ paneId: "w1:p1", text: "/model", held: null, mint });
    expect(out).toMatchObject({ status: "noAnswer", error: "HTTP 400: the send protocol does not cross a crew link yet" });
  });

  it("an older member's refusal on the reply route reads as a refusal with the lead's sentence (2026-10-17 field case)", async () => {
    const detail = "This machine runs an older Collie and cannot take a send from the phone yet. Update it from the Crew page.";
    server.use(
      http.post("/api/pane/:id/reply", () =>
        HttpResponse.json({
          ok: false,
          textDelivered: false,
          error: "that machine runs an older Collie",
          code: "reply.send_failed",
          detail: { reason: "that machine runs an older Collie" },
          send: { receipt: { outcome: "refused", requestId: "test-request-0001" }, offers: ["keys"], detail },
        }),
      ),
    );
    const out = await sendText({ paneId: "w1:p1", text: "/model", scope: { host: "minibuch" }, held: null, mint });
    expect(out).toMatchObject({ status: "answered", reading: { clear: false, note: "refused", detail } });
  });

  it("a reply route refusal with no send answer is said in its own words", async () => {
    server.use(
      http.post("/api/pane/:id/reply", () =>
        HttpResponse.json({ ok: false, textDelivered: false, error: "nope", code: "reply.send_failed", detail: { reason: "update the lead" } }),
      ),
    );
    const out = await sendText({ paneId: "w1:p1", text: "/model", scope: { host: "minibuch" }, held: null, mint });
    expect(out).toMatchObject({ status: "noAnswer", error: "The message couldn't be sent: update the lead" });
  });
});

describe("plainFailureMessage", () => {
  it("keeps the status and the first line that has words, and leaves a JSON body to the catalogue", () => {
    expect(plainFailureMessage(404, "\n  no such terminal pane  \nmore")).toBe("HTTP 404: no such terminal pane");
    expect(plainFailureMessage(502, "")).toBe("HTTP 502");
    expect(plainFailureMessage(400, `{"error":"x"}`)).toBeNull();
    expect(plainFailureMessage(400, "x".repeat(400))).toHaveLength("HTTP 400: ".length + 160);
  });
});

// FORK (69452bb5): the saved-sends queue and the notes sheet read the outcome in the queue's shape,
// and keep the delivery evidence it carries. Since upstream 1.22 the send is one Send Protocol
// request, so the evidence is read off that request: an answer that never came after the POST went
// out may have been typed, and only the front door's own sign-in refusal proves it was not.
describe("sendGuardedReply: delivery evidence for the send queue", () => {
  it("a taken send is sent, through the one Send Protocol request", async () => {
    const calls = watchOtherCalls();
    expect(await sendGuardedReply({ paneId: "w1:p1", text: "do this once", agent: "claude", mint })).toEqual({ status: "sent" });
    expect(calls).toEqual(["POST /api/send"]);
  });

  it("a send the bridge holds for the turn's end counts as sent: the bridge keeps it", async () => {
    server.use(...sendHandler((request) => sendAnswer(request.id, "held")));
    expect(await sendGuardedReply({ paneId: "w1:p1", text: "after the turn", mint })).toEqual({ status: "sent" });
  });

  it("a lost answer after the POST is a link failure that may have been delivered", async () => {
    let posted = false;
    server.use(http.post("/api/send", () => {
      posted = true;
      return HttpResponse.error();
    }));
    const outcome = await sendGuardedReply({ paneId: "w1:p1", text: "do this once", agent: null, mint });
    expect(posted).toBe(true);
    expect(outcome).toMatchObject({ status: "error", transport: "network", possiblyDelivered: true });
  });

  it.each([502, 504, 520, 522, 524])("a POST answered with %i is held as possibly delivered", async (status) => {
    server.use(http.post("/api/send", () => new HttpResponse("edge failure", { status })));
    const outcome = await sendGuardedReply({ paneId: "w1:p1", text: "do this once", mint });
    expect(outcome).toMatchObject({ status: "error", transport: "server", possiblyDelivered: true });
  });

  it("an explicit authentication refusal is known unsent", async () => {
    server.use(http.post("/api/send", () => new HttpResponse("sign in", { status: 401 })));
    const outcome = await sendGuardedReply({ paneId: "w1:p1", text: "do this once", mint });
    expect(outcome).toMatchObject({ status: "error", transport: "auth" });
    expect(outcome).not.toHaveProperty("possiblyDelivered");
  });

  it("a refusal from the pane is the pane's, with its sentence: no transport, nothing to keep", async () => {
    server.use(...sendHandler((request) => sendAnswer(request.id, "refused", "not_free")));
    const outcome = await sendGuardedReply({ paneId: "w1:p1", text: "hello there", mint });
    expect(outcome).toEqual({ status: "error", error: "The input box is not free. Nothing was typed." });
  });

  it("text typed but not submitted is delivered text: never resent", async () => {
    server.use(...sendHandler((request) => sendAnswer(request.id, "typed_not_submitted", undefined, { offers: ["submit", "discard"] })));
    const outcome = await sendGuardedReply({ paneId: "w1:p1", text: "half way", mint });
    expect(outcome).toMatchObject({ status: "error", textDelivered: true });
  });
});
