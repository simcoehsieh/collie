import { apiErrorStatus } from "./api";

// FORK: which failures of a send are the LINK's and not the pane's.
//
// A send that the bridge refused is an answer — the pane is not ready, the device is not paired,
// the prompt moved — and the operator reads it and acts. A send that never reached the bridge, or
// reached a tunnel edge with nobody behind it, is not an answer about the pane at all: the words
// are still good and the only thing wrong is the moment. Those are the sends worth keeping to
// resend, and this is the one place that says which they are, so the guarded reply
// (lib/reply-action.ts) and the queue (lib/send-queue.ts) cannot disagree.

/**
 *  - `network` — nothing answered: the fetch failed, timed out, or was aborted by its deadline.
 *  - `auth`    — the front door wants a sign-in (a 401, or a redirect normalised to one). The
 *                Access session lapsed; the words are fine.
 *  - `server`  — the edge answered FOR the bridge (502/503/504, Cloudflare's 52x): it is down or
 *                restarting, and will be back.
 */
export type SendFailure = "network" | "auth" | "server";

/** The failure's kind, or null when it was a refusal the operator should read instead. */
export function classifySendFailure<TThrown>(e: TThrown): SendFailure | null {
  const status = apiErrorStatus(e);
  if (status !== undefined) {
    if (status === 401) return "auth";
    if (status === 502 || status === 503 || status === 504) return "server";
    if (status >= 520 && status <= 530) return "server";
    return null;
  }
  // `TypeError` is what `fetch` throws when the network is not there; the other two names are the
  // deadline (lib/api.ts) and a superseded request. A `DOMException` is NOT an `Error` in every
  // runtime (jsdom's is not), so it is asked for its name separately.
  const name = e instanceof Error || e instanceof DOMException ? e.name : null;
  if (name === "TypeError" || name === "TimeoutError" || name === "AbortError") return "network";
  return null;
}
