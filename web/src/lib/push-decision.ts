// Pure decision logic for the service worker's `push` handler, split out of sw.ts so it's
// unit-testable without service-worker globals (sw.ts itself can't run under Vitest-on-Node — it
// touches `self`, workbox, and `__WB_MANIFEST`). The SW keeps only the glue: parse the event, read
// client visibility, then perform the side effect this returns. Everything *decided* — suppress vs
// show vs clear, tag derivation, title/renotify defaults, and the URL a tap opens — is plain data
// in, plain data out.

import { scopeSearch } from "./scope";

// Payload shape is whatever bridge/push.ts sends: a render → { title, body, tag, renotify,
// data: { paneId } }; a retraction → { type: "clear", tag }.
export interface PushPayload {
  type?: "clear";
  title?: string;
  body?: string;
  /**
   * Buttons on the notification. The bridge sends exactly Yes/No, and only for a single blocked
   * pane whose tail it saw a yes/no dialog on (bridge/prompt-peek.ts); the tap handler answers
   * through the pane's own grammar, from a fresh read (sw.ts). Anything else here is ignored.
   */
  actions?: PushActionSpec[];
  /** Notification slot. The bridge sends one shared "collie:herd" tag so the herd coalesces. */
  tag?: string;
  /** Re-alert when replacing the slot (a new agent arrived) vs. update it silently (a retraction). */
  renotify?: boolean;
  /**
   * FORK: what the app icon's badge should say — outstanding alerts, 0 on a retraction. Absent on a
   * push that has no view of the herd, and the worker then leaves the badge as it is.
   */
  badge?: number;
  /**
   * `session` is the registry name the pane lives in — carried so the click deep-links into it.
   * `host` is the crew member the pane lives ON, stamped by the bridge for a peer's pane only
   * (`bridge/push.ts` adds it to `data` exactly the way it adds `session`, so a solo/lead payload is
   * byte-identical to the pre-crew one). `target` names a non-pane destination for the tap (e.g.
   * "settings" for an update notification); absent = the default agent deep-link path.
   */
  data?: NotifData;
}

/**
 * What the bridge puts in `Notification.data`, and therefore what a tap has to work from. Declared
 * here rather than in sw.ts so the payload shape and the tap shape cannot drift — they are the same
 * object, written on one side of `showNotification` and read on the other.
 */
/** One notification button, as the bridge writes it and `showNotification` takes it. */
export interface PushActionSpec {
  action: string;
  title: string;
}

/** The two buttons this app understands. A payload naming any other action gets no buttons at all —
 *  a button the tap handler cannot honour is worse than none. Two is also the smallest ceiling any
 *  supported platform draws. */
export const KNOWN_ACTIONS: ReadonlySet<string> = new Set(["yes", "no"]);

/**
 * What a Yes/No button sends: the keystrokes for each answer and the dialog text they are bound to.
 * Written by bridge/prompt-peek.ts at push time; the service worker posts it verbatim to
 * `/api/pane/:id/keys` with `expected_prompt: region`, and the bridge refuses the keys unless the
 * region is still at the tail of a fresh read. The worker never interprets a dialog itself.
 */
export interface ApproveSpec {
  yes: string[];
  no: string[];
  region: string;
}

export interface NotifData {
  paneId?: string;
  /** The pane's agent ("claude"). Informational. */
  agent?: string;
  /** Present exactly when the payload carries Yes/No buttons — what they send. */
  approve?: ApproveSpec;
  /** Registry name of the pane's session (undefined = primary) — the deep-link scopes to it. */
  session?: string;
  /** Crew member the pane lives on (undefined = the lead) — the deep-link scopes to it. */
  host?: string;
  /** Non-pane tap destination (e.g. "settings"); absent = the default agent deep-link. */
  target?: string;
}

export type PushDecision =
  /** Close any notification on this tag (retraction) — runs regardless of client visibility. */
  | { kind: "clear"; tag: string; badge?: number }
  /** A Collie tab is already visible and showing this; don't raise a redundant system notification. */
  | { kind: "suppress" }
  /** Show (or replace) the notification on this tag. */
  | {
      kind: "show";
      title: string;
      body: string;
      tag: string;
      paneId?: string;
      /** Registry name of the pane's session (undefined = primary) — for the click deep-link. */
      session?: string;
      /** Crew member the pane lives on (undefined = the lead) — for the click deep-link. */
      host?: string;
      /** Non-pane tap destination (e.g. "settings"); undefined = the default agent deep-link. */
      target?: string;
      /** The pane's agent. Informational. */
      agent?: string;
      /** The buttons to show, when the payload's are the two this app can honour. */
      actions?: PushActionSpec[];
      /** What those buttons send — present exactly when `actions` is. */
      approve?: ApproveSpec;
      renotify: boolean;
      /** FORK: the app icon's badge after this push; absent = leave it. */
      badge?: number;
    };

/**
 * Separates a notification slot's base from the host that owns it — the frontend half of
 * `bridge/crew/tags.ts`'s `HOST_TAG_SEP`, which the bridge documents at length and this side must
 * reproduce exactly (the bridge writes the tag on a render, this file re-derives it on a fallback,
 * and a retraction has to close the slot the render opened).
 *
 * `@` and not `:` for the injectivity argument recorded there: a member id is
 * `[a-z0-9][a-z0-9-]{0,62}` and so contains neither separator, which makes the character right after
 * the base the discriminator — `@` ⇒ a peer's slot, `:` ⇒ a name on this machine.
 */
export const HOST_TAG_SEP = "@";

/**
 * Qualify a notification slot with the host that owns it. `host === undefined` (solo, or the lead's
 * own pane) returns the base UNTOUCHED — the lead's `collie:herd` must not move when it grows a
 * crew, or every alert outstanding on the phone at `collie join` time orphans into a slot nothing
 * will ever clear (`bridge/sessions.ts`'s reasoning, one dimension out).
 */
export const hostSlot = (base: string, host?: string): string =>
  host ? `${base}${HOST_TAG_SEP}${host}` : base;

// Notifications share a slot so a replacement updates rather than stacks. The bridge sets the tag
// explicitly ("collie:herd" / "collie:herd@<host>"); we only fall back to a per-pane tag for
// direct/manual pushes — host-qualified the same way, so two machines' identical pane ids can never
// coalesce into one slot and silently replace each other's alert.
export const tagFor = (paneId?: string, host?: string): string => {
  const base = hostSlot("collie", host);
  return paneId ? `${base}:${paneId}` : base;
};

/**
 * What a retraction renders as on a push service that will not accept a silent one — see
 * {@link enforcesUserVisible}. Deliberately states the **absence**, not "handled": the slot can
 * empty because you answered at the desk, because the agent finished on its own, or because the pane
 * closed, and the notification must not claim to know which. Overridable by the payload, so a future
 * bridge can send better copy without a new service worker (`payload.title` wins below).
 */
export const ALL_CLEAR_TITLE = "Nothing needs you";

/**
 * Whether this push service revokes a subscription that receives a push and shows no notification.
 *
 * Apple's does. WebKit enforces the `userVisibleOnly: true` promise literally — **three push events
 * without a notification and the subscription is revoked** — and the revocation is silent, surfacing
 * only as 410s the next time the bridge tries to deliver. Chrome instead keeps a budget and
 * tolerates the occasional silent push, which is what the `clear` path below was written against.
 * <https://webkit.org/blog/12945/meet-web-push/>
 *
 * An endpoint we cannot read resolves to `true`, and that asymmetry is the whole point: a spurious
 * notification is a small, visible annoyance the operator can act on, while a revoked subscription
 * is permanent, silent, and only noticed the day an agent blocks and the phone stays dark.
 */
export function enforcesUserVisible(endpoint: string | null | undefined): boolean {
  if (!endpoint) return true;
  try {
    const { hostname } = new URL(endpoint);
    return hostname === "push.apple.com" || hostname.endsWith(".push.apple.com");
  } catch {
    return true;
  }
}

/**
 * Decide what the SW should do with a push. `hasVisibleClient` = a Collie tab is open and visible
 * (the in-app status already surfaces the alert, so the redundant system notification is suppressed
 * — but a clear still runs, since a retraction must close regardless).
 *
 * `mustShow` (from {@link enforcesUserVisible} on the live subscription) removes both silent
 * outcomes: a retraction becomes a quiet replacement in the same slot, and a suppression becomes the
 * alert itself. Both keep `renotify: false`, so satisfying the platform costs a line on the lock
 * screen and never a second buzz.
 */
export function decidePush(
  payload: PushPayload,
  hasVisibleClient: boolean,
  mustShow = false,
): PushDecision {
  const paneId = payload.data?.paneId;
  const session = payload.data?.session;
  const host = payload.data?.host;
  const target = payload.data?.target;
  // ONE derivation, both directions. A retraction that computed a different tag than its render did
  // would leave a dead notification on the lock screen forever, with nothing left that will ever
  // close it — so `clear` and `show` resolve the slot on this single line, before they diverge.
  const tag = payload.tag ?? tagFor(paneId, host);
  if (payload.type === "clear") {
    if (!mustShow) {
      const cleared: Extract<PushDecision, { kind: "clear" }> = { kind: "clear", tag };
      if (payload.badge !== undefined) cleared.badge = payload.badge;
      return cleared;
    }
    // Same tag, so this REPLACES the alert it retracts rather than stacking beside it — the slot
    // ends up saying the true thing instead of a stale "claude needs you". No `paneId`: the pane it
    // came from no longer wants anything, so the tap goes to the herd, not to a settled agent.
    const replaced: Extract<PushDecision, { kind: "show" }> = {
      kind: "show",
      title: payload.title ?? ALL_CLEAR_TITLE,
      body: payload.body ?? "",
      tag,
      session,
      host,
      target,
      renotify: false,
    };
    if (payload.badge !== undefined) replaced.badge = payload.badge;
    return replaced;
  }
  if (hasVisibleClient && !mustShow) return { kind: "suppress" };
  const shown: Extract<PushDecision, { kind: "show" }> = {
    kind: "show",
    title: payload.title ?? "Collie",
    body: payload.body ?? "",
    tag,
    paneId,
    session,
    host,
    target,
    // A notification raised only because the platform demands one must not also buzz: the operator
    // is looking at the app that already shows it.
    renotify: hasVisibleClient ? false : (payload.renotify ?? false),
  };
  // Both added only when present, so a payload without them decides to the exact object it always
  // did (the tests compare whole decisions).
  const agent = payload.data?.agent;
  if (agent !== undefined) shown.agent = agent;
  if (payload.badge !== undefined) shown.badge = payload.badge;
  const approve = approveSpec(payload.data?.approve);
  const actions = approve === undefined ? undefined : honouredActions(payload.actions, paneId);
  if (actions !== undefined) {
    shown.actions = actions;
    shown.approve = approve;
  }
  return shown;
}

/** A non-empty list of non-empty key names, or nothing. */
function keyList(v: string[] | undefined): string[] | undefined {
  return Array.isArray(v) && v.length > 0 && v.every((k) => k !== "") ? v.map(String) : undefined;
}

/**
 * The binding a Yes/No button needs, checked field by field: two non-empty key lists and a
 * non-empty region. Anything less voids the buttons — a button that could not be bound to the
 * dialog it answers must not be offered, because the bridge would (rightly) refuse the keys and
 * the tap would silently become "open the pane".
 */
export function approveSpec(raw: ApproveSpec | undefined): ApproveSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  const yes = keyList(raw.yes);
  const no = keyList(raw.no);
  const region = raw.region;
  if (yes === undefined || no === undefined || !region) return undefined;
  return { yes, no, region: String(region) };
}

/**
 * The buttons a payload earns: its own, when they are exactly a subset of the two this app can act
 * on and the notification names a pane to act on. Anything else — an unknown action, a third
 * button, no pane — is no buttons, so a tap can never promise what the handler cannot deliver.
 */
export function honouredActions(
  actions: PushActionSpec[] | undefined,
  paneId: string | undefined,
): PushActionSpec[] | undefined {
  if (!Array.isArray(actions) || actions.length === 0 || actions.length > 2 || !paneId) return undefined;
  const honoured: PushActionSpec[] = [];
  for (const a of actions) {
    // The payload is the bridge's own JSON, but a button is shown to a person, so each is checked
    // field by field rather than believed: an unknown action or a blank title voids the whole set.
    const action = a?.action;
    const title = a?.title;
    if (action === undefined || !KNOWN_ACTIONS.has(action) || !title) return undefined;
    honoured.push({ action, title: String(title) });
  }
  return honoured;
}

/**
 * The URL a notification tap opens — `/settings/updates` for an update alert, otherwise the agent's
 * pane scoped to the machine and session it actually lives on.
 *
 * The WIRE spelling stays `"settings"` (bridge/push.ts) while the destination moves, and that is
 * deliberate: an old cached service worker holds its own copy of this function, sends the tap to
 * `/settings` and lands the operator on a real page one row away from the one they wanted. Renaming
 * the field would have sent it to `/` instead. Same graceful degradation `host` documents below.
 *
 * **This is the app's own URL builder, not a second one.** The query comes from `lib/scope`'s
 * {@link scopeSearch}, so the string the service worker constructs is by construction the string the
 * router already produced for that scope — which is what keeps sw.ts's `client.url !== url` check
 * from firing a redundant navigate on every tap of an already-open pane. It also lives here, rather
 * than in sw.ts, so it is testable at all: sw.ts cannot be imported under Vitest.
 *
 * A SW predating the host field ignores `data.host` and opens the bare pane path, landing on the
 * lead — a reachable screen, and the same graceful degradation `target` already documents. That is
 * why the LEAD is the no-param default and not "the host you last looked at": degrading onto the
 * wrong machine's pane id is exactly the failure the host dimension exists to prevent.
 */
export function notificationPath(data: NotifData = {}): string {
  if (data.target === "settings") return "/settings/updates";
  const base = data.paneId && data.paneId !== "test" ? `/pane/${encodeURIComponent(data.paneId)}` : "/";
  return `${base}${scopeSearch({ host: data.host, session: data.session })}`;
}
