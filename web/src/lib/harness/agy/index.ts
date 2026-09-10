// The Antigravity (agy) adapter. Chrome/status/draft are Tier 1: the rule-framed `>` composer and
// the status row under it are stripped from the mirror and re-surfaced natively. Interactive kinds,
// every one with dated captures (web/src/fixtures/panes/agy--*.txt) and a probed recipe
// (web/src/lib/grammar/AGY_NOTES.md):
//
//   * `prompt-select` — ask_user_question single choice, tool permissions, folder trust, plan
//     approval. A DIGIT ALONE answers (selects and submits, or selects and advances a step of a
//     multi-question call); the old digit-then-Enter recipe was measured to double-answer.
//   * `multi-select` — ask_user_question with `is_multi_select`: a digit toggles, Enter submits the
//     set from any option row (`submitKeys`), the focused Write-in field is refused to raw.
//   * `menu` — `/model`, `/permissions` and kin: only the keys the `Keyboard:` footer names.
//   * `autocomplete` — the slash-completion popup, keyless, with the box live under it.
//
// A multi-question call is NOT a `wizard`: agy paints it as one `Question k/N:` select after
// another with no stepper, so each step lifts as prompt-select and the digit advances. There is no
// `preview-select` (the tool schema has no preview field) and no paste placeholder (a paste is
// inserted literally, lines and all) — see AGY_NOTES.md.
//
// Registered under the two agent strings Herdr reports for the same binary. Exact match only (#99).

import { trimTrailingBlank, type Block, type StyledLine } from "../../blocks";
import type { HarnessAdapter } from "../types";
import { detectPromptSelectRegion } from "./prompt-select";
import { detectMultiSelectRegion } from "./multi-select";
import { detectMenuRegion } from "./menu";
import { detectAutocompleteRegion } from "./autocomplete";
import { extractInputDraft, extractStatusLines, hasInputBox, stripChrome } from "./chrome";

function withRawAbove(lines: StyledLine[], startLine: number, block: Block): Block[] {
  const before = trimTrailingBlank(lines.slice(0, startLine));
  const blocks: Block[] = [];
  if (before.length > 0) blocks.push({ kind: "raw", lines: before });
  blocks.push(block);
  return blocks;
}

export function agyBuildBlocks(lines: StyledLine[]): Block[] {
  // Most specific first: the checkbox footer is unique to multi-select; prompt-select's footer
  // families come next; the generic menu only ever catches what those two declined.
  const multi = detectMultiSelectRegion(lines);
  if (multi) {
    return withRawAbove(lines, multi.startLine, {
      kind: "multi-select",
      multi: multi.model,
      lines: lines.slice(multi.startLine),
    });
  }

  const region = detectPromptSelectRegion(lines);
  if (region) {
    return withRawAbove(lines, region.startLine, {
      kind: "prompt-select",
      prompt: region.model,
      lines: lines.slice(region.startLine),
    });
  }

  const menu = detectMenuRegion(lines);
  if (menu) {
    return withRawAbove(lines, menu.startLine, {
      kind: "menu",
      menu: menu.model,
      lines: lines.slice(menu.startLine),
    });
  }

  // The completion popup is the one non-raw block that is not a dialog: gated on the box being on
  // screen, which `hasInputBox` can only answer once its locator has peeled this very run.
  if (hasInputBox(lines)) {
    const auto = detectAutocompleteRegion(lines);
    if (auto) {
      const before = trimTrailingBlank(stripChrome(lines));
      const blocks: Block[] = [];
      if (before.length > 0) blocks.push({ kind: "raw", lines: before });
      blocks.push({ kind: "autocomplete", autocomplete: auto.model, lines: lines.slice(auto.startLine) });
      return blocks;
    }
  }

  return [{ kind: "raw", lines: stripChrome(lines) }];
}

export { extractStatusLines, extractInputDraft };

export const agyAdapter: HarnessAdapter = {
  agent: "agy",
  buildBlocks: agyBuildBlocks,
  extractStatusLines,
  extractInputDraft,
  composerReady: hasInputBox,
};

export const antigravityAdapter: HarnessAdapter = {
  agent: "antigravity",
  buildBlocks: agyBuildBlocks,
  extractStatusLines,
  extractInputDraft,
  composerReady: hasInputBox,
};
