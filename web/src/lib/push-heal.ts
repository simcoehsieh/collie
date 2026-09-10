// The pure half of the service worker's push self-healing (sw.ts), split out so it runs under
// Vitest: what to re-subscribe WITH, what to tell the bridge, and what to tell the page.
//
// ── WHY A SUBSCRIPTION HAS TO HEAL ITSELF ────────────────────────────────────
// A push subscription dies in two ways the page never sees. The push service rotates or expires
// the endpoint (Apple does this; the browser fires `pushsubscriptionchange` in the service worker,
// where there is no page, no localStorage and no `lib/push.ts`). Or the bridge prunes it — the
// endpoint answered 404/410 to a send (bridge/push.ts) — and the page, which still holds the dead
// subscription, re-registers that same dead endpoint on every open, forever. Either way the phone
// goes dark the day an agent blocks, and nothing on any screen says so until Settings is opened.
//
// Both are answered here: the SW re-subscribes on the change event with the key it can recover,
// and the page treats "the bridge did not know the endpoint I believed it held" as the prune it is.

/** The `/api/subscribe` body — the bridge stores what it is sent, so the shape is a contract.
 *  `replaces` names the endpoint this one supersedes (bridge/push.ts `SubscriptionMeta`). */
export interface ResubscribeBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  replaces?: string;
}

/** What the bridge answers a registration with: whether the endpoint was already on file. */
export interface SubscribeAck {
  known: boolean;
}

/** `Notification.data`-style message the SW posts to open pages after it re-subscribed, so a page
 *  that is open can update the endpoint it remembers (lib/push.ts) without a reload. */
export const RESUBSCRIBED_MESSAGE = "PUSH_RESUBSCRIBED";
/** The page → SW message that hands the SW the VAPID public key to re-subscribe with, for the case
 *  where the change event carries no old subscription to read it off. */
export const VAPID_KEY_MESSAGE = "VAPID_KEY";

/** The header every same-origin API request carries (lib/api.ts `XHR_HEADER`); restated here so
 *  the service worker bundle does not pull the whole API client in for one string. Pinned equal
 *  in push-heal.test.ts. */
export const XHR_HEADER_NAME = "x-requested-with";
export const XHR_HEADER_VALUE = "XMLHttpRequest";

/** The subscribe body for a subscription minted to replace `previous`. Re-registering the same
 *  endpoint supersedes nothing, exactly as lib/push.ts's `subscribeBody` says. */
export function resubscribeBody(json: PushSubscriptionJSON, previous: string | null | undefined): ResubscribeBody {
  const endpoint = json.endpoint ?? "";
  const body: ResubscribeBody = {
    endpoint,
    keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
  };
  if (previous && previous !== endpoint) body.replaces = previous;
  return body;
}

/**
 * The application server key to re-subscribe with: the one the OLD subscription was bound to when
 * the event carries it, else the key the page handed the SW earlier (base64url), else nothing —
 * and nothing means no re-subscribe, because a subscription against the wrong key receives
 * nothing and looks exactly like a working one.
 */
export function serverKeyFor(
  oldKey: ArrayBuffer | null | undefined,
  storedKey: string | null | undefined,
): BufferSource | null {
  if (oldKey && oldKey.byteLength > 0) return oldKey;
  if (storedKey) return urlB64ToUint8Array(storedKey);
  return null;
}

/**
 * Whether the page must mint a FRESH subscription rather than keep the one it holds: it believed
 * this very endpoint was registered (it remembered it as acknowledged), it did not just subscribe
 * it in this same attempt, and the bridge answered that it had no such row. The only way all three
 * hold is a prune — the bridge dropped the endpoint because the push service disowned it — so the
 * subscription in hand is dead and re-registering it is what has been happening on every open.
 */
export function shouldMintFresh(
  ack: SubscribeAck | undefined,
  believedRegistered: boolean,
  justSubscribed: boolean,
): boolean {
  return ack !== undefined && ack.known === false && believedRegistered && !justSubscribed;
}

/** base64url → bytes, the shape `PushManager.subscribe` takes an application server key in. */
export function urlB64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
