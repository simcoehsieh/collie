import { memo, useState } from "react";
import { Check, Pin, TerminalSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ShellBadge, StatusBadge, StatusDot } from "@/components/status-badge";
import { AgentIcon } from "@/components/agent-icon";
import { HostChip } from "@/components/host-chip";
import { SessionChip } from "@/components/session-chip";
import { PaneHint } from "@/components/pane-hint";
import { timeAgoShort } from "@/lib/format";
import { paneParts, paneTitleInTab } from "@/lib/pane-name";
import type { PaneParts } from "@/lib/pane-name";
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
  onClick: () => void;
  /**
   * Show "how long ago" on the second line, and which timestamp it means: "seen" for the Recent
   * section (when you last opened it), "active" for Ready · unseen (when it finished). Omitted
   * elsewhere — a blocked agent's age is noise next to the fact that it's blocked.
   */
  age?: "seen" | "active";
  /**
   * Where the row is being shown. "herd" (default) is a flat list across every space, so line 1
   * carries the pane's own title and line 2 the address it sits at. "tab" is a list already grouped
   * under its space and tab, so line 2 is the path alone.
   */
  scope?: "herd" | "tab";
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
}

/** Which fact lands on which line, for a herd-scoped row. The pane's own name takes line 1, and
 *  line 2 becomes the address it sits at. Each fallback drops the fact it just promoted, so nothing
 *  is ever said twice, and a row with nothing but a space is one line. */
function herdLines(parts: PaneParts): RowLines {
  if (parts.secondary !== null)
    return { primary: parts.secondary, detailLead: parts.project, detailTail: parts.tab, tailMono: false };
  if (parts.tab !== null)
    return { primary: parts.tab, detailLead: parts.project, detailTail: null, tailMono: false };
  return { primary: parts.project, detailLead: null, detailTail: null, tailMono: false };
}

/** The row's age, in the trailing slot of whichever line it sits on. Not mono — it's a footnote,
 *  not data; mono made it read like the path it replaced. */
function Age({ at }: { at: number }) {
  return <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{timeAgoShort(at)}</span>;
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

// A pane row, used by the triage home and the space view. Usually an agent; for a bare shell pane
// (kind:"shell") it shows a terminal glyph and a muted "shell" tag instead of a status badge.
//
// ── THE ROW LEADS WITH THE PANE TITLE, AND THE ADDRESS SITS BENEATH ───────────
// Line 1 is the pane's own TITLE, in the row's one bold run, taking the whole width. Line 2 is
// `space · tab`, muted and small. The title is the only fact on the row that is unique to it: the
// space repeats across every one of an eight-pane project's rows, and the tab name repeats across
// projects. So the title gets the weight and the width, and the address goes beneath it as context —
// you read what the work is, then where it lives.
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
  a.age === b.age &&
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
  age,
  scope = "herd",
  statusStyle = "badge",
  density = "card",
  pinned = false,
  onLongPress,
}: AgentCardProps) {
  useLocale();
  // FORK: the hold that opens the dashboard's pin sheet. Inert when no handler is passed (the
  // hook's own contract), so the space view and the sidebar rows are byte-for-byte what they were.
  const hold = useLongPress(onLongPress);
  const isShell = agent.kind === "shell";
  const blocked = agent.status === "blocked";
  const inTab = scope === "tab";
  const flat = density === "row";
  const parts = paneParts(agent);
  const tabTitle = paneTitleInTab(agent);
  const stamp = age === "seen" ? agent.lastSeenAt : age === "active" ? agent.lastActiveAt : undefined;
  // Line 1's name, and line 2's two runs. In a tab-scoped list the space and the tab are already
  // established by the heading above, so line 2 is the path alone.
  const lines: RowLines = inTab
    ? { primary: tabTitle.primary, detailLead: null, detailTail: tabTitle.secondary, tailMono: true }
    : herdLines(parts);
  const { primary, detailLead, detailTail } = lines;
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
        onClick={onClick}
        // FORK: the hook needs the iOS callout and selection off the element it times (see its
        // note); `data-pane-row` is what the desktop hotkeys walk with j/k (hooks/use-hotkeys.ts).
        {...hold}
        data-pane-row={agent.paneId}
        className={cn(
          "flex w-full flex-row items-center gap-3 text-left",
          onLongPress !== undefined && "select-none [-webkit-touch-callout:none]",
          flat ? "px-3.5 py-2.5" : "px-4 py-3.5",
        )}
      >
        <div className="min-w-0 flex-1">
          <div data-slot="agent-row-title" className="flex min-w-0 items-center gap-2">
            {cornerDot && (
              <StatusDot
                status={agent.status}
                // A hollow resting ring must be filled with the colour it actually sits on — a card
                // is `--card`, a flat row is the page.
                surface={flat ? "bg-background" : "bg-card"}
              />
            )}
            {/* An avatar is a FRAME around someone else's artwork, not a shape that means
                something, so this tile, the shell tile beside it and the same tile in
                `agent-chat.tsx` are all framed at the house radius — a circle would crop the
                artwork. Full-round stays RESERVED for things that are a circle in meaning: the
                status dot above, the switch thumb, round icon buttons. */}
            {isShell ? (
              <div className="flex size-4 shrink-0 items-center justify-center rounded-sm border bg-muted">
                <TerminalSquare className="size-2.5 text-muted-foreground" />
              </div>
            ) : (
              <AgentIcon agent={agent.agent} className="size-4" />
            )}
            <span className="min-w-0 flex-1 truncate font-medium">{primary}</span>
          </div>

          {/* Only rendered when there's something to say — a pane with neither a tab nor a name of
              its own is a one-line row. */}
          {(detailLead !== null || detailTail !== null) && (
            <div
              data-slot="agent-row-detail"
              className="flex min-w-0 items-baseline gap-1 text-xs text-muted-foreground"
            >
              {/* Both runs of the address are plainly muted — line 2 is one fact in two parts, and
                  weighting either half turns it back into a competition with line 1. The space
                  gives up width first; the tab takes the rest. */}
              {detailLead !== null && <span className="min-w-0 shrink truncate">{detailLead}</span>}
              {detailLead !== null && detailTail !== null && (
                <span className="shrink-0 text-muted-foreground/60" aria-hidden>
                  ·
                </span>
              )}
              {detailTail !== null && (
                <span className={cn("min-w-0 flex-1 truncate", lines.tailMono && "font-mono")}>
                  {detailTail}
                </span>
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
              shell, still sorts where an unknown status sorts, and still opens the same view. */}
          <PaneHint hint={agent.hint} />
        </div>

        {/* The trailing meta is a COLUMN, not a tail on the title. Inside the title line the chip
            was 4px from a truncated word and competed with the discriminator for the same width;
            here the title takes its natural width, the detail line runs the full width beneath
            it, and the chip is centred against the whole row by the shell's own `items-center`.
            Costs no height — the row pitch is unchanged. HostChip self-hides: nothing renders
            unless the snapshot lists more than one machine (components/host-chip.tsx), so on a solo
            install this column collapses to the age alone, or to nothing. */}
        <div className="flex shrink-0 items-center gap-2">
          {/* The row's ADDRESS, both halves, in the order the address itself reads: which machine,
              then which session on it. Each self-hides — the host when there is no crew, the session
              when the row is in the primary one or the list was never widened — so on every install
              that exists today this column is still the age alone, or nothing. */}
          <HostChip host={agent.host} />
          <SessionChip session={agent.session} />
          {stamp !== undefined && <Age at={stamp} />}
          {/* FORK: the pin, muted and small — a mark that the row's place is chosen, not earned. */}
          {pinned && (
            <Pin className="size-3.5 shrink-0 text-muted-foreground" aria-label={t("home.pin.pinned")} />
          )}
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
