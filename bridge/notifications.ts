import type { BinaryPromptPeek } from "./prompt-peek.ts";
import { YES_NO_ACTIONS, type PushMessage } from "./push.ts";
import type { ReplyLine } from "./reply-peek.ts";
import type { AgentStatus, AgentView } from "./types.ts";

// A notification shouldn't be fire-and-forget. This coordinator gives every blocked/done alert a
// lifecycle and collapses the herd into a single, always-accurate notification:
//
//   • Debounce + cancel — an agent that blocks and unblocks within the window (you handled it at your
//     desk) never reaches your phone. Herdr exposes no "user present" signal (only a `focused` pane,
//     no activity timestamp), so we infer presence: a quickly-resolved transition is an at-desk one.
//   • Coalesce — instead of N stacked notifications, we keep ONE summary of everything currently
//     outstanding: the named agent when exactly one needs you, or "N agents need you" for several.
//     Each change re-renders that single summary; when the last one resolves, we clear it.
//   • Retract — clearing an agent at the PC (or its pane closing) updates or removes the summary, so
//     handled work never lingers on your lock screen.
//
// Pure and clock-injected so `bun test` drives it without real timers: the bridge passes
// setTimeout/clearTimeout (see server.ts); tests pass a fake clock they fire on demand.

type NotifiableStatus = "blocked" | "done";

/** The timer primitive the coordinator schedules against — real setTimeout in the bridge, fake in tests. */
export interface NotifyClock<H> {
  schedule(fn: () => void, delayMs: number): H;
  cancel(handle: H): void;
}

/** The current state of the herd's single notification, derived from everything outstanding. */
export interface HerdSummary {
  /** Headline: "claude needs you" for one, or "3 agents need you" for several. */
  title: string;
  /** Sub-line: "demo · /path" for one outstanding alert, or the agent names for a digest. */
  body: string;
  /**
   * FORK: the part of `body` that survives when the sink has something better for the rest.
   *
   * `body` is "<space> · <cwd>" for a single alert, and a `done` push can carry the agent's own
   * opening line instead of that path (see {@link ReplyPeek}) — but the SPACE still has to be there,
   * or two panes of the same agent produce two identical notifications. So the summary names the
   * half it wants kept rather than making the sink parse its own string back apart. Present exactly
   * when {@link paneId} is; a digest has no single space to name.
   */
  bodyLead?: string;
  /** Deep-link target when exactly one alert is outstanding; undefined for a multi-agent digest. */
  paneId?: string;
  /** The one outstanding pane's agent and status — present exactly when `paneId` is. The sink needs
   *  both to decide whether the notification earns Yes/No buttons (see {@link makeNotifySink}). */
  agent?: string;
  status?: NotifiableStatus;
  /** Re-alert (buzz) the device — true when a new alert arrived, false on a silent retraction update. */
  renotify: boolean;
  /** FORK: how many alerts the summary stands for — the app icon's badge. */
  count?: number;
}

export interface NotifySink {
  /** Render (or replace) the herd's single notification. */
  render(summary: HerdSummary): void;
  /** Close the herd notification — nothing is outstanding any more. */
  clear(): void;
}

/** Just the transport the sink needs — "deliver this message to the devices". */
export interface PushSender {
  send(msg: PushMessage): void;
}
/** Just the quiet-hours check the sink needs — "are we muted right now?". */
export interface MuteGate {
  isMuted(): boolean;
}

/**
 * Whether the pane's tail is a dialog a plain Yes or No answers — bridge/prompt-peek.ts over a fresh
 * read of the pane. The sink asks it ONLY for a single outstanding `blocked` alert, so a digest, a
 * done alert and a retraction never touch the multiplexer. A rejection or a throw reads as "no".
 */
export type PromptPeek = (paneId: string) => Promise<BinaryPromptPeek | null>;

/**
 * FORK: the opening line of the agent's newest message, for a `done` push — bridge/reply-peek.ts over
 * the pane's own session log.
 *
 * Asked ONLY for a single outstanding `done` alert, i.e. after the debounce has decided the alert is
 * real and after the notify prefs (bridge-wide switches AND the per-pane rule) have decided it may
 * fire at all — the coordinator owns that gate and this never second-guesses it. A digest, a blocked
 * alert and a retraction never touch the journal. A rejection or a throw reads as "no line".
 */
export type ReplyPeek = (paneId: string) => Promise<ReplyLine | null>;

/**
 * Who the alerts flowing through a sink belong to — the `(host, session)` half of the address triple
 * (CREW_PROTOCOL.md §4). **Both halves are omitted-not-null**, and for the same reason: a stamped
 * field that is absent for the default case keeps that payload byte-identical to the shape an
 * already-installed service worker was built against.
 */
export interface NotifyIdentity {
  /** Herdr session (registry name). Absent for the primary — §11's push-payload row. */
  readonly session?: string;
  /** Crew member owning the session. Absent for this collie, so a solo payload gains nothing (§11). */
  readonly host?: string;
}

/**
 * Build the {@link NotifySink} the coordinator drives. One session's whole herd shares one
 * notification slot (`herdTag`), so a render replaces rather than stacks; an active snooze mutes both
 * render and clear (nothing is shown, so there's nothing to close). {@link NotifyIdentity} is stamped
 * into the push payload so the service worker can deep-link to the right `(host, session)` — omit
 * either half for "here"/"primary", keeping that payload byte-identical to the case that predates the
 * dimension. Kept here, decoupled from `Push`/`Snooze`, so the gating + summary→message mapping is
 * unit-testable.
 *
 * A peer's summary also NAMES its host in the body. Per-host slots mean two machines' alerts never
 * overwrite each other, but they also mean the text is the only thing that says *which machine* —
 * and "claude needs you" is identical on every host in the crew.
 */
export function makeNotifySink(
  push: PushSender,
  mute: MuteGate,
  herdTag: string,
  ident: NotifyIdentity = {},
  peek?: PromptPeek,
  replyPeek?: ReplyPeek,
): NotifySink {
  const { session: sessionName, host } = ident;
  /** One body, with the host prefix the crew case needs. The only place either is composed. */
  const withHost = (body: string) => (host === undefined ? body : `${host} · ${body}`);
  // FORK: the assistant turn each pane's last `done` push carried. A `done` that arrives with the
  // SAME turn is a status that flapped (`done` → `idle` → `done`, which Herdr's seen-tracking can
  // produce while the phone is looking at the pane), not a new completion — and the operator was
  // already told. One entry per pane, replaced by the next real turn; a pane that vanishes leaves a
  // string behind, which is nothing.
  const pushedTurn = new Map<string, string>();
  return {
    render: (s) => {
      if (mute.isMuted()) return;
      const msg: PushMessage = {
        title: s.title,
        body: withHost(s.body),
        tag: herdTag,
        paneId: s.paneId,
        renotify: s.renotify,
      };
      if (s.count !== undefined) msg.badge = s.count;
      if (sessionName !== undefined) msg.session = sessionName;
      if (host !== undefined) msg.host = host;
      if (s.agent !== undefined) msg.agent = s.agent;
      // A single blocked pane may earn Yes/No buttons — but only after a look at its tail, which is
      // a multiplexer round trip. Everything else sends on the spot, exactly as before: a caller
      // without a peek gets the synchronous path it always had.
      if (peek !== undefined && s.paneId !== undefined && s.status === "blocked") {
        const paneId = s.paneId;
        void (async () => {
          let approve: BinaryPromptPeek | null = null;
          try {
            approve = await peek(paneId);
          } catch {
            approve = null;
          }
          if (approve !== null) {
            msg.actions = YES_NO_ACTIONS;
            msg.approve = approve;
          }
          void push.send(msg);
        })();
        return;
      }
      // FORK: a single DONE pane says what it said. One journal read, on the same shape as the
      // blocked branch above — and on exactly the same terms: THE PUSH ALWAYS GOES OUT. A missing
      // line, a refused read or a throw leaves the body the address it already was, because "every
      // push must still show a notification" is a promise about the service worker having something
      // to show, and a body is not a reason to withhold one.
      if (replyPeek !== undefined && s.paneId !== undefined && s.status === "done") {
        const paneId = s.paneId;
        void (async () => {
          let peeked: ReplyLine | null = null;
          try {
            peeked = await replyPeek(paneId);
          } catch {
            peeked = null;
          }
          // FORK: the same turn is pushed once. Decided only when the journal named a turn — a pane
          // with no readable log keeps the old contract, every push goes out.
          if (peeked !== null) {
            if (pushedTurn.get(paneId) === peeked.turn) return;
            pushedTurn.set(paneId, peeked.turn);
          }
          const line = peeked?.text ?? null;
          // FORK: when the agent's own line is there, the notification IS that line. The headline
          // becomes the pane's address ("AI Live · claude") and the verb goes — "claude is done"
          // above "AI Live · <what it said>" said nothing the line did not (2026-09-11). An EMPTY
          // title was tried and is worse: iOS fills it with the app's name, so the phone read
          // "Meow / from Meow / <line>". The title line is the platform's to draw, and so is the
          // "from Meow" beneath it; what is ours is the words, and the pane's address is the most
          // useful short thing to put there — it is what tells two panes of the same agent apart.
          // Without a line the old shape stands: the verb is then the only information there is.
          if (line !== null && s.bodyLead !== undefined) {
            msg.title = s.agent === undefined ? s.bodyLead : `${s.bodyLead} · ${s.agent}`;
            msg.body = withHost(line);
          } else if (line !== null) msg.body = withHost(line);
          void push.send(msg);
        })();
        return;
      }
      void push.send(msg);
    },
    clear: () => {
      if (mute.isMuted()) return;
      // FORK: `badge: 0` — nothing is outstanding, so the icon's dot goes with the notification.
      void push.send({ type: "clear", tag: herdTag, badge: 0 });
    },
  };
}

interface Alert {
  agent: string;
  workspaceLabel: string;
  cwd: string;
  status: NotifiableStatus;
  /** The pane as it was when the alert armed — what a per-pane rule is matched against on a prefs
   *  change (bridge/notify-prefs.ts `ruleFor`), since the coordinator never re-reads the herd. */
  pane: AgentView;
}

export class NotificationCoordinator<H = unknown> {
  /** paneId → debouncing alert (timer + its kind) that hasn't entered the summary yet. */
  private readonly pending = new Map<string, { handle: H; status: NotifiableStatus; pane: AgentView }>();
  /** paneId → alert that has fired and is reflected in the current summary (insertion-ordered). */
  private readonly outstanding = new Map<string, Alert>();

  constructor(
    private readonly clock: NotifyClock<H>,
    private readonly sink: NotifySink,
    private readonly delayMs: number,
    // Whether a transition into a status should notify, read live from the prefs store so a runtime
    // change is honoured. A disabled kind behaves exactly like a non-notifiable status (idle/working).
    // The pane rides along so a per-pane rule can answer; a caller that ignores it gets the switches.
    private readonly isNotifiable: (status: AgentStatus, pane: AgentView) => boolean,
  ) {}

  /** Wire to `StateEngine.onTransition`. */
  onTransition(agent: AgentView, _from: AgentStatus, to: AgentStatus): void {
    const id = agent.paneId;
    if (!this.isNotifiable(to, agent)) {
      // Resolved to a non-notifiable (or preference-disabled) state: drop a still-pending alert,
      // retract a delivered one.
      this.resolve(id);
      return;
    }
    // (Re)arm the debounce. A blocked→done flip lands here too, so only the latest verb survives.
    this.cancelPending(id);
    const alert: Alert = {
      agent: agent.agent,
      workspaceLabel: agent.workspaceLabel,
      cwd: agent.cwd,
      // SAFETY: `onTransition` is only reached for a status the prefs call notifiable, and the
      // notifiable set IS `NotifiableStatus` (blocked/done) — `isNotifiable` returns false for
      // every other member of `AgentStatus`, so this branch cannot be entered with one.
      status: to as NotifiableStatus,
      pane: agent,
    };
    const handle = this.clock.schedule(() => {
      this.pending.delete(id);
      this.outstanding.set(id, alert);
      this.emit(true);
    }, this.delayMs);
    this.pending.set(id, { handle, status: alert.status, pane: agent });
  }

  /** Wire to `StateEngine.onRemove` — a vanished pane is implicitly resolved. */
  onRemove(paneId: string): void {
    this.resolve(paneId);
  }

  /**
   * Re-evaluate every pending + outstanding alert against the current prefs after they change,
   * dropping any whose kind is now disabled: cancel a still-debouncing timer, retract a delivered
   * alert. Retractions re-emit the shrunk summary (or a clear) once, silently. Call after the prefs
   * store is updated (see the /api/notifications/prefs route).
   */
  applyPrefs(): void {
    // Drop pending timers for a now-disabled kind — nothing was shown yet, so no re-emit is needed.
    for (const [id, p] of this.pending) {
      if (!this.isNotifiable(p.status, p.pane)) this.cancelPending(id);
    }
    // Retract delivered alerts of a now-disabled kind; re-emit the shrunk summary once if any went.
    let removed = false;
    for (const [id, a] of this.outstanding) {
      if (!this.isNotifiable(a.status, a.pane)) {
        this.outstanding.delete(id);
        removed = true;
      }
    }
    if (removed) this.emit(false);
  }

  /**
   * Tear down this session's notifications: cancel every pending timer and retract everything
   * outstanding, closing the herd slot. Called when a session is disposed (its socket vanished) so
   * its alerts never linger on the lock screen with no live session behind them.
   */
  clearAll(): void {
    for (const id of this.pending.keys()) this.cancelPending(id);
    const had = this.outstanding.size > 0;
    this.outstanding.clear();
    if (had) this.sink.clear();
  }

  private resolve(id: string): void {
    this.cancelPending(id);
    if (this.outstanding.delete(id)) this.emit(false);
  }

  /** Re-render the single herd summary from whatever's outstanding (or clear it when empty). */
  private emit(renotify: boolean): void {
    if (this.outstanding.size === 0) {
      this.sink.clear();
      return;
    }
    this.sink.render(this.summarize(renotify));
  }

  private summarize(renotify: boolean): HerdSummary {
    const entries = [...this.outstanding.entries()];
    if (entries.length === 1) {
      const [paneId, a] = entries[0]!;
      const verb = a.status === "blocked" ? "needs you" : "is done";
      // One outstanding agent → deep-link straight to its pane on tap.
      return {
        title: `${a.agent} ${verb}`,
        body: `${a.workspaceLabel} · ${a.cwd}`,
        // FORK: the half that survives when the sink has the agent's own line for the rest.
        bodyLead: a.workspaceLabel,
        paneId,
        agent: a.agent,
        status: a.status,
        renotify,
        count: 1,
      };
    }
    const alerts = entries.map(([, a]) => a);
    const n = alerts.length;
    const allBlocked = alerts.every((a) => a.status === "blocked");
    const allDone = alerts.every((a) => a.status === "done");
    const title = allBlocked
      ? `${n} agents need you`
      : allDone
        ? `${n} agents done`
        : `${n} agents need attention`;
    return { title, body: alerts.map((a) => a.agent).join(", "), renotify, count: n };
  }

  private cancelPending(id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.clock.cancel(p.handle);
    this.pending.delete(id);
  }
}
