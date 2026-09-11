import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronDown, Lock } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { Modifier } from "@/lib/key-queue";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { useKeyQueue } from "@/hooks/use-key-queue";
import { useActionEcho } from "@/hooks/use-action-echo";
import { useHoldRepeat } from "@/hooks/use-hold-repeat";
import { KeyQueueStrip } from "@/components/key-queue-strip";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { keysSendable } from "@/lib/mux-capability";
import { CONTROL_PRESETS, type CtrlDef } from "@/lib/operator-keys";

// The inline navigation tray: the keys you need to drive an interactive agent prompt (selection
// menus, multi-select forms, numbered choices) WITHOUT covering the terminal mirror — it docks
// above the composer, so you watch the menu update as you press. Keys follow Herdr's verified
// `pane.send_keys` grammar (see HERDR_API.md): special keys bare, modifier chords joined with "+".
//
// Two modes, driven by useKeyQueue. When nothing is armed and the queue is empty, a key press fires
// immediately (the classic path). Arm one or more modifiers (⇧ Shift / Ctrl / Alt) — or once any key
// is queued — and the tray enters compose mode: presses stage a visible key queue (the strip) that
// you review and Send as ONE call. Herdr rejects a bare "Shift"/"Ctrl"/"Alt" keypress, so modifiers
// only exist as part of a chord. Each modifier is a CHECKBOX that cycles off → once → locked → off:
// tap once for a one-shot (composed into the next staged key, then released), tap again to LOCK it
// armed across presses and Sends, tap a third time to clear. Any subset combines — `ctrl+shift+p`.
//
// An immediate press ECHOES on its own button (useActionEcho): accent fill the instant you tap, a ✓
// once the bridge accepts it. Before this the path was silent on success and the mirror — up to ~2s
// behind — was the only acknowledgement, so pressing Enter felt like nothing happened. A STAGED press
// needs no echo: the chip appearing in the strip is already the receipt. Deliberately no sibling
// dimming here (unlike the quick replies): this is a keypad you drum on, and dimming eight keys per
// arrow press would strobe.

interface NavTrayProps {
  /** Resolves true when the bridge accepted the keys — drives the ✓ echo on the pressed button. */
  onSend: (keys: string[]) => Promise<boolean>;
  /**
   * The labelled preset chords under "Presets" — the operator's own `keys.toml` rows when any of
   * them address this pane, otherwise the shipped six (resolved by `ctrlPresetsFor`). Only this
   * list is configurable; everything else in the tray is the fixed keyboard.
   */
  presets?: readonly CtrlDef[];
  /** How many keys are staged, reported up so the Composer can guard closing the dock on a composed
   *  sequence. Reports 0 on unmount. Must be referentially stable (a setState fn is ideal). */
  onQueueChange?: (staged: number) => void;
  disabled?: boolean;
  /**
   * Neutral key spellings this multiplexer refuses (`/api/config`, M10/06). A button whose chord
   * uses one is greyed — the door is open (`sendKeys`), this key is simply not behind it.
   *
   * Deliberately a prop rather than a hook call in here: the tray is the fixed keyboard and gets
   * everything it renders from its parent, so a test can drive it without a config fetch.
   */
  unsupportedKeys?: readonly string[];
}

/** Stable default so an omitted prop never re-renders the pad. */
const NO_REFUSED_KEYS: readonly string[] = [];

// FORK — A KEYCAP LOOKS PRESSABLE, AND THAT IS ONE LINE OF SHADOW.
//
// The caps were flat `--muted` rectangles with no border and no bottom edge, which is the same
// drawing this app uses for a DISABLED control — so a pad of live keys read as a pad of dead ones.
// iOS's own keyboard carries a 1px bottom shadow for exactly this reason: it is the whole of what
// says "this has a top surface you can push down".
//
// `--rule` and not `--border`: the edge under a cap separates the key from the panel it sits on,
// which is the region-boundary job `--rule` is the stronger line for (see ui/list-group.tsx). The
// shadow is UNCONDITIONAL — it rides in the shared class, in every state, so a cap that lights up
// on a press keeps its bottom edge and only the fill changes (DESIGN.md §2; a box-shadow takes no
// layout room either way, so this is paint and never reflow). `rounded-md` overrides size="sm"'s
// `rounded-sm`: a keycap is a key, not a chip. The border is RECOLOURED, never added —
// `ui/button.tsx` reserves `border border-transparent` in its base string, so a cap that gains an
// edge here occupies exactly the box it always did.
//
// SHAPE and FILL are separate strings, and that split is load-bearing: a className wins over the
// variant it is merged with, so a single "rounded + edge + bg-card" constant would have silently
// painted over the `default` variant's fill and killed the press echo — the one thing on this pad
// that says a key reached the terminal. Shape is unconditional; the fill is only the resting one.
const KEYCAP = "rounded-md border-rule shadow-[0_1px_0_var(--rule)]";
const KEYCAP_REST = "bg-card";

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

// F1–F12 — Herdr's send_keys grammar accepts them bare (HERDR_API.md), and harnesses bind them to
// real actions (tmux windows, CLI hotkeys, agent-extension views like pi's CE Workflow: F7 opens
// its orchestrator). Without buttons for them, a phone-only user has no route to any such keybind.
const FN_KEYS = ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"];

// Two views behind a segmented toggle: the keys pad (arrows/Esc, Tab/Space/Enter, modifiers, Ctrl
// presets) and a phone-dialer digit grid. Digits were a cramped nine-across sliver row; on their own
// tab they get large, thumb-sized targets. The tab is component state only (resets to "keys" each
// open — the dock unmounts the tray when closed), while the armed modifier, the key queue, and the
// Ctrl-expand persist across the toggle so a composed sequence survives switching to the digit pad.
type Tab = "keys" | "digits";

export function NavTray({
  onSend,
  presets = CONTROL_PRESETS,
  onQueueChange,
  disabled,
  unsupportedKeys = NO_REFUSED_KEYS,
}: NavTrayProps) {
  useLocale();
  const [tab, setTab] = useState<Tab>("keys");
  const [ctrlOpen, setCtrlOpen] = useState(false);
  const [fkeysOpen, setFkeysOpen] = useState(false);
  const { queue, mods, activeMods, composing, arm, press, pushBase, removeAt, clear, take } =
    useKeyQueue();
  const { pending, confirm, reset } = usePendingConfirm(); // danger ctrl two-tap (immediate path only)
  const echo = useActionEcho();
  // Hold-to-repeat, WHITELISTED to the arrows (see navBtn's `repeat` flag). Deliberately a whitelist
  // rather than a blacklist: Enter/Esc/Space/digits/Ctrl-presets structurally must not repeat, and
  // the danger presets' two-tap guard lives on a different code path (pressCtrl) that a future
  // refactor could route around — so repeat capability is opt-in per button, not opt-out.
  // Disabled while composing: a hold must never stage fifteen identical chips into a queue whose
  // entire value is that you can review it before it goes on the wire.
  const repeat = useHoldRepeat(
    (key, n) => onSend(Array<string>(n).fill(key)),
    !disabled && !composing,
  );

  // Report the staged count up. The tray unmounts when the dock closes (which is what discards the
  // queue), so the Composer can't read this state itself — it has to be pushed. The second effect
  // reports 0 on unmount so a stale count can't outlive the tray and arm a phantom confirm.
  useEffect(() => {
    onQueueChange?.(queue.length);
  }, [queue.length, onQueueChange]);
  useEffect(
    () => () => {
      onQueueChange?.(0);
    },
    [onQueueChange],
  );

  // Route a key press through the queue: fire immediately when idle, stage when composing. Only the
  // immediate path echoes — a staged press is already visible as a chip.
  function fire(keys: string[], id: string) {
    if (disabled) return;
    const r = press(keys);
    if (r.mode === "fire") void echo.run(id, () => onSend(r.keys));
  }

  // Ctrl presets. When composing, a tap just stages the chord (the Send review IS the confirm — no
  // two-tap, and the strip's Send shows destructive styling for c/d/z). When firing immediately, the
  // danger chords (d/z) keep the original two-tap confirm.
  function pressCtrl(item: CtrlDef) {
    if (disabled) return;
    if (!composing && item.danger && !confirm(item.label)) return; // first tap arms the confirm
    fire(item.keys, item.label);
  }

  // Send the whole queue as one ordered call, then reset any stray confirm. No echo on the strip's
  // Send, deliberately: `take()` empties the queue synchronously, so the chips vanishing IS the
  // receipt (and the strip itself unmounts unless a locked modifier holds it open) — a spinner there
  // would have nothing left to render on. That sentence is also quoted at `sendKeys` in
  // lib/ack-manifest.ts, which is where a "this control says nothing" claim is now reviewed.
  function sendQueue() {
    if (disabled) return;
    const keys = take();
    reset();
    if (keys.length > 0) void onSend(keys);
  }

  // A key button, echoing its own press. `pending` fills it the instant you tap (no network wait);
  // `done` swaps a ✓ in for the label for ECHO_DONE_MS. Keyed by the wire string, so the same key
  // pressed twice in a row restarts its own cycle rather than inheriting a stale ✓.
  //
  // `repeatable` opts a button into hold-to-repeat. While held, the button shows a live "×N" count
  // instead of running the per-press echo — echo.run per repeat tick would restart the ✓ timer ~11
  // times a second and strobe, the same reason sibling dimming is banned on this pad.
  const navBtn = (content: ReactNode, keys: string[], aria?: string, repeatable = false) => {
    const id = keys.join(" ");
    const phase = echo.phaseOf(id);
    const held = repeatable && repeat.holding === keys[0];
    const bind = repeatable ? repeat.bind(keys[0], () => fire(keys, id)) : undefined;
    // Greyed rather than removed: the pad's geometry IS its usability (Esc top-left, arrows as an
    // inverted-T), and pulling a key out of the grid would move every key after it. A dead button in
    // its own place is the lesser harm here — the opposite call from the action sheets, and for a
    // reason those sheets do not have.
    const refused = !keysSendable(keys, unsupportedKeys);
    return (
      <Button
        type="button"
        variant={held || phase !== "idle" ? "default" : "outline"}
        size="sm"
        disabled={disabled || refused}
        {...(bind ?? { onClick: () => fire(keys, id) })}
        aria-label={aria}
        // touch-action/select-none: without them a held button on iOS starts a text selection and
        // Android may treat the hold as a scroll gesture, both of which cancel the pointer stream.
        className={cn(
          KEYCAP,
          held || phase !== "idle" ? undefined : KEYCAP_REST,
          "h-10 touch-manipulation select-none px-0 text-sm font-medium",
        )}
      >
        {held ? (
          <span className="mx-auto flex items-center gap-1">
            {content}
            {repeat.count > 1 && <span className="text-xs tabular-nums">×{repeat.count}</span>}
          </span>
        ) : phase === "done" ? (
          <Check className="mx-auto size-4" />
        ) : (
          content
        )}
      </Button>
    );
  };

  // A modifier button reads its own three-state mode from `mods`: outline when off, filled (default)
  // when armed — once OR locked — with a small Lock glyph beside the label to distinguish locked from
  // one-shot. Tapping cycles off → once → locked → off.
  const modBtn = (m: Modifier, label: ReactNode, className?: string) => {
    const mode = mods[m];
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => arm(m)}
        aria-pressed={mode !== "off"}
        // FORK: armed is TONAL, not solid. A modifier is a STATE — it stays on across presses and
        // Sends — and the app's answer to state is `--control-on` (see pane-strip.tsx). Solid
        // primary here also made three of the loudest objects on the screen sit in a row under a
        // terminal. The Lock glyph still separates locked from one-shot.
        className={cn(
          KEYCAP,
          "h-10 px-0 text-sm font-medium",
          mode === "off" ? KEYCAP_REST : "bg-control-on text-control-on-foreground",
          className,
        )}
      >
        {mode === "locked" && <Lock className="size-3" />}
        {label}
      </Button>
    );
  };

  return (
    // FORK: the pad has no ground of its own any more — `ComposerDock` paints it (bg-card,
    // rounded-t-2xl), so the panel sits OVER the dock instead of sharing `--background` with it.
    // A `bg-muted/30` wash inside a card is a second, fainter surface inside the first, and the
    // caps below are `--card`: the wash was the thing making them look sunken.
    <div className="space-y-2 px-3 py-2.5">
      {/* Staging strip — visible only while composing (a modifier armed or keys queued). Same on
          both tabs; the review-and-Send surface replaces the old "⇧ armed" hint line. */}
      <KeyQueueStrip
        queue={queue}
        mods={activeMods}
        onRemove={removeAt}
        onClear={clear}
        onSend={sendQueue}
        onBaseChar={pushBase}
        disabled={disabled}
      />

      {/* Segmented toggle: the keyboard vs. the phone-dialer digit grid.
          FORK, two changes. The active segment is TONAL (`--control-on`) rather than a fill, which
          is what this app's state language now is everywhere — this is one of two mutually exclusive
          views, not an action. And the first segment reads "Keyboard", not "Keys": with the dock
          button, the panel's own title and this segment all saying "Keys", the word appeared three
          times inside 300px and named three different things. "Keyboard" is also simply what the
          pad is — the component's own doc calls it the fixed keyboard. */}
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted/60 p-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setTab("keys")}
          aria-pressed={tab === "keys"}
          className={cn(
            "h-8 text-sm font-medium",
            tab === "keys" && "bg-control-on text-control-on-foreground",
          )}
        >
          {t("keys.tab.keyboard")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setTab("digits")}
          aria-pressed={tab === "digits"}
          className={cn(
            "h-8 font-mono text-sm",
            tab === "digits" && "bg-control-on text-control-on-foreground",
          )}
        >
          123
        </Button>
      </div>

      {tab === "keys" ? (
        <>
          {/* Same physical-keyboard geometry as the composer's inline quick keys, for muscle memory:
              Esc top-left, Tab directly below it, arrows as an inverted-T on the right. The Esc/Up
              gap holds a quick Ctrl+C — the one interrupt chord worth a single tap, without opening
              Presets (which still lists it alongside the other Ctrl chords for discoverability).
              It carries the preset's own spelling, "Ctrl C" — the same chord must not read two ways
              in one drawer, and tmux notation ("C-c") is the spelling this codebase keeps out of
              sight precisely because it is not what Herdr accepts either. */}
          {/* FORK — ONE GRID, NOT FOUR ROWS THAT HAPPEN TO BE NEAR EACH OTHER.
              This was a 4-column grid, then a full-width button, then a 3-column grid, each in its
              own box: no column edge lined up with any other row's, so a keypad read as five
              hand-built strips. They are one `grid grid-cols-4` now, and every gutter aligns by
              construction rather than by arithmetic.

              Space spans all four, the way a spacebar does. Shift spans TWO and Ctrl/Alt one each —
              4 does not divide by 3, and the wide key is the one a real keyboard makes wide, so the
              split lands on the grid's own column lines instead of inventing a second set of them.

              The geometry inside the first two rows is untouched and must stay: Esc top-left, Tab
              directly below it, arrows as an inverted-T on the right, matching the composer's inline
              quick keys for muscle memory. The Esc/Up gap holds a quick Ctrl+C — the one interrupt
              chord worth a single tap, carrying the preset's own spelling, because the same chord
              must not read two ways in one drawer. */}
          <div className="grid grid-cols-4 gap-1.5">
            {navBtn("Esc", ["Escape"])}
            {navBtn("Ctrl C", ["ctrl+c"], "Ctrl+C")}
            {navBtn(<ArrowUp className="size-4" />, ["Up"], "Up", true)}
            {navBtn("⏎ Enter", ["Enter"])}
            {navBtn("Tab", ["Tab"])}
            {navBtn(<ArrowLeft className="size-4" />, ["Left"], "Left", true)}
            {navBtn(<ArrowDown className="size-4" />, ["Down"], "Down", true)}
            {navBtn(<ArrowRight className="size-4" />, ["Right"], "Right", true)}

            {/* Space — the spacebar, spanning the whole width of the pad. */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || !keysSendable(["Space"], unsupportedKeys)}
              onClick={() => fire(["Space"], "Space")}
              className={cn(
                KEYCAP,
                "col-span-4 h-10 w-full text-sm font-medium",
                echo.phaseOf("Space") === "idle"
                  ? KEYCAP_REST
                  : "bg-primary text-primary-foreground",
              )}
            >
              {echo.phaseOf("Space") === "done" ? <Check className="size-4" /> : "Space"}
            </Button>

            {/* Modifiers (checkboxes that cycle off → once → locked → off): arm any subset and the
                next key composes as their combined chord. Locked (Lock glyph) stays armed across
                presses and Sends. Display order Shift · Ctrl · Alt; compose order is canonical
                regardless of taps. */}
            {modBtn("shift", "⇧ Shift", "col-span-2")}
            {modBtn("ctrl", "Ctrl")}
            {modBtn("alt", "Alt")}
          </div>

          {/* Presets (collapsed by default; expanding keeps everything inline, never covering the
              mirror). On the immediate path a danger preset needs a second tap; while composing a
              tap just stages its chords for review. An operator's `keys.toml` rows arrive here as
              the same CtrlDef list, so a multi-chord row sends as one batch and an armed modifier
              stages it — no special-casing. */}
          <div>
            <button
              type="button"
              onClick={() => setCtrlOpen((o) => !o)}
              className="flex items-center gap-1 px-1 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
            >
              {t("keys.presets.label")}
              <ChevronDown className={cn("size-3 transition-transform", ctrlOpen && "rotate-180")} />
            </button>
            {/* TWO columns, not three: this section sits under the 4-column pad, and 2 is the only
                other count whose gutter lands on one of the pad's own column lines. It also gives an
                operator's `keys.toml` label room to be a word rather than a chord. */}
            {ctrlOpen && (
              <div className="mt-1 grid grid-cols-2 gap-1.5">
                {presets.map((item) => {
                  const isPending = pending === item.label;
                  const phase = echo.phaseOf(item.label);
                  // The armed two-tap confirm outranks the echo — it's the thing you must read.
                  const variant = isPending ? "destructive" : phase === "idle" ? "outline" : "default";
                  return (
                    <Button
                      key={item.label}
                      type="button"
                      variant={variant}
                      size="sm"
                      disabled={disabled || !keysSendable(item.keys, unsupportedKeys)}
                      onClick={() => pressCtrl(item)}
                      className={cn(
                        KEYCAP,
                        variant === "outline" && KEYCAP_REST,
                        "h-10 text-sm font-medium",
                        item.danger && !isPending && phase === "idle" && "text-destructive",
                      )}
                    >
                      {isPending ? (
                        t("keys.confirm.label")
                      ) : phase === "done" ? (
                        <Check className="size-4" />
                      ) : (
                        item.label
                      )}
                    </Button>
                  );
                })}
              </div>
            )}
          </div>
          {/* Function keys (#119) — same collapsible shape as Presets: collapsed by default so the
              tray doesn't grow, expanding to a 4×3 grid. They ride the ordinary navBtn path, so the
              press echo, key-queue staging, and chords with armed modifiers (ctrl+F7, …) all come
              for free — no special-casing. */}
          <div>
            <button
              type="button"
              onClick={() => setFkeysOpen((o) => !o)}
              className="flex items-center gap-1 px-1 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
            >
              {t("keys.fkeys.label")}
              <ChevronDown className={cn("size-3 transition-transform", fkeysOpen && "rotate-180")} />
            </button>
            {fkeysOpen && (
              <div className="mt-1 grid grid-cols-4 gap-1.5">{FN_KEYS.map((k) => navBtn(k, [k]))}</div>
            )}
          </div>
        </>
      ) : (
        /* Pick a numbered option — a phone-dialer 3×3 grid of large, thumb-sized digit keys. Same
           fire() path as everything else, so an armed modifier / a queue built on the Keys tab still
           applies here. */
        <div className="grid grid-cols-3 gap-1.5">
          {DIGITS.map((d) => {
            const phase = echo.phaseOf(d);
            return (
              <Button
                key={d}
                type="button"
                variant={phase === "idle" ? "outline" : "default"}
                size="sm"
                disabled={disabled}
                onClick={() => fire([d], d)}
                className={cn(KEYCAP, phase === "idle" && KEYCAP_REST, "h-12 font-mono text-lg")}
              >
                {phase === "done" ? <Check className="size-5" /> : d}
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}
