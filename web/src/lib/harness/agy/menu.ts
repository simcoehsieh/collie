// Antigravity's GENERIC MODALS — `/model`, `/permissions` and whatever ships next — lifted into the
// harness-neutral `MenuModel` on the strength of the keys the screen NAMES in its own footer.
//
// agy prints two footer grammars, neither of which is Claude's "<key> to <verb>" (menu-hints.ts):
//
//     Keyboard: ↑/↓ Navigate  ←/→ Effort  enter Select  esc Go Back     (modals; 2+ spaces apart)
//     ↑/↓ Navigate · enter Select · tab Complete                        (popups; middle dots)
//
// Each hint is "<key> <Verb phrase>" with NO "to". The parser below reads exactly that and REJECTS a
// hint written with "to" — that is another harness's footer (Claude's `/model` picker, Codex's
// cards), and an agy detector claiming it would put agy's buttons under a screen it did not measure.
// Every action key still goes through the shared `menuKeyFor` whitelist, so the conformance suite's
// "only whitelisted keys, never a digit" invariant (.adr/0009) holds here exactly as for Claude.
//
// Runs LAST in agyBuildBlocks: after prompt-select and multi-select (footers `classifyFooter` claims
// are declined here) and only when no input box is on screen. Verified on agy--menu-model.txt and
// agy--menu-permissions.txt (Antigravity CLI 1.2.0, 2026-09-10). Pure; no pane access.

import type { StyledLine } from "../../blocks";
import { hasInputBox } from "./chrome";
import { classifyFooter, isAlienBuffer, isBlank, isBoxBorder, isHorizontalRule, lineText } from "./markers";
import { regionSignature } from "./prompt-select";
import type { MenuAction, MenuModel, MenuNav } from "../menu-model";
import { capitaliseMenuLabel, menuKeyFor } from "../menu-hints";

export interface MenuRegion {
  model: MenuModel;
  startLine: number;
}

/** What an agy footer advertised: the sendable actions, and the two arrow pairs by name. */
export interface AgyFooterHints {
  actions: MenuAction[];
  /** `↑/↓ <verb>` was printed. */
  upDown: boolean;
  /** The verb of a `←/→ <verb>` hint, when printed. */
  leftRightVerb: string | null;
}

const KEYBOARD_PREFIX = /^\s*Keyboard:\s*/i;
const DOT_SPLIT = /\s+·\s+/;
const SPACE_SPLIT = /\s{2,}/;
const HINT = /^(\S+)\s+(.+)$/;
// "<key> to <verb>" is Claude's / Codex's footer grammar, never agy's.
const FOREIGN_HINT = /^to\s/i;

/**
 * Parse an agy key-hint footer. Null when the line is not one: fewer than two hints, any hint in the
 * foreign "to" grammar, or no hint that maps to a sendable key or an arrow pair.
 */
export function parseAgyKeyHintFooter(text: string): AgyFooterHints | null {
  const body = text.replace(KEYBOARD_PREFIX, "").trim();
  if (body.length === 0) return null;
  const segments = body.split(body.includes(" · ") ? DOT_SPLIT : SPACE_SPLIT);
  if (segments.length < 2) return null;
  const hints: AgyFooterHints = { actions: [], upDown: false, leftRightVerb: null };
  for (const segment of segments) {
    const m = HINT.exec(segment.trim());
    if (!m) return null; // a bare word is prose, and prose is not a footer
    const token = m[1]!;
    const verb = m[2]!;
    if (FOREIGN_HINT.test(verb)) return null;
    if (token === "↑/↓") {
      hints.upDown = true;
      continue;
    }
    if (token === "←/→") {
      hints.leftRightVerb = verb.trim();
      continue;
    }
    // agy prints `esc`, `enter`, `tab`, `ctrl+g`, a letter — every token of a real footer maps.
    // One that does not (`space`, a glyph, a word) means this is not a key-hint footer at all, and
    // the whole line is declined rather than the token skipped: Claude's background-agents row
    // ("◯ worker … 1m 17s · ↓ 12.0k tokens") would otherwise yield a lone "Down" action.
    const key = menuKeyFor(token);
    if (key === null) return null;
    const action: MenuAction = { label: capitaliseMenuLabel(verb), keys: [key] };
    if (key === "Escape") action.cancel = true;
    hints.actions.push(action);
  }
  if (hints.actions.length === 0 && !hints.upDown && hints.leftRightVerb === null) return null;
  return hints;
}

const POINTER_ROW = /^\s*>\s\S/;
const REGION_SCAN_WINDOW = 30;
// The footer sits above agy's status row, which is the last non-blank line; the window is one row
// wider than that so a screen that gained a row under the footer still finds it — and the signature
// runs to the TAIL, so that gained row is in it.
const FOOTER_TAIL_WINDOW = 3;
// The Write-in field of a question dialog (multi-select.ts): its footer names keys, but the field
// has the keyboard and every key would type. Refused here as it is there — no buttons, raw mirror.
const WRITE_IN_FOOTER = /^\s*enter\s+submit\s*·\s*esc\s+back\s*$/i;
const WRITE_IN_FIELD = /^\s*your answer:/i;

/**
 * Detect an agy modal at the tail of `lines`. Ordered bails: alien buffer; the footer (or the row
 * above the status line) must parse as an agy key-hint footer with at least one sendable action and
 * must NOT be a footer a specific grammar owns; no input box on screen; a rule/border within
 * REGION_SCAN_WINDOW above the footer, with a non-blank title under it.
 */
export function detectMenuRegion(lines: StyledLine[]): MenuRegion | null {
  const texts = lines.map(lineText);
  if (isAlienBuffer(texts)) return null;

  let fi = texts.length - 1;
  while (fi >= 0 && isBlank(texts[fi]!)) fi--;
  if (fi < 0) return null;

  let footer = -1;
  let hints: AgyFooterHints | null = null;
  for (let i = fi, seen = 0; i >= 0 && seen < FOOTER_TAIL_WINDOW; i--) {
    if (isBlank(texts[i]!)) continue; // agy leaves a blank row between a modal's footer and the status row
    seen++;
    if (WRITE_IN_FOOTER.test(texts[i]!) || WRITE_IN_FIELD.test(texts[i]!)) return null;
    // A footer a verified grammar owns is declined — EXCEPT agy's own `Keyboard:` modal footer,
    // which `classifyFooter` reads as "select" on the strength of its `enter Select` hint although
    // no numbered-option recipe exists for it (`/model` picks the HIGHLIGHTED row on Enter, and
    // never a digit). The `·` dialog footers stay with prompt-select / multi-select.
    if (!KEYBOARD_PREFIX.test(texts[i]!) && classifyFooter(texts[i]!) !== null) return null;
    const parsed = parseAgyKeyHintFooter(texts[i]!);
    if (parsed !== null && parsed.actions.length > 0) {
      footer = i;
      hints = parsed;
      break;
    }
  }
  if (footer < 0 || hints === null) return null;
  if (hasInputBox(lines)) return null;

  let top = -1;
  for (let i = footer - 1, seen = 0; i >= 0 && seen < REGION_SCAN_WINDOW; i--, seen++) {
    if (isBoxBorder(texts[i]!) || isHorizontalRule(texts[i]!)) {
      top = i;
      break;
    }
  }
  if (top < 0) return null;

  let title = "";
  for (let i = top + 1; i < footer; i++) {
    if (!isBlank(texts[i]!)) {
      title = texts[i]!.trim();
      break;
    }
  }
  if (title === "") return null;

  // Arrows are advertised by the footer AND borne out by the region: Up/Down need a pointed row to
  // move; Left/Right name the row whose leading word is the verb (`Effort  ◂ ●━━●━━◉ ▸`), which is
  // the live value they adjust — it moves with every press, so it is the label, never identity.
  const nav: MenuNav = { upDown: false };
  if (hints.upDown) {
    for (let i = top + 1; i < footer; i++) {
      if (POINTER_ROW.test(texts[i]!)) {
        nav.upDown = true;
        break;
      }
    }
  }
  if (hints.leftRightVerb !== null) {
    const verb = hints.leftRightVerb;
    let label = verb;
    for (let i = top + 1; i < footer; i++) {
      const t = texts[i]!.trim();
      if (t.toLowerCase().startsWith(verb.toLowerCase())) {
        label = t.replace(/\s+/g, " ");
        break;
      }
    }
    nav.leftRight = { verb, label };
  }

  return {
    model: { title, actions: hints.actions, nav, signature: regionSignature(texts, top, fi) },
    startLine: top,
  };
}

/** Just the model (or null) — the race guard's re-derivation entry point. */
export function detectMenu(lines: StyledLine[]): MenuModel | null {
  return detectMenuRegion(lines)?.model ?? null;
}
