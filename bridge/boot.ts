// FORK: the cold boot, as ONE round trip.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────────
// Opening the app from cold was a four-deep SERIAL waterfall, and every step of it crossed a tunnel
// and an identity proxy at ~175 ms warm, ~560 ms on a cold connection:
//
//   1. `GET /api/snapshot`, alone, behind the boot splash (`rootLoader`);
//   2. only once it resolves does `RootLayout` mount, and only then do
//   3. `GET /api/config` ×3 (push setup, the operator's rows, the build stamp), `GET /api/launchers`
//      and `POST /api/subscribe` fire, and
//   4. `GET /api/quota` once the config reveals the usage card is on.
//
// Measured 2026-09-11: the bridge answers each of those in ~0.3 ms. Every one of the five or six
// round trips is wire, and three of them are the same body. There is nothing to make faster on this
// side — there are only round trips to not take.
//
// So this route answers all of them at once, and the client seeds the caches those endpoints
// already have with what it carries (`primeBoot` in web/src/lib/api.ts). After that first answer the
// page polls the SAME routes it always polled: nothing here replaces an endpoint, the service
// worker's `/api/*` denylist is untouched, and a bridge too old to serve this simply 404s and the
// client falls back to the snapshot it always fetched.
//
// ── WHY THE ASSEMBLY LIVES HERE AND NOT IN server.ts ───────────────────────────
// FORK.md's merge map: the route registration in server.ts is a contested hunk, so what goes into
// server.ts is one gate, one call and one response — and everything that decides the SHAPE of the
// body sits in a file upstream has nothing to conflict with. It is also what makes the shape
// testable: the handler lives inside `Bun.serve`, which `bun test` cannot stand up (CLAUDE.md), and
// these functions are pure.

import { computeEtag } from "./http-cache.ts";
import type { NotifyPrefs } from "./notify-prefs.ts";
import type { BridgeConfig, LaunchersResponse, QuotaResponse, SnapshotResponse } from "./types.ts";

/**
 * The ETag `/api/snapshot` answers for a body — the ONE expression, so the snapshot route, the live
 * feed's fingerprint and this route cannot drift into three different tags for the same bytes.
 *
 * `ts` is zeroed because it is stamped per call and would otherwise make every body unique; the
 * client learns the time from the body it gets, and a 304 tells it nothing it needed.
 */
export function snapshotEtagOf(body: SnapshotResponse): string {
  return computeEtag(JSON.stringify({ ...body, ts: 0 }));
}

/** What `GET /api/boot` answers. Every field is exactly the body of the route that owns it. */
export interface BootBody {
  /** `GET /api/snapshot` */
  snapshot: SnapshotResponse;
  /**
   * The tag that names {@link snapshot}, so the client can seed its snapshot ETag map and have its
   * very first POLL be a 304 instead of a second full body.
   *
   * A FIELD, not the response's own `ETag` header, and that is deliberate. This body is four
   * documents; an HTTP validator names ONE entity, and a client that sent `If-None-Match` on this
   * route with the snapshot's tag would be asking "is the whole bundle unchanged?" and could be told
   * yes while the config had moved. A conditional GET on `/api/boot` is therefore not offered at
   * all, and the tag rides inside the body where it can only mean what it says.
   */
  snapshotEtag: string;
  /** `GET /api/config` */
  config: BridgeConfig;
  /** `GET /api/launchers` */
  launchers: LaunchersResponse;
  /** `GET /api/notifications/prefs` */
  notifyPrefs: NotifyPrefs;
  /**
   * `GET /api/quota`, and ONLY when the config says the card is on.
   *
   * The gate is read off `config.quota` rather than asked separately, so this route cannot disagree
   * with the answer the client is about to act on: `bridgeConfigBody` publishes `quota: true` iff a
   * source is configured, and `/api/quota` 404s iff it is not. Absent here means the card is off,
   * or the command failed — the client then does what it does today and asks the route itself.
   */
  quota?: QuotaResponse;
  /** The tag that names {@link quota}, so its own one-entry ETag cache is seeded too. */
  quotaEtag?: string;
}

/** The already-resolved parts, handed in by the route. */
export interface BootParts {
  snapshot: SnapshotResponse;
  config: BridgeConfig;
  launchers: LaunchersResponse;
  notifyPrefs: NotifyPrefs;
  /** The serialised quota body and its tag, or null — see {@link BootBody.quota}. */
  quota: { body: string; etag: string } | null;
}

/**
 * Assemble the boot body. Pure.
 *
 * The quota arrives SERIALISED, because that is the shape its source caches (`QuotaBody`) and the
 * shape `/api/quota` sends. It is parsed here rather than spliced: a JSON string cannot be nested
 * inside a JSON body without either double-encoding it (which every client would then have to undo)
 * or hand-splicing the response text (which is a second serialiser to keep in step with the first).
 * A body that will not parse is dropped rather than thrown — the client asks `/api/quota` itself,
 * which is what it does on every other refusal.
 */
export function bootBody(parts: BootParts): BootBody {
  const body: BootBody = {
    snapshot: parts.snapshot,
    snapshotEtag: snapshotEtagOf(parts.snapshot),
    config: parts.config,
    launchers: parts.launchers,
    notifyPrefs: parts.notifyPrefs,
  };
  // Assigned, never conditionally spread: "no quota" must leave the keys OFF entirely rather than
  // send two undefined ones (CREW_PROTOCOL.md §11's rule, and the client reads absence as "ask").
  if (parts.quota !== null && parts.config.quota === true) {
    const parsed = parseQuota(parts.quota.body);
    if (parsed !== null) {
      body.quota = parsed;
      body.quotaEtag = parts.quota.etag;
    }
  }
  return body;
}

function parseQuota(serialised: string): QuotaResponse | null {
  try {
    // SAFETY: this string is `bridge/quota.ts`'s own `JSON.stringify(normaliseQuota(...))`, i.e. a
    // `QuotaResponse` by construction — never operator text and never a client's. `ok: true` is the
    // discriminant that file always writes, so it is what is checked rather than the shape's type.
    const value = JSON.parse(serialised) as QuotaResponse | null;
    return value?.ok === true ? value : null;
  } catch {
    return null;
  }
}
