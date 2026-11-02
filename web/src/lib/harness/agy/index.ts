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
//   * `menu` — upstream's 1.4.4–1.4.8 panels first (`/model` and its effort, the Conversations
//     picker, `/artifact` review and detail, and the modals of model.ts / modals.ts), each cut at
//     its status rows (`statusStartLine`); then, FORK, the generic `Keyboard:`-footer reader
//     (menu.ts, measured on 1.2.0) for whatever those decline: only the keys the footer names.
//   * `autocomplete` — the slash-completion popup, keyless, with the box live under it.
//
// A multi-question call is NOT a `wizard`: agy paints it as one `Question k/N:` select after
// another with no stepper, so each step lifts as prompt-select and the digit advances. There is no
// `preview-select` (the tool schema has no preview field) and no paste placeholder (a paste is
// inserted literally, lines and all) — see AGY_NOTES.md.
//
// Registered under the two agent strings Herdr reports for the same binary. Exact match only (#99).

import { trimTrailingBlank, type Block, type StyledLine } from "../../blocks";
import type { DialogDetector, HarnessAdapter } from "../types";
import { detectArtifactRegion } from "./artifact";
import { extractInputDraft, extractStatusLines, hasInputBox, normalizeAgyScreenRows, stripChrome } from "./chrome";
import { detectConversationsRegion } from "./conversations";
import { detectMultiSelectRegion } from "./multi-select";
import { detectMenuRegion } from "./menu";
import { detectAutocompleteRegion } from "./autocomplete";
import { lineText } from "./markers";
import { detectAgyModalRegion } from "./modals";
import { detectModelRegion } from "./model";
import { detectPromptSelectRegion } from "./prompt-select";

/** The conversations picker, read off the rows' text. */
function conversationsRegion(lines: StyledLine[]) {
  return detectConversationsRegion(lines.map((l) => lineText(l).trimEnd()));
}

/** The detectors `agyBuildBlocks` runs, in its order, for the unread-dialog card's report (ADR 0123).
 *  FORK: multi-select, the generic menu and the completion popup are the fork's own agy readers. */
const AGY_DIALOG_DETECTORS: readonly DialogDetector[] = [
  { name: "multi-select", detect: detectMultiSelectRegion },
  { name: "prompt-select", detect: detectPromptSelectRegion },
  { name: "model", detect: detectModelRegion },
  { name: "conversations", detect: conversationsRegion },
  { name: "artifact", detect: detectArtifactRegion },
  { name: "modal", detect: detectAgyModalRegion },
  { name: "menu", detect: detectMenuRegion },
  // FORK: the completion popup, under the same live-box gate `agyBuildBlocks` reads it behind.
  { name: "autocomplete", detect: (lines) => (hasInputBox(lines) ? detectAutocompleteRegion(lines) : null) },
];

function withRawAbove(lines: StyledLine[], startLine: number, block: Block): Block[] {
  const before = trimTrailingBlank(lines.slice(0, startLine));
  const blocks: Block[] = [];
  if (before.length > 0) blocks.push({ kind: "raw", lines: before });
  blocks.push(block);
  return blocks;
}

export function agyBuildBlocks(lines: StyledLine[]): Block[] {
  // Most specific first: the checkbox footer is unique to multi-select; prompt-select's footer
  // families come next; then upstream's named panels; the generic menu only ever catches what all
  // of those declined.
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

  // Upstream's measured 1.4.4–1.4.8 panels, each cut at its own status rows.
  const picker =
    detectModelRegion(lines) ??
    conversationsRegion(lines) ??
    detectArtifactRegion(lines) ??
    detectAgyModalRegion(lines);
  if (picker) {
    const before = trimTrailingBlank(lines.slice(0, picker.startLine));
    const blocks: Block[] = [];
    if (before.length > 0) blocks.push({ kind: "raw", lines: before });
    blocks.push({ kind: "menu", menu: picker.model, lines: lines.slice(picker.startLine, picker.statusStartLine) });
    return blocks;
  }

  // FORK: the generic footer reader, for a modal none of the above knows.
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
      // The popup's rows stop where the status rows start: the strip shows those (status-strip.test.ts,
      // "never doubles a row the blocks still show").
      const status = new Set(extractStatusLines(lines));
      const firstStatus = lines.findIndex((line, i) => i >= auto.startLine && status.has(line));
      const end = firstStatus === -1 ? lines.length : firstStatus;
      blocks.push({ kind: "autocomplete", autocomplete: auto.model, lines: lines.slice(auto.startLine, end) });
      return blocks;
    }
  }

  return [{ kind: "raw", lines: stripChrome(lines) }];
}

export { extractStatusLines, extractInputDraft, normalizeAgyScreenRows };

export const agyAdapter: HarnessAdapter = {
  agent: "agy",
  buildBlocks: agyBuildBlocks,
  extractStatusLines,
  extractInputDraft,
  composerReady: hasInputBox,
  // The way OUT of an AGY modal, for the unread-dialog card (.adr/0053). Its captures print the
  // Claude-style footer: `fixtures/panes/agy--permission-bash.txt`, `agy--permission-edit.txt`,
  // `agy--plan-approval.txt` and `agy--select-menu.txt` all print `esc to cancel`.
  cancelKey: "Escape",
  dialogDetectors: AGY_DIALOG_DETECTORS,
};

export const antigravityAdapter: HarnessAdapter = {
  agent: "antigravity",
  buildBlocks: agyBuildBlocks,
  extractStatusLines,
  extractInputDraft,
  composerReady: hasInputBox,
  // Same harness, same registration, same declaration — see `agyAdapter` above.
  cancelKey: "Escape",
  dialogDetectors: AGY_DIALOG_DETECTORS,
};
