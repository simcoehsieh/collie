// FORK — the ONE spelling of "which model, at what effort" the app shows, so the herd card and the
// composer's status strip cannot drift. Both facts arrive as the harness's own strings
// (lib/types.ts `model` / `effort`) and go out as text; nothing branches on them.
//
// The label is the harness's id with one prefix trimmed, not a pretty name: `claude-fable-5-1`
// reads as `fable-5-1` because on a Claude pane the brand is already the tile beside it, and a
// mapping table from id to marketing name is a table that is wrong the week a model ships.

/** The two facts a pane may carry; the same optional pair `AgentView` has. */
export interface ModelFacts {
  model?: string;
  effort?: string;
}

/** The interpunct the app uses between two runs of one line — the herd row's `space · tab`. */
const JOIN = " · ";

/** `fable-5-1 · xhigh`, `gpt-6-astra · medium`, or one half alone; null when the pane carries neither. */
export function modelLabel(facts: ModelFacts): string | null {
  const parts: string[] = [];
  if (facts.model !== undefined && facts.model !== "") parts.push(shortModel(facts.model));
  if (facts.effort !== undefined && facts.effort !== "") parts.push(facts.effort);
  return parts.length === 0 ? null : parts.join(JOIN);
}

/** The vendor prefix Claude Code puts on every id, dropped; every other id is shown whole. */
function shortModel(model: string): string {
  return model.startsWith("claude-") ? model.slice("claude-".length) : model;
}
