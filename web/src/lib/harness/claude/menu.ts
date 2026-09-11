// The GENERIC menu grammar — the LAST-RESORT detector for a modal screen no specific grammar owns.
//
// Claude Code paints a growing family of full-screen pickers (`/model`, and whatever ships next)
// that are not AskUserQuestion dialogs: they have no numbered-menu recipe, no `Enter to select`
// footer, and — the part that bit us — no input box at the tail. Before this grammar existed, none
// of the specific detectors claimed the `/model` picker, so Collie showed no buttons, `dialogPresent`
// stayed false, and a composer send typed the user's message straight INTO the picker.
//
// What makes a generic claim safe is that the screen NAMES ITS OWN KEYS: the footer is a
// `·`-separated list of "<key> to <verb>" hints ("Enter to set as default · s to use this session
// only · Esc to cancel"). We up-level exactly those hints into buttons, plus the arrow navigation the
// region advertises. We invent nothing.
//
// DIGITS ARE NEVER SYNTHESISED (.adr/0009). Live-probed 2026-08-05: pressing a digit in the `/model`
// picker confirms instantly AND writes the choice to the user's default for new sessions. A digit is
// therefore an unrecoverable, unprompted-for side effect on a screen whose semantics we do not know —
// so this grammar only ever emits keys the screen itself printed, plus the arrows that move a
// highlight.
//
// Pure functions over `StyledLine[]`, tail-anchored exactly like prompt-select.ts: the footer must be
// the LAST non-blank line, so a picker that has scrolled up simply doesn't match.
//
// THIS FILE IS THE REFERENCE IMPLEMENTATION OF THE GENERIC MODAL CONTRACT, not its definition. The
// model (../menu-model.ts) and the harness-agnostic derivation — footer-hint parsing, the key
// whitelist, label capitalisation, the arrow-row grammar and key constants (../menu-hints.ts) — are
// shared, so another adapter implements menus by supplying its OWN conventions only: where its region
// starts (Claude: the nearest rule/border above the footer), what its tail is, and how it knows an
// input box is on screen (Claude: ./chrome). See HARNESS_CONTRIBUTING.md → "Menus (generic modals)".

import type { StyledLine } from "../../blocks";
import { hasInputBox } from "./chrome";
import { classifyFooter, isBlank, isBoxBorder, isHorizontalRule, lineText } from "./markers";
import { regionSignature } from "./prompt-select";
import type { MenuModel, MenuNav } from "../menu-model";
import { MENU_ARROW_ROW, parseKeyHintFooter } from "../menu-hints";

/** The detection result buildBlocks needs: the model plus `startLine`, the index of the region's
 *  opening rule. Everything above it stays raw. */
export interface MenuRegion {
  model: MenuModel;
  startLine: number;
}

// The pointer glyph marking the currently-highlighted row — its presence is what makes Up/Down
// meaningful (without a highlight there is nothing to move).
const POINTER = "❯";

// How far above the footer to look for the region's opening rule. Generous enough for a tall picker,
// bounded so a borderless buffer can't be claimed unboundedly — no rule within the window, no match.
const REGION_SCAN_WINDOW = 30;

// The edges of a rounded box drawn INSIDE a picker (the `/resume` search field). Both are made of
// rule glyphs end to end, so `isHorizontalRule` would claim either as the region's top; the scan
// treats the pair as one opaque row instead.
const INNER_BOX_BOTTOM = /^╰─+╯$/;
const INNER_BOX_TOP = /^╭─+╮$/;

/**
 * Detect a generic menu at the tail of `lines`. Returns the model + its start line, or null.
 *
 * Ordered bails, cheapest and most decisive first:
 *   1. the last non-blank line must parse as a key-hint footer;
 *   2. `classifyFooter` must NOT claim it — the known dialog families keep their own grammars, which
 *      encode verified keystroke recipes this one cannot reproduce;
 *   3. there must be NO input box at the tail — a normal prompt screen whose statusline happens to
 *      read like hints is not a modal, and claiming it would put fake buttons under a live composer;
 *   4. a full-width rule / box border must sit within REGION_SCAN_WINDOW above the footer, and carry
 *      a non-blank title line under it.
 *
 * Pure; the caller owns pane access.
 */
export function detectMenuRegion(lines: StyledLine[]): MenuRegion | null {
  const texts = lines.map(lineText);

  let fi = texts.length - 1;
  while (fi >= 0 && isBlank(texts[fi]!)) fi--;
  if (fi < 0) return null;

  const footer = texts[fi]!;
  if (classifyFooter(footer) !== null) return null;
  const actions = parseKeyHintFooter(footer);
  if (actions.length === 0) return null;
  if (hasInputBox(lines)) return null;

  // The region's top: the nearest rule/border above the footer. The picker draws one full-width rule
  // across the screen where its modal begins, which is the only structural boundary it offers.
  let top = -1;
  for (let i = fi - 1, seen = 0; i >= 0 && seen < REGION_SCAN_WINDOW; i--, seen++) {
    // FORK: a rounded box CLOSED inside the picker is content, not its edge — the `/resume` picker
    // draws a `╭ ⌕ Search… ╮` field between its title and its rows, and the box's bottom edge is all
    // rule glyphs, so it read as the region's top and the title became the project label under it.
    // Skip to above the box's top edge and keep looking for the rule the modal actually opened with.
    if (INNER_BOX_BOTTOM.test(texts[i]!.trim())) {
      let j = i - 1;
      while (j >= 0 && i - j < REGION_SCAN_WINDOW && !INNER_BOX_TOP.test(texts[j]!.trim())) j--;
      if (j < 0 || !INNER_BOX_TOP.test(texts[j]!.trim())) return null;
      seen += i - j;
      i = j;
      continue;
    }
    if (isBoxBorder(texts[i]!) || isHorizontalRule(texts[i]!)) {
      top = i;
      break;
    }
  }
  if (top < 0) return null;

  // Title = the first non-blank line under the rule. A rule with nothing but the footer beneath it
  // is not a menu we can name, so bail rather than render an untitled panel.
  let title = "";
  for (let i = top + 1; i < fi; i++) {
    if (!isBlank(texts[i]!)) {
      title = texts[i]!.trim();
      break;
    }
  }
  if (title === "") return null;

  // Affordances advertised INSIDE the region (never assumed): a highlighted row means Up/Down do
  // something; an "←/→ to adjust" row means Left/Right do, and names what.
  const nav: MenuNav = { upDown: false };
  for (let i = top + 1; i < fi; i++) {
    const t = texts[i]!;
    if (t.includes(POINTER)) nav.upDown = true;
    if (nav.leftRight === undefined) {
      const arrow = MENU_ARROW_ROW.exec(t);
      if (arrow) nav.leftRight = { verb: arrow[2]!.trim(), label: arrow[1]!.trim() };
    }
  }

  // FORK — ENTER ON A HIGHLIGHT. Claude's pickers are Ink select lists: the `❯` row is what Enter
  // commits, and some of them never say so. The `/resume` session picker (2.1.267) names its side
  // keys and Esc — `Ctrl+B to only show current branch · Space to preview · Ctrl+R to rename · Type
  // to search · Esc to cancel` — and nothing that selects; at phone widths that footer also WRAPS, so
  // the last line the grammar reads is `search · Esc to cancel`. Lifting only what was named gave a
  // menu the operator could move through and never leave except by cancelling (2026-09-11).
  //
  // So when the region advertised a highlight and the footer named no Enter, one is supplied, FIRST —
  // it is the action the arrows exist for. This is not the digit .adr/0009 bans: a digit in `/model`
  // confirms AND rewrites the default; Enter commits the row the operator has visibly moved the
  // highlight to, and nothing more. A footer that does name Enter keeps its own verb ("Set as
  // default") and gets no second one.
  if (nav.upDown && !actions.some((a) => a.keys.includes("Enter"))) {
    actions.unshift({ label: "Select", keys: ["Enter"], select: true });
  }

  return {
    model: { title, actions, nav, signature: regionSignature(texts, top, fi) },
    startLine: top,
  };
}

/** Detect a generic menu at the tail of `lines`, returning just the model (or null) — the thin
 *  matcher the race guard re-derives with, and the one tests assert on. */
export function detectMenu(lines: StyledLine[]): MenuModel | null {
  return detectMenuRegion(lines)?.model ?? null;
}
