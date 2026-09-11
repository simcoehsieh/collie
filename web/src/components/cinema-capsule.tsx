import { MeowMark } from "@/components/meow-mark";
import { StatusDot } from "@/components/status-badge";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";
import type { AgentStatus } from "@/lib/types";

// FORK — CINEMA MODE'S ONE REMAINING PIECE OF CHROME.
//
// A pane screen spends ~180px of an 844px phone on chrome before the terminal starts: header (64) +
// tab strip (56) + pane strip (56). Much of it is redundant — the header already reads
// `collie › docs`, and the SPACES strip repeats what that breadcrumb says. Cinema mode folds all
// three away and leaves the mirror the glass, edge to edge.
//
// What cannot go is the answer to "what am I looking at, and is it alright" — a full-screen terminal
// with no attribution is indistinguishable from a terminal emulator, and a pane that goes blocked
// while its status dot is folded away is a notification the operator never sees. So the chrome
// reduces to this: the mark, the dot, the name, 28px tall, floating over the mirror's top-left
// corner. Which is also what the mark itself IS — a terminal window with something peeking over the
// corner of it. Cinema mode is the app becoming its own logo.
//
// TOP-LEFT and not top-right, unlike zen's exit button: zen is entered from the ⋮ in the top-right
// and leaves from the same corner, so a re-aim is never needed. Cinema is entered from the grab
// handle at the BOTTOM, so there is no corner to match — and the left is where this app's identity
// already lives on every other screen (the header's home button), so the capsule lands where the eye
// already looks for it.
//
// It is a button, and the whole capsule is the tap target: `h-7` is 28px drawn, and the tap floor is
// bought the way the strips buy theirs — a transparent inset that extends the hit box without
// drawing a pixel, because a control floating over a terminal must not take 44px of the thing it is
// floating over.
export function CinemaCapsule({
  name,
  status,
  onExit,
}: {
  /** The pane's display name — the one fact the folded breadcrumb still owes the reader. */
  name: string;
  /** Undefined for a shell pane, which has no agent status to report. */
  status?: AgentStatus;
  onExit: () => void;
}) {
  useLocale();
  return (
    <button
      type="button"
      onClick={onExit}
      aria-label={t("chat.cinema.exitAria")}
      className="absolute left-3 top-3 z-20 flex h-7 max-w-[60%] items-center gap-1.5 rounded-full border border-rule bg-chrome/90 pl-1.5 pr-2.5 text-xs font-medium text-muted-foreground backdrop-blur-sm transition-colors before:absolute before:-inset-2 before:content-[''] active:bg-muted/60"
    >
      {/* Decorative: the capsule's accessible name already says what this is and what tapping it
          does. `paper` is the ground the mark's knockout cuts against — this capsule's own fill. */}
      <MeowMark size={18} weight="header" paper="var(--chrome)" />
      {status !== undefined && <StatusDot status={status} surface="bg-chrome" live />}
      <span className="min-w-0 truncate">{name}</span>
    </button>
  );
}
