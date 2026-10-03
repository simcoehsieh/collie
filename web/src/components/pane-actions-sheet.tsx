import { Children, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowRightLeft, BookOpen, Camera, ChevronDown, Copy, Ellipsis, FileCode2, FileDiff, Maximize2, MessagesSquare, Monitor, Pencil, Pin, PinOff, ScrollText, Search, Settings2, SlidersHorizontal, SquareTerminal, XCircle } from "lucide-react";

import { BottomSheet } from "@/components/ui/sheet";
import { Collapse } from "@/components/ui/collapse";
import { SectionLabel } from "@/components/ui/section-label";
import { ActionRow, DestructiveActionRow, RenameView } from "@/components/action-sheet-rows";
import { HostChip } from "@/components/host-chip";
import { useHostWriteBlock, useCrew } from "@/components/crew-provider";
import { useActionEcho } from "@/hooks/use-action-echo";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { useLocale } from "@/hooks/use-locale";
import * as api from "@/lib/api";
import { describeApiError, describeThrownError } from "@/lib/api-error-message";
import { t } from "@/lib/i18n";
import { tf } from "@/lib/i18n/fork-messages";
import { useMuxCapability, useMuxName } from "@/lib/mux-capability";
import { setStatus } from "@/lib/status";
import { stampTopology } from "@/lib/poll-intent";
import { paneName } from "@/lib/pane-name";
import { dropPin, pinMatcher, setPinned, usePins } from "@/lib/pins";
import type { PaneView } from "@/lib/pane-view";
import type { AgentView } from "@/lib/types";
import type { Scope } from "@/lib/scope";
import { cn } from "@/lib/utils";

interface PaneActionsSheetProps {
  open: boolean;
  onClose: () => void;
  /** The pane these actions target. Null while nothing is selected (sheet closed). */
  pane: AgentView | null;
  /** Session scope for the rename/close writes (undefined = primary). */
  scope?: Scope;
  /** This device isn't authorised to write — show a read-only note instead of the actions. */
  readOnly?: boolean;
  /** Fired after a successful rename so the parent can revalidate (the label lands on the next poll). */
  onRenamed: () => void;
  /** Fired after a successful close, with the closed pane id — the parent navigates Home if it's the
   *  pane currently open, or revalidates so it drops out of the list. */
  onClosed: (paneId: string) => void;

  /* The READ rows. All are optional and all are omitted by the pane strip, because they only
   * mean anything for the pane you are LOOKING AT: "find in output" searches the buffer this screen
   * has already fetched, and a strip pill can open this sheet on a pane whose output was never
   * loaded. The pane header passes them; the strip does not. Each is `undefined` when the caller has
   * nothing to offer (no buffered output yet; no agent session, so no transcript; a device that never
   * asked for zen), and a row with no callback is HIDDEN — the same "a sheet is a list of things you
   * can do" rule the capability gates below follow. The sheet closes itself before firing any of
   * them, so the surface a row leads to (the header's find bar, the history route, the bare mirror)
   * is the only thing on screen when it arrives. */

  /** Open find-in-output. The pane header's find bar takes over the header row. */
  onFind?: () => void;
  /** Open the agent's own transcript. */
  onHistory?: () => void;
  /** Copy the pane's buffered terminal output to the clipboard. The sheet closes and a status toast
   *  reports the result. Gated by the caller on there being output AND a usable clipboard (it is
   *  absent over plain HTTP, a supported deploy), so an unusable row is HIDDEN — the same "a row is a
   *  thing you can do" rule find/history/zen follow. */
  onCopyOutput?: () => void;
  /** Open this pane's own settings — today one switch, the prompt-cache warning (ADR 0042).
   *
   *  The FOURTH read row, and it is a read in the sense the other three are: it changes a preference on
   *  this collie and types into nothing. Absence is the gate, as it is for find, history and zen — the
   *  pane strip passes no callback, so a strip pill opens the sheet it always did. */
  onSettings?: () => void;
  /**
   * FORK: open the display prefs — wrap, font size, raw terminal, tap-to-focus.
   *
   * A READ row like the four around it: it changes how this phone draws the mirror and types into
   * nothing. It had a permanent pill on the actions belt until 2026-09-19; the operator's call was
   * that a control you settle once does not deserve a seat on the row the thumb uses every minute.
   * The dock it opens is the composer's, so the callback crosses through `ComposerHandle`.
   */
  onDisplay?: () => void;
  /**
   * WHICH BODY THE PANE DRAWS, and the one place that value is written (ADR 0071's shape).
   *
   * Absent is the gate, exactly as it is for find, history and zen: while `Settings → Experiments`
   * has Chat off, the pane view passes nothing and this sheet is byte-identical to 1.14's.
   *
   * It lives here rather than in the header or on the belt for three reasons. ADR 0009 makes a
   * generic menu the place a pane's actions live, and Find and History are already in it. 1.9.0
   * spent a whole milestone clearing chrome, so the header names the workspace alone and the belt
   * is already eight items on a small phone. And two taps is the right price for a choice made
   * rarely, which ONE STANDING PER-DEVICE VALUE makes it: there is no per-pane override, so this is
   * a thing you set, not a thing you flick.
   */
  paneView?: PaneView;
  /** Write the standing choice. Required alongside {@link paneView}; both or neither. */
  onPaneViewChange?: (view: PaneView) => void;
  /**
   * Why THIS pane keeps the terminal whatever the standing choice says — a pane with no session, a
   * machine one release behind, a multiplexer that keeps no session log at all.
   *
   * The row never hides on it. A control that disappears on some panes is how an operator concludes
   * the app is broken, and it would be worst for exactly the person whose standing mode is Chat:
   * their pane would open on the terminal with nothing saying why.
   */
  paneViewNote?: string;
  /** Enter zen mode — hide every Collie surface and leave the mirror alone on the screen.
   *
   *  The THIRD read row, and it is gated twice through this one prop: `Settings → Zen mode` decides
   *  whether this phone offers zen at all, and the pane header only passes a callback when there is
   *  buffered output to look at. Absence IS the gate, exactly as it is for find and history above —
   *  a device that never asked for zen sees a sheet byte-identical to today's. */
  onZen?: () => void;
  /** FORK: open the Changes sheet — what the agent changed in this pane's work tree (read-only). */
  onDiff?: () => void;
  /**
   * FORK: open annotate-and-ask for this pane. Absent when this bridge has no shot command
   * configured (`/api/config` → `shot`), and absent is the row not being drawn — the same
   * a-row-with-no-callback-is-hidden rule find, history and zen already ride.
   */
  onAnnotate?: () => void;
  /** FORK: open the knowledge-base browser. Absent when this bridge serves no documents. */
  onDocs?: () => void;
  /** FORK: the pane's artifacts sheet (components/artifact-sheet.tsx). Absent ⇒ no row. */
  onArtifacts?: () => void;
  /**
   * FORK: hand this pane's conversation to another harness (components/handoff-sheet.tsx). Absent
   * when nothing could take it — a shell, a read-only device, or no launcher row that starts a
   * harness other than this one — and absent is the row not being drawn.
   */
  onHandoff?: () => void;

  /**
   * Every pane the caller's list holds, agents and shells. The pins store reads it on a pin or unpin
   * to tell a live pin from a dormant one and to spot a reused pane id (lib/pins.ts). Omit and only
   * this pane counts as live.
   */
  herd?: readonly AgentView[];
  /**
   * After a pin or unpin, with the pane and its new state. The dashboard passes it, because the row
   * moves right there and is the answer (it scrolls the row into view and focuses it). Omit, as the
   * pane view does, and a success toast says it instead, because the outcome is on another screen.
   */
  onPinChange?: (pane: AgentView, pinned: boolean) => void;
}

const NO_HERD: readonly AgentView[] = [];

type Mode = "actions" | "rename";

// The actions for a single pane. THREE entry points, one sheet: long-pressing (or re-tapping) a pane
// pill in the strip, the ⋮ button in the pane header — which is why find, history and zen live
// here rather than in a second menu of their own — and a hold on a dashboard row (ADR 0070). The
// header used to spend two of its four slots on those two icons; the pane already had a menu, so they
// became rows in it.
// Rename (set/clear its label) and close (kill). Opens on an action-list view; rename is a second
// tap away so the sheet doesn't shove a keyboard-triggering input at you just to close a pane. The
// action rows + rename view are the SHARED pieces (action-sheet-rows) the tab sheet also uses, so the
// two stay identical. The label is user text rendered only into an <input> value / text node — never
// markup — so it stays within the pane-output XSS boundary. Both actions are writes, so under
// read-only they're replaced by a note.
export function PaneActionsSheet({
  open,
  onClose,
  pane,
  scope,
  readOnly = false,
  onRenamed,
  onClosed,
  onFind,
  onHistory,
  onCopyOutput,
  onSettings,
  onDisplay,
  onZen,
  onDiff,
  onAnnotate,
  onDocs,
  onArtifacts,
  onHandoff,
  paneView,
  onPaneViewChange,
  paneViewNote,
  herd = NO_HERD,
  onPinChange,
}: PaneActionsSheetProps) {
  useLocale();
  // Whether this pane is pinned on this device, read live from the store so the row's word is right
  // on every door (lib/pins.ts).
  const pins = usePins();
  const pinned = pane !== null && pinMatcher(pins)(pane);
  const [mode, setMode] = useState<Mode>("actions");
  // FORK: the "More" fold. It lives only as long as this opening of the sheet: every open starts
  // folded (the effect below resets it with the mode), so last week's expansion is never handed back.
  const [moreOpen, setMoreOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  // Close runs under the shared press echo (hooks/use-action-echo.ts) rather than a bare `closing`
  // boolean. The bare boolean acknowledged the tap with a spinner and NOTHING else; on success the
  // sheet slid away and the row itself did not disappear from the strip until the next poll landed
  // (up to ~1.5s later), so the gap between "I confirmed a kill" and any visible consequence was
  // long enough to re-tap. The echo closes that gap at the control: `run` buzzes and goes `pending`
  // synchronously with the tap, before any network wait. The ✓ phase is never reached here — the
  // success branch closes the sheet — and that is correct: the pane VANISHING is the outcome, and a
  // success `setStatus` on top of it would announce a fact the screen is already making.
  const closeEcho = useActionEcho();
  const { pending, confirm, reset } = usePendingConfirm();
  const inputRef = useRef<HTMLInputElement>(null);
  // Rename and close are writes, and both are §10.3 writes to a specific machine — the PANE's, read
  // off the row rather than from the ambient scope, because a pane's host is the only thing that
  // says where closing it kills a terminal. Undefined on a solo install and on a reachable host, so
  // this sheet is byte-identical to today everywhere except a crew with a quiet member.
  const hostBlock = useHostWriteBlock(pane?.host);
  // What the multiplexer underneath can actually do to a pane (M10/06) — asked per row, below.
  // Asked of the PANE's own machine, for `hostBlock`'s reason one step on (M22/03): a member runs
  // its own multiplexer, so a row this sheet offers has to be a row that machine can carry out.
  // Undefined on a solo install and for a pane on the lead, which is the lead's own answer.
  const paneHost = { host: pane?.host };
  const canRename = useMuxCapability("renamePane", paneHost);
  const canClose = useMuxCapability("closePane", paneHost);
  const canFocus = useMuxCapability("setFocus", paneHost);
  const [focusing, setFocusing] = useState(false);
  // The mux name for the "Focus in <mux>" row and its toast — see `focusMux` below for why this
  // is gated to panes on the LOCAL machine before it's trusted.
  const localMuxName = useMuxName();
  const { lead } = useCrew();
  // `useMuxName()` always answers for the collie THIS PAGE IS RUNNING ON (its own `/api/config`,
  // never a peer's — see that hook's own comment). A pane's `host` is undefined on a solo install
  // and, on a crew, is the LEAD's own id for a lead-hosted pane (lib/types.ts's doc on `host`) — so
  // either of those means "focus" runs on the mux this page already knows the name of. A pane whose
  // `host` names some OTHER member may be driven by a different multiplexer entirely, and naming the
  // local one would be a guess dressed as a fact. `focusMux` is `""` in that case, which is also the
  // "bridge hasn't answered yet" case `useMuxName()` itself returns — both get the same generic,
  // never-wrong fallback copy below.
  const focusMux = pane?.host === undefined || pane.host === lead ? localMuxName : "";

  // Reset to the action list — and reprefill the label — whenever the sheet opens on a (new) pane,
  // AND whenever it closes, so reopening never lands you mid-rename. Intentionally NOT keyed on the
  // live label, so a background poll landing while you type can't clobber your edit.
  useEffect(() => {
    setMode("actions");
    setMoreOpen(false);
    if (!open) return;
    setLabel(pane?.paneLabel ?? "");
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pane?.paneId]);

  // Autofocus the label input when rename mode opens, so the phone keyboard pops without a second tap.
  useEffect(() => {
    if (mode === "rename") inputRef.current?.focus();
  }, [mode]);

  async function save() {
    if (!pane || saving) return;
    const next = label.trim();
    setSaving(true);
    try {
      const res = await api.renamePane(pane.paneId, next, scope);
      if (res.ok) {
        setStatus(next ? t("paneActions.status.renamed") : t("paneActions.status.labelCleared"), "success");
        onRenamed();
        onClose();
      } else {
        setStatus(describeApiError(res, t("paneActions.status.renameFailed")), "error");
      }
    } catch (e) {
      setStatus(describeThrownError(e), "error");
    } finally {
      setSaving(false);
    }
  }

  // Two-tap: the first tap arms (row flips to "Tap again to close"), the second closes.
  //
  // The echo's `action` must resolve the bridge's verdict as a boolean, and BOTH failure branches
  // stay here rather than moving to `lib/mutate.ts`: this row already reports every refusal in its
  // own words (`closeFailed` is the fallback for a body that carried none), so it is not a swallow
  // site. `pane` is copied to a local first — narrowing does not survive into the async closure.
  async function requestClose() {
    if (!pane || closeEcho.pending) return;
    const target = pane;
    if (!confirm(target.paneId)) return;
    await closeEcho.run(target.paneId, async () => {
      try {
        const res = await api.closePane(target.paneId, scope);
        if (!res.ok) {
          setStatus(describeApiError(res, t("paneActions.status.closeFailed")), "error");
          return false;
        }
        onClose();
        // A pane closed from Collie takes its pin with it (ADR 0070), on every door this sheet has.
        // A pane closed in the terminal only leaves its pin dormant: absence never prunes.
        dropPin(target);
        // Same catch-up as a create: the list the operator just closed a pane out of should not
        // wait out an idle-timed gap to show it gone.
        stampTopology();
        onClosed(target.paneId);
        return true;
      } catch (e) {
        setStatus(describeThrownError(e), "error");
        return false;
      }
    });
  }

  /**
   * Put this pane on the operator's own screen.
   *
   * The ONE act in the app that moves a terminal nobody is holding, which is why it is a row you
   * tap and never a consequence of navigating (ADR 0031). No confirm: it is reversible by the
   * operator's own keyboard, unlike the close below it.
   *
   * The sheet closes on success, because the answer to "show it in the terminal" is on the other
   * screen and the operator is about to look there.
   */
  async function showInTerminal() {
    if (!pane || focusing) return;
    setFocusing(true);
    try {
      const res = await api.focusPane(pane.paneId, scope);
      if (res.ok) {
        setStatus(t("paneActions.focus.done"), "success");
        onClose();
      } else {
        setStatus(describeApiError(res, t("paneActions.focus.failed")), "error");
      }
    } catch (e) {
      setStatus(describeThrownError(e), "error");
    } finally {
      setFocusing(false);
    }
  }

  /**
   * Pin or unpin this pane on this device. Close first, then act, for the reason the find row
   * states: the sheet's focus-restore then runs before whatever the caller does with focus.
   */
  function togglePin() {
    if (!pane) return;
    const next = !pinned;
    onClose();
    setPinned(pane, next, herd);
    if (onPinChange) onPinChange(pane, next);
    else setStatus(next ? t("paneActions.pin.done") : t("paneActions.unpin.done"), "success");
  }

  const confirming = !!pane && pending === pane.paneId;

  // FORK — THE MENU IN GROUPS (survey round 3, 2026-10-03).
  //
  // On the pane's ⋮ this sheet carried up to sixteen rows in one flat run: four ways to read the
  // output, four ways to look at it differently, two archives, a handoff, a screenshot, a pin and the
  // three writes. On a 390px phone that is more than a screen, and the rows used weekly sat between
  // rows used never (four weeks of audit: hand off 0, screenshot 0, show in terminal 1). So:
  //
  //  - The four READ actions lead as a 2×2 grid of labelled tiles — History, Find, Copy output, What
  //    changed — each a whole 44px+ target, reachable without scrolling.
  //  - The rest go under three plain headings: View (how the mirror is drawn), Output (what the
  //    agent left behind), Manage (pin, rename, close). Close is still last and still two-tap.
  //  - The rarely used rows (hand off, screenshot, show in terminal) sit behind "More", which opens
  //    for this sheet only: every opening starts folded, because a menu that reopens holding last
  //    week's expansion is the wall this split removes.
  //
  // The two doors that pass no read rows (a dashboard row's hold, a pane pill's hold) open a sheet of
  // three or four rows; there is nothing to fold there, so "Show in terminal" stays a plain row under
  // Manage and those doors look as they did. A row is still drawn only when it has a callback — a
  // configured seam the bridge cannot run is withheld before it gets here (bridge/command-paths.ts).
  const crowded = [
    onFind,
    onHistory,
    onCopyOutput,
    onDiff,
    onSettings,
    onDisplay,
    onZen,
    onDocs,
    onArtifacts,
    onHandoff,
    onAnnotate,
    onPaneViewChange,
  ].some((fn) => fn !== undefined);
  const writable = !readOnly && !hostBlock;
  const focusRow = writable && canFocus.capable && (
    <ActionRow
      icon={<Monitor className="size-4 shrink-0 text-muted-foreground" />}
      label={focusMux ? t("paneActions.focus.labelWithMux", { mux: focusMux }) : t("paneActions.focus.labelFallback")}
      onClick={() => void showInTerminal()}
    />
  );
  // Close FIRST, then act — every read row below does this, for the focus reason the find row gave
  // when it was a row: both land in one React event, so the sheet unmounts in the same commit that
  // mounts whatever the row leads to.
  const closeThen = (fn: () => void) => () => {
    onClose();
    fn();
  };

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={
        pane ? (
          // Every row below acts on THIS pane on THIS machine — rename, close, focus — so the
          // machine belongs beside the name in the one place every one of those rows sits under:
          // the title. `HostChip` self-hides on a solo install (its own `multi` gate), so this
          // row is byte-identical to the old plain-string title everywhere except a crew.
          //
          // The pane name truncates; the host does not. `min-w-0 truncate` on the name plus
          // `HostChip`'s own `shrink-0` is what makes that trade: the host is short, bounded, and
          // is the disambiguator that makes "close" and "focus" safe to tap — a truncated machine
          // name is worse than a truncated pane name, because it is the half that keeps you from
          // acting on the wrong one.
          <span className="flex min-w-0 items-center gap-1.5">
            <span data-slot="pane-actions-title-name" className="min-w-0 truncate">
              {paneName(pane)}
            </span>
            <HostChip host={pane.host} variant="target" />
          </span>
        ) : (
          t("paneActions.title.fallback")
        )
      }
    >
      {mode === "actions" ? (
        <div className="flex flex-col gap-3">
          {/* The READ tiles lead, and they sit OUTSIDE the read-only / host-unreachable gates on
              purpose. Neither refusal is about them: find searches a buffer this phone already
              holds, and history opens a transcript the lead reads off its own disk — a device that
              may not write, or a member machine that has stopped answering, takes away nothing either
              one needs. */}
          {pane && (
            <ReadTiles label={tf("paneActions.group.read")}>
              {onHistory && (
                <ReadTile
                  icon={<ScrollText className="size-4 shrink-0 text-muted-foreground" />}
                  label={t("chat.history.label")}
                  onClick={closeThen(onHistory)}
                />
              )}
              {onFind && (
                <ReadTile
                  icon={<Search className="size-4 shrink-0 text-muted-foreground" />}
                  label={t("chat.find.label")}
                  onClick={closeThen(onFind)}
                />
              )}
              {/* Copy fires inside this same tap, so the clipboard write still counts as
                  user-initiated even as the sheet unmounts. */}
              {onCopyOutput && (
                <ReadTile
                  icon={<Copy className="size-4 shrink-0 text-muted-foreground" />}
                  label={t("chat.copyOutput.label")}
                  onClick={closeThen(onCopyOutput)}
                />
              )}
              {onDiff && (
                <ReadTile
                  icon={<FileDiff className="size-4 shrink-0 text-muted-foreground" />}
                  label={t("diff.row.label")}
                  onClick={closeThen(onDiff)}
                />
              )}
            </ReadTiles>
          )}
          {pane && (
            <MenuGroup label={tf("paneActions.group.view")}>
              {/* THE BODY SWITCH. The label names WHERE IT TAKES YOU. */}
              {paneView !== undefined && onPaneViewChange && (
                <ActionRow
                  icon={
                    paneView === "chat" ? (
                      <SquareTerminal className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <MessagesSquare className="size-4 shrink-0 text-muted-foreground" />
                    )
                  }
                  label={t(paneView === "chat" ? "chat.mode.terminal" : "chat.mode.chat")}
                  hint={paneViewNote}
                  onClick={closeThen(() => onPaneViewChange(paneView === "chat" ? "terminal" : "chat"))}
                />
              )}
              {onSettings && (
                <ActionRow
                  icon={<SlidersHorizontal className="size-4 shrink-0 text-muted-foreground" />}
                  label={t("paneActions.settings.label")}
                  onClick={closeThen(onSettings)}
                />
              )}
              {onDisplay && (
                <ActionRow
                  icon={<Settings2 className="size-4 shrink-0 text-muted-foreground" />}
                  label={t("composer.controls.displayAria")}
                  onClick={closeThen(onDisplay)}
                />
              )}
              {/* Zen is the one row here that takes the whole screen over, so it is the deliberate
                  tap at the end of the run rather than the first thing under the thumb. */}
              {onZen && (
                <ActionRow
                  icon={<Maximize2 className="size-4 shrink-0 text-muted-foreground" />}
                  label={t("chat.zen.label")}
                  onClick={closeThen(onZen)}
                />
              )}
            </MenuGroup>
          )}
          {pane && (
            <MenuGroup label={tf("paneActions.group.output")}>
              {onDocs && (
                <ActionRow
                  icon={<BookOpen className="size-4 shrink-0 text-muted-foreground" />}
                  label={t("docs.row.label")}
                  onClick={closeThen(onDocs)}
                />
              )}
              {/* What this pane's agent MADE (bridge/artifacts.ts) — beside Documents because it is
                  the same family: things to read, not things to send. */}
              {onArtifacts && (
                <ActionRow
                  icon={<FileCode2 className="size-4 shrink-0 text-muted-foreground" />}
                  label={t("artifacts.row.label")}
                  onClick={closeThen(onArtifacts)}
                />
              )}
            </MenuGroup>
          )}
          {pane && crowded && (
            <MoreRows open={moreOpen} onToggle={() => setMoreOpen((v) => !v)}>
              {/* Hand the conversation to another harness — the one row here that ends this pane's
                  part of the work and starts another pane's. */}
              {onHandoff && (
                <ActionRow
                  icon={<ArrowRightLeft className="size-4 shrink-0 text-muted-foreground" />}
                  label={t("handoff.row.label")}
                  onClick={closeThen(onHandoff)}
                />
              )}
              {/* Asks the Mac's headless browser for a picture of a local page (bridge/shot.ts). */}
              {onAnnotate && (
                <ActionRow
                  icon={<Camera className="size-4 shrink-0 text-muted-foreground" />}
                  label={t("annotate.row.label")}
                  onClick={closeThen(onAnnotate)}
                />
              )}
              {focusRow}
            </MoreRows>
          )}
          <MenuGroup label={tf("paneActions.group.manage")}>
            {/* Pin to top / Unpin (ADR 0070) leads Manage: it changes this device and types into no
                terminal, so a read-only device and a pane on a quiet machine can still pin. */}
            {pane && (
              <ActionRow
                icon={
                  pinned ? (
                    <PinOff className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <Pin className="size-4 shrink-0 text-muted-foreground" />
                  )
                }
                label={pinned ? t("paneActions.unpin.label") : t("paneActions.pin.label")}
                onClick={togglePin}
              />
            )}
            {readOnly ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">{t("paneActions.readOnly")}</p>
            ) : hostBlock ? (
              // Refused BEFORE anything is attempted (§10.3): no queue, no retry, no "try anyway" —
              // naming the machine and its last-seen age says what to actually wait for.
              <p className="px-3 py-2 text-sm text-muted-foreground">
                {t("paneActions.hostBlockSuffix", { hostBlock })}
              </p>
            ) : (
              <>
                {/* Each row asks its OWN capability, not one "can this sheet do things" flag: a
                    multiplexer that renames but will not close is an ordinary shape. A row a
                    multiplexer cannot back is HIDDEN. */}
                {canRename.capable && (
                  <ActionRow
                    icon={<Pencil className="size-4 shrink-0 text-muted-foreground" />}
                    label={t("paneActions.rename.label")}
                    onClick={() => setMode("rename")}
                  />
                )}
                {/* On a short sheet there is nothing to fold, so this stays a plain row. */}
                {!crowded && focusRow}
                {canClose.capable && (
                  <DestructiveActionRow
                    icon={<XCircle className="size-4 shrink-0" />}
                    label={t("paneActions.close.label")}
                    confirmLabel={t("paneActions.close.confirm")}
                    closingLabel={t("paneActions.close.closing")}
                    armed={confirming}
                    // `pending` rather than `phaseOf(id)`: close is the only member of this echo
                    // group, so the group flag says the same thing without needing a pane.
                    closing={closeEcho.pending}
                    onClick={() => void requestClose()}
                  />
                )}
                {/* An EMPTY sheet is the one case that must speak: hide the meaningless, explain
                    the expected. */}
                {!canRename.capable && !canClose.capable && !canFocus.capable && (
                  <p className="px-3 py-2 text-sm leading-snug text-muted-foreground">
                    {canRename.note || canClose.note || canFocus.note || t("paneActions.empty.fallback")}
                  </p>
                )}
              </>
            )}
          </MenuGroup>
        </div>
      ) : readOnly ? (
        <p className="py-2 text-sm text-muted-foreground">{t("paneActions.readOnly")}</p>
      ) : hostBlock ? (
        <p className="py-2 text-sm text-muted-foreground">
          {t("paneActions.hostBlockSuffix", { hostBlock })}
        </p>
      ) : (
        <RenameView
          inputRef={inputRef}
          label={label}
          onLabelChange={setLabel}
          onSave={() => void save()}
          onBack={() => setMode("actions")}
          saving={saving}
          // A blank pane field clears the label (blank → null on the bridge), so Save stays enabled.
          canSave={true}
          placeholder={t("paneActions.rename.placeholder")}
        />
      )}
    </BottomSheet>
  );
}

/**
 * FORK: the four read actions as labelled tiles, two to a row on a phone and four on a wider sheet.
 *
 * A tile and not a row because these are the actions the ⋮ is opened FOR, and four rows of them were
 * the top two hundred pixels of a sheet that then scrolled. Each tile states the 44px floor itself
 * (`min-h-11`, DESIGN.md §6) and its label is its accessible name, so a reader hears the same words a
 * thumb sees. The grid draws nothing when no tile was handed to it — the pane strip's door.
 */
function ReadTiles({ label, children }: { label: string; children: ReactNode }) {
  if (Children.toArray(children).length === 0) return null;
  return (
    <div role="group" aria-label={label} data-slot="pane-read-tiles" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {children}
    </div>
  );
}

function ReadTile({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-11 flex-col items-center justify-center gap-1 rounded-lg bg-muted/60 px-2 py-2.5 text-center text-xs font-medium leading-tight transition-colors hover:bg-accent active:bg-muted"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

/**
 * FORK: one labelled run of rows — a `group` named by its heading, so a screen reader hears "View,
 * group" before the rows it holds. Draws nothing at all when it was handed nothing: a heading over an
 * empty run is a promise the sheet cannot keep.
 */
function MenuGroup({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  if (Children.toArray(children).length === 0) return null;
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-1">
      <SectionLabel id={id} placement="above" className="px-3">
        {label}
      </SectionLabel>
      {children}
    </div>
  );
}

/**
 * FORK: the rows used least, folded behind one row that says so.
 *
 * The fold is the caller's state and lives only as long as this sheet is open (see `moreOpen`), so
 * every opening starts folded. Draws nothing when nothing would be inside it.
 */
function MoreRows({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  const id = useId();
  if (Children.toArray(children).length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={onToggle}
        className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-accent active:bg-muted"
      >
        <Ellipsis className="size-4 shrink-0" />
        <span className="flex-1">{tf("paneActions.more")}</span>
        <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      <Collapse open={open}>
        <div id={id} className="flex flex-col gap-1">
          {children}
        </div>
      </Collapse>
    </div>
  );
}
