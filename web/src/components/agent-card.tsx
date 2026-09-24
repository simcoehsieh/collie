import { memo, useState } from "react";
import { Check, Pin, TerminalSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { UnseenMark } from "@/components/ui/unseen-mark";
import { Card } from "@/components/ui/card";
import { ShellBadge, StatusBadge, StatusDot } from "@/components/status-badge";
import { AgentIcon } from "@/components/agent-icon";
import { PaneMeta } from "@/components/pane-meta";
import { PaneHint } from "@/components/pane-hint";
import { timeAgoShort } from "@/lib/format";
import { paneCwdLine, paneName, panePlaceParts, soleTabName } from "@/lib/pane-name";
import { canonicalAgent } from "@/lib/operator-scope";
import { statusLabel } from "@/lib/types";
import type { AgentView } from "@/lib/types";
import { useLocale } from "@/hooks/use-locale";
import { useActionEcho } from "@/hooks/use-action-echo";
import { useLongPress } from "@/hooks/use-long-press";
import { usePromptPeek } from "@/hooks/use-prompt-peek";
import { buzz } from "@/lib/haptics";
import { t } from "@/lib/i18n";

interface AgentCardProps {
  agent: AgentView;
  /** The tap. Handed the row's own button, which is the glide's origin when `glideKey` is set. */
  onClick: (row: HTMLButtonElement) => void;
  /**
   * The row as a glide origin (lib/glide.ts, the `pane` pair): the pane's own path, `panePath`,
   * which the pane header's back arrow spells the same way to find this row again. Unset, the row
   * takes no part in a glide.
   */
  glideKey?: string;
  /** The finger landed on the row: the moment to start the pane's read (lib/pane-prefetch.ts). */
  onPress?: () => void;
  /**
   * Where the row is being shown. "herd" (default) is a flat list across every space, so line 2
   * carries the place. "tab" is a list already grouped under its space and tab, so line 2 is the
   * path alone. "place" is the dashboard's grouped list, where the heading above already says the
   * WORKSPACE, so line 2 carries the tab alone — and carries nothing at all when that tab has no
   * name of its own, in a slot that keeps its height either way. Line 1 is the pane's name in all
   * three.
   */
  scope?: "herd" | "tab" | "place";
  /**
   * How to show status. "badge" (default) spells it out. "dot" is for a list already GROUPED by
   * status — the section heading says "Working", so eighteen rows repeating it in a pill buys
   * nothing and costs a third of the row's width, which is exactly the width the title needs.
   */
  statusStyle?: "badge" | "dot";
  /**
   * "card" (default) is the bordered, shadowed treatment. "row" is flat — no border, no shadow,
   * separated by a hairline instead.
   *
   * Card chrome on 100% of rows is wallpaper, not emphasis: a Working row and a Recent row rendered
   * pixel-identically, throwing away the four-level priority `triage()` had just computed. Reserving
   * the card for the sections that mean "a human is required here" makes the shape itself carry the
   * signal — see a card, something wants you; all flat, nothing does.
   */
  density?: "card" | "row";
  /** FORK: the row is one the operator pinned — draws the pin glyph in the trailing column. */
  pinned?: boolean;
  /** FORK: a long press on the row (the dashboard's pin sheet). Absent = the row has no hold. */
  onLongPress?: () => void;
  /**
   * A finished pane the operator hasn't opened yet — see `isUnseen()` (lib/triage.ts). Only the
   * "Ready · unseen" section passes it; every other row leaves it at the default. Draws a small
   * filled dot right after the name, on line 1, so a glance at a compact row still tells it apart
   * from an ordinary finished pane sitting in its workspace group.
   */
  unseen?: boolean;
  /**
   * The dashboard trial's louder in-place mark (variant 5): a flat row that needs you, or is
   * finished and unseen, takes a full-row wash in its status colour, 10 percent, in place of the
   * 5 percent blocked tint alone. The row is the mark; nothing on its edge and nothing moves.
   */
  tint?: boolean;
}

/** The row's text: line 1's name, and line 2's two runs. */
interface RowLines {
  primary: string;
  /** Line 2's first run — the space, in a herd row. Null when there is none. */
  detailLead: string | null;
  /** Line 2's second run, which takes the remaining width — the tab, in a herd row. */
  detailTail: string | null;
  /** The tail is a path (mono, data) rather than a tab or a space (app face). */
  tailMono: boolean;
  /** The tail is the tab's POSITION, not its name (`tabTitle`'s `positional`) — drawn a shade
   *  lighter so it never reads as a name the operator chose. */
  tailPositional: boolean;
}

// ── FORK: WHAT THE AGENT SAYS IT IS DOING ────────────────────────────────────
//
// One sentence the agent wrote about itself (`collie beacon status "<line>"`, bridge/beacon/
// status-line.ts). It is CONTENT, not chrome — the words are the agent's — so it wears
// `font-content` (DESIGN.md § "Chrome wears the app face"), and it is text the row does not
// interpret: nothing branches on it, and a pane that has one sorts, badges and opens exactly as it
// did before.
//
// STALE IS DIMMED AND NEVER HIDDEN, which is the whole of the freshness rule. An agent that said
// "running the migration" forty minutes ago is still telling you the most useful thing anyone knows
// about that pane; a row that emptied itself would only make you wonder whether the feature broke.
// So the row keeps the sentence and adds its age, and the pair reads as "this was true, then".

/** How old a line may be before the row says so. Mirrors `STATUS_LINE_FRESH_MS` bridge-side. */
const STATUS_LINE_FRESH_MS = 15 * 60 * 1000;

function StatusLine({ line, at }: { line?: string; at?: number }) {
  if (!line) return null;
  const stale = at !== undefined && Date.now() - at > STATUS_LINE_FRESH_MS;
  return (
    <p
      data-slot="agent-status-line"
      className={cn(
        "mt-1 flex items-baseline gap-1.5 overflow-hidden text-xs leading-snug",
        stale ? "text-muted-foreground/60" : "text-muted-foreground",
      )}
    >
      {/* Truncated, not wrapped, for the reason PaneHint states: a list holds one row pitch, and a
          sentence that wrapped would make its row taller than every other for no visible reason.
          `title` keeps the whole of it a hover away on a desktop. */}
      <span className="min-w-0 truncate font-content" title={line}>
        {line}
      </span>
      {stale && at !== undefined && (
        <span className="shrink-0 tabular-nums">{t("agentCard.statusLine.stale", { age: timeAgoShort(at) })}</span>
      )}
    </p>
  );
}

// FORK — which model and effort the agent is on, as one small monospace run under the address line.
// The same standing as the status line above it in the source: text, never a branch. It sits in the
// row's muted register because it is a fact about the pane, not the pane's subject — the name is.
// A pane row, used by the triage home and the space view. Usually an agent; for a bare shell pane
// (kind:"shell") it shows a terminal glyph and a muted "shell" tag instead of a status badge.
//
// ── THE ROW LEADS WITH THE PANE'S NAME, AND THE PLACE SITS BENEATH ───────────
// Line 1 is the pane's NAME (lib/pane-name.ts), in the row's one bold run, taking the whole width.
// Line 2 is its PLACE, `space › tab`, muted and small. The name is the only fact on the row that is
// unique to it: the space repeats across every one of an eight-pane project's rows, and the tab name
// repeats across projects. So the name gets the weight and the width, and the place goes beneath it
// as context — you read what the work is, then where it lives. Every other surface answers the same
// two questions the same way round.
//
// The tile shrank with the same argument. At `size-9` it was a 36px column on every row of a list
// where every row is the same agent, so it carried no information and pushed both lines 44px right.
// At `size-4` it rides inline on line 1 as a mark beside the title, and the row's text starts
// where the row starts. That is the SAME size and the same shell tile the pane header wears
// (`agent-chat.tsx`), which is the other place the agent's mark stands beside a name — one size for
// one role, so the two surfaces cannot drift apart.
//
// The two parts of line 2 render as separate spans on purpose: at 390px a joined string truncates
// from the right, which would eat the tab and leave every row of a project reading the same nine
// characters of its space. The space gives up width first and the tab takes what is left.
// FORK: memoised. The dashboard re-renders every poll tick; a row whose `agent` object is the same
// reference as last tick has nothing new to paint. `onClick` is deliberately left OUT of the
// comparison — every caller passes an inline `() => onOpen(a)`, a new function each render that
// does the same thing for the same `a`, and comparing it would defeat the memo on every tick. The
// bargain: a caller that changes what "open this row" MEANS without changing any other prop is not
// re-rendered; no caller does that (the scope a row opens into is fixed by the list it is in).
export const AgentCard = memo(AgentCardImpl, (a, b) =>
  a.agent === b.agent &&
  a.scope === b.scope &&
  a.statusStyle === b.statusStyle &&
  a.density === b.density &&
  a.pinned === b.pinned &&
  // Presence only, like `onClick`: the dashboard's hold handler is an inline arrow too.
  (a.onLongPress === undefined) === (b.onLongPress === undefined),
);

function AgentCardImpl({
  agent,
  onClick,
  glideKey,
  onPress,
  scope = "herd",
  statusStyle = "badge",
  density = "card",
  pinned = false,
  onLongPress,
  unseen = false,
  tint = false,
}: AgentCardProps) {
  useLocale();
  // FORK: the hold that opens the dashboard's pin sheet. Inert when no handler is passed (the
  // hook's own contract), so the space view and the sidebar rows are byte-for-byte what they were.
  const hold = useLongPress(onLongPress);
  const isShell = agent.kind === "shell";
  const blocked = agent.status === "blocked";
  const inTab = scope === "tab";
  // ── THE WORKSPACE-GROUPED ROW CARRIES ITS TAB, AT ONE HEIGHT ─────────────────
  // Under a WORKSPACE heading (lib/pane-groups.ts) line 2 has one fact left worth saying: the tab.
  // The workspace is the heading and the cwd is the same cwd down most of a project, but the tab is
  // what tells two rows of one workspace apart — so line 2 is the tab's name, and when the
  // multiplexer only numbered that tab (`isUnnamedTab`), it reads that number instead: `tab 2`, in
  // the lighter ink. When the raw label carries no number at all, the slot is skipped outright and
  // the row's own `items-center` puts the name in the middle of the 44px row instead.
  //
  // The slot is always 16px when it renders, and the row STATES its own height rather than letting
  // its contents set it: `h-11`, 44px, the app's touch floor, holding a 20px line over a 16px slot
  // with no vertical padding of its own. Every row of every group is that height whether its tab
  // carries a name, a position, or neither, so nothing in the list can move (DESIGN.md §2). The
  // bridge's hint stays off the row for the same reason — it is a sentence, and a sentence has no
  // height anyone can state.
  //
  // The trailing meta rides the name line, same as every other scope — `PaneMeta`, at the end of
  // line 1, in the 12px box the pane header's workspace line already gives it — so it never adds a
  // slot of its own and can't set this row's stated height. The hint is still on the pane screen,
  // which is where a sentence belongs.
  const inPlace = scope === "place";
  const flat = density === "row";
  // FORK: DOES THIS ROW HAVE MORE THAN TWO LINES TO SAY?
  //
  // Upstream's flat row states its height (`h-11 py-0` below) because upstream's flat row is exactly
  // two lines — the name and the place — and a stated pitch is what makes a list of them read as one
  // list. This fork's row can carry two more: the agent's OWN sentence about what it is working on
  // (`collie beacon status`) and the model·effort the bridge read off its log. On a herd where four
  // rows all read `claude · working`, that sentence is the only thing that says which one to open,
  // so it is not a candidate for withholding the way upstream withholds `PaneHint` here.
  //
  // So the height is stated only while the row IS two lines. A row with something more to say grows
  // to fit it instead of clipping it through a stated box — which is what 1.9.0's merge did on the
  // first phone that saw it: `opus-5 · medium` ran out under the group's own border.
  // FORK: THE ROW DOES NOT NAME THE MODEL. It did, twice — a line of its own, then a run at the end
  // of the name line — and the operator's answer was that the agent's own icon already says which
  // agent this is, and that is what a glance at the dashboard is asking. The model and the effort
  // still stand on the PANE's own header, where the question "which model is this one on" is
  // actually being asked (agent-chat.tsx, `data-slot="header-model"`).
  //
  // What CAN still make this row a third line is the agent's own sentence (`collie beacon status`):
  // that is a sentence, it is the only thing that tells four `claude · working` rows apart, and it
  // does not fit on a line that already carries a name, a reading and an address.
  const saysMore = (agent.statusLine ?? "") !== "";
  // ONE NAME, ONE PLACE (lib/pane-name.ts). Line 1 is what the pane is CALLED, on every row of
  // every list; line 2 is WHERE it sits. In a tab-scoped list the place is already established by
  // the space heading and the per-tab section above, so line 2 is the path instead — the one fact
  // that still tells two panes in one tab apart.
  const place = panePlaceParts(agent);
  // When the tab's own name IS the pane's name (a named one-pane tab, pane-name.ts § soleTabName),
  // line 2 would repeat it; it carries the title Claude writes instead, so that stays in sight.
  const nameIsTab = soleTabName(agent) !== null && paneName(agent) === soleTabName(agent);
  const liveTitle = agent.terminalTitle && agent.terminalTitleStale !== true ? agent.terminalTitle : null;
  const lines: RowLines = inPlace
    ? {
        primary: paneName(agent),
        detailLead: null,
        detailTail: nameIsTab ? liveTitle : (place.tab?.text ?? null),
        tailMono: false,
        tailPositional: nameIsTab ? false : (place.tab?.positional ?? false),
      }
    : inTab
      ? {
          primary: paneName(agent),
          detailLead: null,
          detailTail: paneCwdLine(agent),
          tailMono: true,
          tailPositional: false,
        }
      : {
          primary: paneName(agent),
          detailLead: place.space,
          detailTail: place.tab?.text ?? null,
          tailMono: false,
          tailPositional: place.tab?.positional ?? false,
        };
  const { detailLead } = lines;
  // FORK: A TAB NAMED AFTER THE HARNESS SAYS NOTHING THE ICON HAS NOT SAID. Tabs here are opened by
  // `launchers.toml`, so they are called `claude`, `codex`, `agy` — and line 2 then repeated, in
  // words, the tile sitting on line 1. The operator's call (2026-09-15): drop it. A tab with a name
  // of its own (`develop`, `review`) is untouched, because that one IS an address; only the run
  // that matches the pane's own agent, canonicalised so `claude-code` folds onto `claude`, is
  // withheld. A row left with nothing on line 2 falls through to the same centred-name treatment a
  // nameless tab already had.
  const tailNamesTheAgent =
    lines.detailTail !== null &&
    canonicalAgent(lines.detailTail.trim().toLowerCase()) === canonicalAgent(agent.agent?.toLowerCase() ?? "") &&
    canonicalAgent(agent.agent?.toLowerCase() ?? "") !== "";
  const withheldTail = tailNamesTheAgent ? null : lines.detailTail;
  // FORK: AND NEITHER DOES LINE 1 (2026-09-16, after upstream's 1.10.0 naming rule).
  //
  // A pane opened from `launchers.toml` sits in a tab called `claude`, so the pane is CALLED
  // `claude` — and the row then spent line 1 saying, in words, what the tile beside it already
  // said in a picture, while the one thing that tells two of them apart (the title the agent
  // writes for itself) sat on line 2 in grey. Two rows, four lines, and the only two that
  // mattered were the small grey ones.
  //
  // So when the name IS the harness's own name and there is a real title underneath, the title
  // MOVES UP and line 2 goes away: one line per pane, saying the one thing the icon cannot.
  // A pane with a name of its own (`/rename`, a named tab, a pane label) never enters this branch
  // and keeps both lines. This is the operator's standing shape for the dashboard row — see the
  // note in FORK.md; an upstream merge that reintroduces a second line has to be re-grafted onto
  // it, not accepted as-is.
  const primaryNamesTheAgent =
    canonicalAgent(lines.primary.trim().toLowerCase()) === canonicalAgent(agent.agent?.toLowerCase() ?? "") &&
    canonicalAgent(agent.agent?.toLowerCase() ?? "") !== "";
  // Only the TITLE is promoted. In a tab-scoped list line 2 is the pane's path, which is an address
  // rather than a name and belongs underneath; `withheldTail === liveTitle` is that distinction.
  const promoteTail = primaryNamesTheAgent && withheldTail !== null && withheldTail === liveTitle;
  const primary = promoteTail && withheldTail !== null ? withheldTail : lines.primary;
  const detailTail = promoteTail ? null : withheldTail;
  // A workspace-grouped row whose tab has no name of its own reads its position instead — `tab 2` —
  // via `tabTitle` (`lib/pane-name.ts`) — or, when the raw label carries no digit at all, nothing:
  // the slot is then skipped outright.
  const skipBlankSlot = inPlace && detailTail === null;
  // The dot leads line 1, INLINE, ahead of the tile — not on the tile's corner. The corner was
  // right at `size-9`: a 10px badge on a 36px tile is a badge. On a 16px tile it is most of the
  // artwork, and shrinking it to fit kills the one glance cue the row has — the resting states are
  // hollow rings drawn with a 1.5px border, which at 8px is nearly a solid disc and stops telling
  // idle from working. Inline it keeps full size, still sits against its subject, and a list of rows
  // lines its dots up in one column at the left edge, which is how the list is actually scanned.
  const cornerDot = statusStyle === "dot" && !isShell;

  const Shell = flat ? "div" : Card;
  // FORK: the yes/no dialog waiting in a blocked pane, when there is one to answer from here.
  const { peek, answered, answer } = usePromptPeek(agent);

  // ── FORK: THE SHELL IS OUTSIDE THE BUTTON, NOT INSIDE IT ─────────────────
  // Upstream nests the card chrome inside one full-width <button>. A blocked row now carries two
  // buttons of its own beneath the title (Approve / Deny), and a button inside a button is not
  // HTML — iOS in particular delivers the tap to whichever it likes. So the chrome moved out to a
  // wrapper and the row's own tap target is a <button> INSIDE it, followed by the approve strip as
  // a sibling. Same classes, same padding, same anatomy (`data-slot`s unchanged); the press scale
  // rides on the wrapper via `:has()` so the whole card still dips under the thumb.
  return (
    <Shell
      className={cn(
        "w-full transition-transform [&:has(>button:active)]:scale-[0.99]",
        // 14px, the same as the card's own padding. A flat row now sits inside a 1px-bordered
        // ListGroup, so its content lands on the same x as a card row's content BY CONSTRUCTION
        // (14 + 1 on both sides) — the hand-computed 15px this replaced was faking exactly that
        // alignment against a group that had no border to supply the 1px. The rail below is a
        // box-shadow, which takes no room, so the number still holds.
        //
        // No radius on a flat row, in ANY state. These sit in a `divide-y` list, and a rounded fill
        // under a full-width straight hairline reads as a rendering fault — the corners pull away
        // from a line that doesn't follow them. Corners belong to where the row sits, never to what
        // it is doing, so a blocked flat row stays square too and takes a left rail instead.
        flat
          ? "shadow-[inset_2px_0_0_0_transparent] transition-colors hover:bg-muted/50"
          : "gap-0 rounded-xl py-0 shadow-card",
        // The blocked tint survives both treatments — it's the one cue that reads at a glance.
        // The EDGE cannot: one class string, two containers. A card sits in a gap list and already
        // carries a border in every state, so it only recolours. A flat row sits in a divide-y
        // list, where a four-sided edge would double the hairline — and where a bare colour
        // utility paints nothing at all, because preflight leaves the width at 0. So the flat row
        // takes a 2px left rail, reserved transparent above so the box never changes.
        blocked &&
          (flat
            ? "bg-status-blocked/5 shadow-[inset_2px_0_0_0_var(--color-status-blocked)]"
            : "border-status-blocked/40 bg-status-blocked/5"),
      )}
    >
      <button
        type="button"
        // Upstream hands the tap its own button (the glide's origin); the fork's button is this inner
        // one, so the glide attributes and the press ride here rather than on the Shell.
        onClick={(e) => onClick(e.currentTarget)}
        // FORK: the hook needs the iOS callout and selection off the element it times (see its
        // note); `data-pane-row` is what the desktop hotkeys walk with j/k (hooks/use-hotkeys.ts).
        {...hold}
        // After the spread, so the long-press timer and upstream's prefetch both hear the press.
        onPointerDown={(e) => {
          hold.onPointerDown(e);
          onPress?.();
        }}
        data-glide-origin={glideKey === undefined ? undefined : "pane"}
        data-glide-key={glideKey}
        data-pane-row={agent.paneId}
        className={cn(
          // FORK: the button IS the row box here (upstream nests `button > Shell`, this fork nests
          // `Shell > button` so the long press lands on the element the pitch is stated on), so it
          // carries what upstream's button carried: full width, and TEXT LEFT — a `<button>` centres
          // its text by default, and losing this line in the 1.9.0 merge centred every row's second
          // line under its name.
          "w-full text-left",
          onLongPress !== undefined && "select-none [-webkit-touch-callout:none]",
          // 14px, the same as the card's own padding. A flat row now sits inside a 1px-bordered
          // ListGroup, so its content lands on the same x as a card row's content BY CONSTRUCTION
          // (14 + 1 on both sides) — the hand-computed 15px this replaced was faking exactly that
          // alignment against a group that had no border to supply the 1px.
          flat
            ? "flex flex-row items-center gap-3 px-3.5 py-2.5"
            : "flex-row items-center gap-3 rounded-xl px-3.5 py-3 shadow-sm",
          // Every flat row states its own pitch — `py-0` because the height IS the statement, and
          // the flat row's own `py-2.5` around two lines would make it 56px and the number would
          // stop being a number. Was `inPlace`-only; keyed on `flat` now (2026-09-14) so an urgent
          // row (`scope="herd"`, `density="row"`) gets the same 44px as a workspace-grouped one —
          // the two are meant to read as the SAME kind of row (agent-list.tsx's urgent section).
          flat && !saysMore && "h-11 py-0",
          // …and when it does say more, the row keeps the flat row's own padding and grows.
          flat && saysMore && "py-2",
          // The blocked TINT survives both treatments — it's the one cue that reads at a glance.
          // A card sits in a gap list and already carries a border in every state, so it only
          // recolours. A flat row sits in a divide-y list, where a four-sided edge would double the
          // hairline — it used to take a 2px left rail instead, which read as the thick-left-border
          // accent the design rules ban (removed 2026-09-14): status on a flat row is carried by the
          // dot (`cornerDot`) and this tint alone, nothing on the edge.
          blocked && (flat ? "bg-status-blocked/5" : "border-status-blocked/40 bg-status-blocked/5"),
          tint && flat && blocked && "bg-status-blocked/10",
        )}
      >
        <div className="min-w-0 flex-1">
          {/* LINE 1 IS THE NAME, AND THE ADDRESS ENDS IT. The dot and the tile stay centred on the
              row's own line box — neither has a baseline worth chasing — but the name and the
              trailing meta share one, via `self-baseline` on each rather than `items-baseline` on
              the row: CSS computes that baseline group only over the children that ask for it and
              leaves the icons centred (`pane-meta.tsx`'s header explains the technique it borrows).
              The meta is `flex-none` by way of `PaneMeta`'s own `shrink-0`, so it never yields
              width before the name does, and it draws its own 12px box whether or not either chip
              inside it has anything to say — an empty reading leaves its space rather than pulling
              the row narrower (DESIGN.md §2). This closes the corner column's old fault: two fixed
              slots stacked beside a one- or two-line row read as three rows on a phone (Altan's
              phone feedback), and folding the address onto the name line answers it without losing
              the "a slot with nothing to say still holds its place" guarantee the column had. */}
          <div data-slot="agent-row-title" className="flex min-w-0 items-center gap-2">
            {cornerDot && (
              <StatusDot
                status={agent.status}
                // A hollow resting ring must be filled with the colour it actually sits on — a card
                // is `--card`, a flat row is the page.
                surface={flat ? "bg-background" : "bg-card"}
                glide="dot"
              />
            )}
            {/* An avatar is a FRAME around someone else's artwork, not a shape that means
                something, so this tile, the shell tile beside it and the same tile in
                `agent-chat.tsx` are all framed at the house radius — a circle would crop the
                artwork. Full-round stays RESERVED for things that are a circle in meaning: the
                status dot above, the switch thumb, round icon buttons. */}
            {/* The dot, the tile and the name are the three parts that fly into the pane header
                when the row opens it (`data-glide`, lib/glide.ts); they mean nothing otherwise. */}
            {isShell ? (
              <div data-glide="tile" className="flex size-4 shrink-0 items-center justify-center rounded-sm border bg-muted">
                <TerminalSquare className="size-2.5 text-muted-foreground" />
              </div>
            ) : (
              <AgentIcon agent={agent.agent} className="size-4" glide="tile" />
            )}
            {/* No longer `flex-1`: that let the name claim the whole line, which pushed the unseen
                dot all the way to the far end, beside the meta, instead of beside the NAME. It now
                sizes to its own text and only `min-w-0` lets it truncate below that — the dot still
                sits right after whatever survives the truncation. `PaneMeta`'s own `ml-auto` is what
                claims the row's spare width now, so it still lands at the end. */}
            <span data-glide="name" className="min-w-0 truncate self-baseline font-medium">
              {primary}
            </span>
            {/* A finished pane you haven't opened yet: the square (ui/unseen-mark.tsx). Right after
                the name, never before it, and its slot is reserved on a flat row so the name
                truncates at one width whether the mark is drawn or not. */}
            <UnseenMark on={unseen} reserve={flat} className="ml-2" />
            <PaneMeta
              host={agent.host}
              cache={agent.cache}
              session={agent.session}
              className="ml-auto self-baseline"
            />
            {/* FORK: the pin, muted and small — a mark that the row's place is chosen, not earned. It
                rides the END of the name line, where the row's other trailing marks now live: 1.9.0
                moved the meta here and dropped the trailing column this used to sit in. */}
            {pinned && (
              <Pin
                className="ml-1.5 size-3.5 shrink-0 self-center text-muted-foreground"
                aria-label={t("home.pin.pinned")}
              />
            )}
          </div>

          {/* Only rendered when there's something to say — a pane with neither a tab nor a name of
              its own is a one-line row. A workspace-grouped row is the exception: its slot is
              always there, holding the tab's name or its position — UNLESS neither is available,
              which skips the slot outright and centres the name in the 44px row instead. */}
          {!skipBlankSlot && (inPlace || detailLead !== null || detailTail !== null) && (
            <div
              data-slot="agent-row-detail"
              className={cn(
                "flex min-w-0 items-baseline gap-1 text-xs text-muted-foreground",
                // 16px whatever is in it, which is the slot half of the stated height above —
                // keyed on `flat` for the same reason the height above is.
                flat && "h-4 items-center",
              )}
            >
              {inPlace && lines.tailPositional && detailTail !== null ? (
                // The unnamed tab's position, a shade lighter than an ordinary tab name so it never
                // reads as one.
                <span className="min-w-0 flex-1 truncate text-muted-foreground/70">
                  {detailTail}
                </span>
              ) : (
                <>
                  {/* Both runs of the address are plainly muted — line 2 is one fact in two parts,
                      and weighting either half turns it back into a competition with line 1. The
                      space gives up width first; the tab takes the rest. A positional tail (`tab
                      2`) takes the same shade-lighter ink here as it does alone above. */}
                  {detailLead !== null && (
                    <span className="min-w-0 shrink truncate">{detailLead}</span>
                  )}
                  {detailLead !== null && detailTail !== null && (
                    // The place's own separator, the same glyph the joined form uses (PLACE_SEP): a
                    // crumb, because a space CONTAINS a tab. A middot would read as two peers.
                    <span className="shrink-0 text-muted-foreground/60" aria-hidden>
                      ›
                    </span>
                  )}
                  {detailTail !== null && (
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate",
                        lines.tailMono && "font-mono",
                        lines.tailPositional && "text-muted-foreground/70",
                      )}
                    >
                      {detailTail}
                    </span>
                  )}
                </>
              )}
            </div>
          )}

          {/* FORK: the AGENT's own sentence about what it is working on (`collie beacon status`),
              under the name it belongs to. Same standing as the bridge's hint below it — text, never
              a branch — and it is placed above because it is the more specific of the two: the hint
              describes a pane Collie is guessing at, this one is the pane telling you itself. */}
          <StatusLine line={agent.statusLine} at={agent.statusLineAt} />


          {/* The bridge's own sentence about this pane, when it sent one — text, never a branch
              (components/pane-hint.tsx). It changes nothing about the row: a hinted pane is still a
              shell, still sorts where an unknown status sorts, and still opens the same view.
              Withheld on any flat row, whose height is stated; see `flat` above. */}
          {!flat && <PaneHint hint={agent.hint} />}
        </div>

        {isShell ? (
          <ShellBadge />
        ) : cornerDot ? (
          /* The dot itself is colour-only and lives on line 1; give SR users the word. */
          <span className="sr-only">{statusLabel(agent.status)}</span>
        ) : (
          <StatusBadge status={agent.status} />
        )}
      </button>

      {peek !== null && (
        <ApproveStrip
          question={peek.prompt.question}
          yesLabel={peek.choice.yes.label}
          noLabel={peek.choice.no.label}
          flat={flat}
          answered={answered}
          onAnswer={answer}
        />
      )}
    </Shell>
  );
}

// ── FORK: Approve / Deny beneath a blocked row ──────────────────────────────
// Two small buttons and the dialog's own question, so the operator knows WHAT they are saying yes
// to before they say it. The keystrokes are the option's own (lib/prompt-approve.ts picks the plain
// Yes and the No off the pane's grammar; hooks/use-prompt-peek.ts sends them through the same
// guarded path the pane view uses). Press echo + haptic on the way out; the outcome lands as one
// short word beside the buttons, because a row has no status channel of its own.
function ApproveStrip({
  question,
  yesLabel,
  noLabel,
  flat,
  answered,
  onAnswer,
}: {
  question: string;
  yesLabel: string;
  noLabel: string;
  flat: boolean;
  /** Which button already went out for this dialog; both are disabled once one has. */
  answered: "yes" | "no" | null;
  onAnswer: (which: "yes" | "no") => Promise<{ status: "sent" | "changed" | "error"; error?: string }>;
}) {
  const echo = useActionEcho();
  const [note, setNote] = useState<"sent" | "changed" | "failed" | null>(null);
  const locked = echo.pending || answered !== null;

  const run = (which: "yes" | "no") =>
    echo.run(which, async () => {
      buzz();
      const result = await onAnswer(which);
      setNote(result.status === "sent" ? "sent" : result.status === "changed" ? "changed" : "failed");
      return result.status === "sent";
    });

  return (
    <div
      data-slot="agent-row-approve"
      className={cn("flex flex-col gap-2", flat ? "px-3.5 pb-2.5" : "px-4 pb-3.5")}
    >
      {question !== "" && (
        <p className="line-clamp-2 text-xs text-muted-foreground" title={question}>
          {question}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={locked}
          onClick={() => void run("yes")}
          aria-label={`${t("agentCard.approve.yes")}: ${yesLabel}`}
          title={yesLabel}
        >
          {echo.phaseOf("yes") === "done" || answered === "yes" ? <Check /> : t("agentCard.approve.yes")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={locked}
          onClick={() => void run("no")}
          aria-label={`${t("agentCard.approve.no")}: ${noLabel}`}
          title={noLabel}
        >
          {echo.phaseOf("no") === "done" || answered === "no" ? <Check /> : t("agentCard.approve.no")}
        </Button>
        {note !== null && (
          <span className="text-xs text-muted-foreground" role="status">
            {t(`agentCard.approve.${note}`)}
          </span>
        )}
      </div>
    </div>
  );
}
