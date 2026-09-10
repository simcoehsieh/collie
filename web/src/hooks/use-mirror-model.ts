import { useMemo } from "react";

import { parseAnsi } from "@/lib/ansi";
import { splitLines, type Block, type StyledLine } from "@/lib/blocks";
import { buildBlocks } from "@/lib/harness";

/** The mirror, parsed ONCE: its styled lines and the Block AST the pane's adapter built over them. */
export interface MirrorModel {
  lines: StyledLine[];
  blocks: Block[];
}

// FORK. One parse of the mirror per change of the mirror.
//
// The pane screen used to parse the same `display` string FOUR times on every tick it moved: the
// statusline probe, the stranded-draft probe and the dialog probe in agent-chat each ran
// `splitLines(parseAnsi(display))` in their own `useMemo`, the dialog probe ran a full `buildBlocks`
// on top, and then AnsiOutput parsed and built the blocks a second time to render them. Every one
// of those memos was correctly keyed on `display`, so no render was wasted — the PARSES were: four
// ANSI decodes of up to 600 lines and two grammar passes, per poll, exactly while an agent is
// streaming and the string changes every second.
//
// This hook is the one parse. agent-chat derives its three probes from `lines` / `blocks` and hands
// the same objects to AnsiOutput, which renders them instead of re-deriving them from `text`. The
// adapter is chosen the way AnsiOutput chose it — by the `agent` it is given, `undefined` when the
// grammars are off — so the probes and the render can never disagree about which grammar ran.
export function useMirrorModel(display: string, agent: string | undefined): MirrorModel {
  const lines = useMemo(() => splitLines(parseAnsi(display)), [display]);
  const blocks = useMemo(() => buildBlocks(lines, { agent }), [lines, agent]);
  return useMemo(() => ({ lines, blocks }), [lines, blocks]);
}
