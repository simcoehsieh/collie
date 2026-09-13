import { useCallback, useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import {
  CheckCircle2,
  CloudOff,
  Loader2,
  LogIn,
  Plug,
  RefreshCw,
  RotateCw,
  TriangleAlert,
  WifiOff,
} from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Notice, NOTICE_ACTION, NOTICE_ACTION_TAP } from "@/components/ui/notice";
import { StripSlot } from "@/components/ui/strip-host";
import { AUTH, DEGRADED, OUTAGE } from "@/lib/strip-priority";
import { cn } from "@/lib/utils";
import { PROXY_AUTH_PATH } from "@/lib/sw-routes";
import { useConnectionLost, useConnectionTrouble } from "@/hooks/use-connection-lost";
import { useLoadingStalled } from "@/hooks/use-loading-stalled";
import { useOnline } from "@/hooks/use-online";
import { isConnecting } from "@/lib/connection";
import { clockTime } from "@/lib/format";
import * as api from "@/lib/api";
import { useServerBuild } from "@/lib/server-build";
import { setStatus } from "@/lib/status";
import type { BridgeStatus } from "@/lib/types";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

interface ConnectionBannerProps {
  /** Herdr link from the last snapshot (undefined before the first successful poll). */
  bridge: BridgeStatus | undefined;
  /** The last snapshot fetch failed (stale data on screen). */
  error: boolean;
  /** The failed snapshot request was rejected with HTTP 401 or 403. */
  authError: boolean;
  /**
   * When the data on screen was last actually fetched, if it can be dated (lib/last-seen.ts). Shown in
   * the RED copy only, where it is the fact the operator most needs: a cold boot with no network
   * re-renders the herd from cache, and an undated old screen is indistinguishable from a live one.
   */
  lastSeenAt?: number;
}

// FORK: the result of the /api/health probe (ungated; never touches Herdr), run only while RED, to
// name WHERE the connection is broken. "unknown" until it resolves; then lib/api.ts's four answers:
// `ok` = the bridge answered (so the herd link is what's down), `gateway` = the tunnel's edge
// answered FOR the bridge (it is down or restarting — the network is fine and it will be back),
// `auth` = the front door wants a sign-in, `down` = nothing answered at all.
type Probe = "unknown" | api.BridgeProbe;

// FORK: while the bridge is restarting the banner re-probes on its own, doubling from here to the
// cap, so the operator is not asked to tap Retry at a thing that is coming back by itself.
export const REPROBE_MIN_MS = 2_000;
export const REPROBE_MAX_MS = 30_000;

// The three color-coded states, plus null = nothing. green = established, amber = checking, red = failed.
type Tone = "amber" | "red" | "green";

// How long the "Connected" confirmation lingers after a visible bar recovers, then it exits.
//
// This one is BUSINESS LOGIC and stays here: how long a confirmation is worth reading is a fact
// about what the operator is being told, not about how a row leaves the screen. The exit itself was
// this file's own (`EXIT_MS`, a delayed unmount through a hand-rolled 0fr↔1fr grid) and is now the
// band's — `ui/strip-host.tsx` keeps painting the last strip while `ui/collapse.tsx` closes it, on
// one duration shared with everything else in the app that moves in flow.
export const GREEN_MS = 1_800;

// The ONE connection surface: a single, thin bar in the band above the header — `ui/strip-host.tsx`,
// registered from here as a StripSlot — that is the app's entire connection UI; the header pill is
// gone. It appears only on SUSTAINED trouble, escalates from amber → red on a real outage, flashes
// green on recovery, and otherwise renders nothing. It reads the SAME two shared-clock signals
// the header dog does (useConnectionTrouble at 4s, useConnectionLost at 15s), so bar and dog can never
// disagree; `connecting` is poll-truth (isConnecting) — navigator.onLine is COPY-only (it picks the
// red cause), never a gate. Threshold lockstep with the shared clock is proven in use-connection-lost;
// here we own the amber→red→green state machine and nothing else.
//
// ONE SLOT, THREE TONES, TWO RANKS. The tone changes inside the slot the way it always did, and the
// slot's PRIORITY moves with it: a lost connection is `OUTAGE`, trouble and the recovery flash are
// `DEGRADED` (`lib/strip-priority.ts`). Green is not a fifth level — it is this same fact, resolved,
// and it outranks the update offer for the second it stands for exactly the reason amber does.
export function ConnectionBanner({ bridge, error, authError, lastSeenAt }: ConnectionBannerProps) {
  useBridgeRestartNotice();
  if (authError) return <AuthErrorBanner />;
  return <ConnectionStateBanner bridge={bridge} error={error} lastSeenAt={lastSeenAt} />;
}

/**
 * FORK: say so when the bridge came back as a DIFFERENT build. Every poll carries the bridge's
 * build id; the first id seen is the baseline, and a later, different one means the process was
 * rebuilt and restarted under the phone — which is also the moment pane ids can change, since the
 * multiplexer's are only stable within one bridge's life. A one-line event, on the same channel
 * every other "what just happened" uses. A restart on the SAME build is invisible here, which is
 * honest: the id is the only fact the poll carries.
 */
function useBridgeRestartNotice(): void {
  const build = useServerBuild();
  const seen = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (build === undefined || build === "unknown") return;
    if (seen.current === undefined) {
      seen.current = build;
      return;
    }
    if (seen.current === build) return;
    seen.current = build;
    setStatus(t("connection.restarted"), "info");
  }, [build]);
}

// A refusal is not an outage, so it gets its own surface ahead of the connection state machine: no
// probe, no reconnect spinner, no escalation clock. The copy stays deliberately non-specific about
// the cause. The flag covers 401 and 403 alike, and a 403 can equally mean "this device is not
// allowlisted", "host not allowed" or "cross-origin rejected", so naming any one of them would be
// wrong more often than right. What the operator needs here is the one fact the old behaviour hid:
// this is not the network.
//
// Reload alone is NOT enough to reach a fronting proxy, which is what this banner used to claim. In
// an installed PWA the service worker answers every navigation it owns — a reload included — from
// the precached app shell, so a reload re-renders the same refused UI and never touches the proxy.
// "Sign in" is the escape: a real navigation to the one path the SW always passes to the network
// (lib/sw-routes). An <a>, not a button, so it is an ordinary navigation the SW sees as such — and
// so it still works if React is wedged. Reload stays alongside it, since a merely stale session on
// an already-signed-in device recovers without leaving the app.
function AuthErrorBanner() {
  useLocale();
  return (
    // The loudest fact this app has, so it takes the band from anything else that wants it. One
    // announcement, not two: `announce="alert"` emits `role="alert"` and NOTHING beside it — the
    // `aria-live="polite"` that used to sit next to that role asked for assertive and polite at
    // once, which is the contradiction `ui/notice.tsx` exists to make unwritable.
    <StripSlot priority={AUTH}>
      <Notice
        tone="danger"
        variant="strip"
        announce="alert"
        icon={<TriangleAlert />}
        action={
          <>
            {/* An <a>, not a button, so it is an ordinary navigation the service worker sees as
                such — see this component's header for why a reload alone cannot reach the proxy. */}
            <a
              href={PROXY_AUTH_PATH}
              className={cn(
                buttonVariants({ size: "sm" }),
                "h-6 gap-1 px-2 text-xs no-underline",
                NOTICE_ACTION_TAP,
              )}
            >
              <LogIn className="size-3.5" />
              {t("connection.auth.signIn")}
            </a>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("connection.reload.aria")}
              className={cn("size-6 text-muted-foreground", NOTICE_ACTION_TAP)}
              onClick={() => window.location.reload()}
            >
              <RefreshCw className="size-3.5" />
            </Button>
          </>
        }
      >
        {t("connection.auth.message")}
      </Notice>
    </StripSlot>
  );
}

function ConnectionStateBanner({
  bridge,
  error,
  lastSeenAt,
}: Omit<ConnectionBannerProps, "authError">) {
  useLocale();
  const stalled = useLoadingStalled();
  const connecting = isConnecting({ bridge, error, stalled });
  const trouble = useConnectionTrouble(connecting);
  const lost = useConnectionLost(connecting);

  // What the live signals want on screen right now — red wins over amber; null = healthy (or a blip
  // that never reached trouble). Green is NOT derived here: it's a timed confirmation the state machine
  // adds only when a VISIBLE bar recovers, so it can't come from the instantaneous signals.
  const activeTone: Exclude<Tone, "green"> | null = lost ? "red" : trouble ? "amber" : null;

  // The rendered tone. Adds the recovery "connected" flash on top of the live signals.
  const [tone, setTone] = useState<Tone | null>(null);
  // Has an amber/red bar actually been shown since the last time we went hidden? Gates the green flash
  // so a sub-trouble blip (which never showed a bar) recovers silently.
  const shownBar = useRef(false);

  useEffect(() => {
    if (activeTone) {
      shownBar.current = true;
      setTone(activeTone);
      return;
    }
    // activeTone === null → recovered, or never troubled.
    if (!shownBar.current) {
      setTone(null); // a blip that never showed a bar → show nothing.
      return;
    }
    // Recovery FROM a visible bar → a brief green "connected", then hide.
    shownBar.current = false;
    setTone("green");
    const id = window.setTimeout(() => setTone(null), GREEN_MS);
    return () => clearTimeout(id);
  }, [activeTone]);

  // NO EXIT MACHINERY HERE ANY MORE. This component used to run its own delayed unmount, its own
  // 0fr↔1fr grid and its own `shownToneRef` ghost so the row could animate out with its copy
  // intact. All three are the band's now: `ui/collapse.tsx` holds the last non-empty children for
  // the whole exit and `ui/strip-host.tsx` keeps painting the last strip while the band closes. Two
  // collapse mechanisms on one row would fight — this one would unmount the slot before the band
  // had finished closing over it — so what is left here is the state machine and nothing else:
  // there is a tone, or there is no slot.
  //
  // Probe /api/config only while RED, to tell "bridge unreachable" from "bridge up, Herdr down". Amber
  // (ambient) and green (a success flash) never probe. Reset when we leave red so a later outage re-probes.
  const online = useOnline();
  const revalidator = useRevalidator();
  const [probe, setProbe] = useState<Probe>("unknown");
  const [retrying, setRetrying] = useState(false);

  const runProbe = useCallback(async (): Promise<Probe> => {
    const result = await api.probeBridge();
    setProbe(result);
    return result;
  }, []);

  useEffect(() => {
    if (!lost) {
      setProbe("unknown");
      return;
    }
    // FORK: probe, and while the answer is "the bridge is coming back" keep probing on a doubling
    // timer; the moment it answers, revalidate so the red row clears on the very next tick rather
    // than at the poller's own leisure.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delay = REPROBE_MIN_MS;
    const tick = async () => {
      const result = await runProbe();
      if (cancelled) return;
      if (result === "ok") {
        revalidator.revalidate();
        return;
      }
      if (result !== "gateway") return;
      timer = setTimeout(() => void tick(), delay);
      delay = Math.min(delay * 2, REPROBE_MAX_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
    // `revalidator` is a new object every render; its `revalidate` is what is wanted and is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lost, runProbe]);

  if (tone === null) return null;

  // Recovery (a successful poll) flips the signals → tone → hidden on its own, no reload. Retry just
  // nudges that along: revalidate the snapshot and re-run the probe.
  async function onRetry() {
    setRetrying(true);
    revalidator.revalidate();
    await runProbe();
    setRetrying(false);
  }

  const view = resolveView(tone, online, probe, lastSeenAt);
  // FORK: a restarting bridge gets no Retry — it is coming back on its own and the banner is already
  // asking after it; a spinner says so. A sign-in problem gets the link that fixes it instead.
  const restarting = tone === "red" && probe === "gateway";
  const needsSignIn = tone === "red" && probe === "auth";

  return (
    // A lost connection outranks trouble, and both outrank the update offer. Green rides at
    // DEGRADED with amber: it is the same fact resolved, not a level of its own.
    <StripSlot priority={tone === "red" ? OUTAGE : DEGRADED}>
      <Notice
        tone={view.tone}
        variant="strip"
        // Red is an actionable error (assertive); amber and green are ambient. One attribute either
        // way — the `aria-live="polite"` that used to sit beside the role is gone, and cannot come
        // back: `ui/notice.tsx` has no way to spell a role and a liveness at the same time.
        announce={tone === "red" ? "alert" : "status"}
        icon={restarting ? <Loader2 className="animate-spin" /> : <view.Icon />}
        // Actions only in red — amber is ambient (no buttons), green is a passing confirmation.
        // FORK: a sign-in problem gets the link, and a restarting bridge gets nothing to tap.
        action={
          needsSignIn ? (
            <a
              href={PROXY_AUTH_PATH}
              className={cn(buttonVariants({ size: "sm" }), NOTICE_ACTION, "no-underline")}
            >
              <LogIn className="size-3.5" />
              {t("connection.signInAgain")}
            </a>
          ) : tone === "red" && !restarting ? (
            <>
              <Button
                size="sm"
                className={NOTICE_ACTION}
                onClick={onRetry}
                disabled={retrying}
              >
                {retrying ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RotateCw className="size-3.5" />
                )}
                {t("connection.retry")}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("connection.reload.aria")}
                className={cn("size-6 text-muted-foreground", NOTICE_ACTION_TAP)}
                onClick={() => window.location.reload()}
              >
                <RefreshCw className="size-3.5" />
              </Button>
            </>
          ) : undefined
        }
      >
        {view.copy}
      </Notice>
    </StripSlot>
  );
}

// Copy + tone + icon per state. Green/amber are fixed; red names the cause — the bridge answering means
// Herdr is the outage, otherwise onLine decides between a true offline drop and an unreachable Collie.
//
// Red also DATES what's on screen when it can ("… — last seen 14:32"). That matters most in the case
// this whole path exists for: a PWA the browser discarded, reopened with the tunnel still down, has a
// full herd on screen rendered from cache. Without the stamp it looks live. The cause wording is kept
// rather than replaced by a flat "Disconnected", because "Herdr is down on the host" is a different
// (and more actionable) fact than "we can't reach Collie", and both can be undated or dated.
//
// The three tones are `ui/notice.tsx`'s and name the SAME three tokens this file used to mix for
// itself: `success` is `--status-done`, `caution` is `--status-working`, `danger` is
// `--status-blocked`. Nothing here changed colour; the recipe moved to the one table allowed to
// hold it, which is what stops the next banner drifting an alpha.
function resolveView(tone: Tone, online: boolean, probe: Probe, lastSeenAt?: number) {
  if (tone === "green") {
    return { copy: t("connection.connected"), Icon: CheckCircle2, tone: "success" } as const;
  }
  if (tone === "amber") {
    // Static Plug (no spinner) — the galloping dog carries the motion, and a spinner would fight
    // prefers-reduced-motion. Ambient by design.
    return { copy: t("connection.reconnecting"), Icon: Plug, tone: "caution" } as const;
  }
  // FORK: four causes from one probe. `ok` = the bridge is up, so Herdr is the outage; `gateway` =
  // the tunnel reached the origin's door and found nobody home, so the bridge is restarting;
  // `auth` = the front door wants a sign-in; `down` = nothing answered — offline if the phone says
  // so, otherwise the tunnel. Before the probe answers, the generic line.
  const cause =
    probe === "ok"
      ? { copy: t("connection.herdrDown"), Icon: TriangleAlert }
      : probe === "gateway"
        ? { copy: t("connection.bridgeRestarting"), Icon: Loader2 }
        : probe === "auth"
          ? { copy: t("connection.auth.message"), Icon: LogIn }
          : probe === "down" && !online
            ? { copy: t("connection.offlineCantReach"), Icon: WifiOff }
            : probe === "down"
              ? { copy: t("connection.tunnelDown"), Icon: CloudOff }
              : { copy: t("connection.cantReach"), Icon: TriangleAlert };
  const copy =
    lastSeenAt === undefined
      ? cause.copy
      : t("connection.withLastSeen", { cause: cause.copy, time: clockTime(lastSeenAt) });
  return { copy, Icon: cause.Icon, tone: "danger" } as const;
}
