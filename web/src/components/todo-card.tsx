import { Check, CircleDot, ListChecks, Square } from "lucide-react";

import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import type { TodoItem } from "@/lib/types";

// FORK — THE AGENT'S OWN CHECKLIST, as a card.
//
// One component, two mounts, and that is deliberate: the pane transcript PINS the latest plan at the
// top (so "where is it in the job" is answerable without scrolling), and the thread renders the same
// card in place wherever the agent re-planned (so the history of the plan is still history). A second
// component for the pinned copy would be two things to keep looking alike.
//
// It is CONTENT, not chrome (DESIGN.md § "Chrome wears the app face"): the words are the agent's, so
// the item text wears `font-content` and only the card's own label and count wear the app face.
//
// The three states get three different marks rather than three colours alone — a checklist read at
// arm's length on a phone has to survive both dark mode and a colour-blind reader, and `completed`
// additionally strikes its text through, which is the one cue that reads with no colour at all.

/** The per-state mark. `in_progress` is the only filled one — it is the row you are looking for. */
function Mark({ status }: { status: TodoItem["status"] }) {
  if (status === "completed") {
    return <Check className="mt-0.5 size-3.5 shrink-0 text-status-done" aria-hidden />;
  }
  if (status === "in_progress") {
    return <CircleDot className="mt-0.5 size-3.5 shrink-0 text-status-working" aria-hidden />;
  }
  return <Square className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />;
}

/**
 * A plan, rendered compactly.
 *
 * `pinned` is the header treatment only — the pinned copy says how far along the list is, because it
 * is standing in for a list you are not scrolled to; an in-thread copy is read in place and does not
 * need the count restated above it.
 */
export function TodoCard({
  items,
  pinned = false,
  className,
}: {
  items: readonly TodoItem[];
  pinned?: boolean;
  className?: string;
}) {
  if (items.length === 0) return null;
  const done = items.filter((item) => item.status === "completed").length;
  return (
    <div
      data-slot="todo-card"
      className={cn("rounded-md border bg-muted/40 px-2.5 py-2", className)}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <ListChecks className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {t("transcript.todo.title")}
        </span>
        {pinned && (
          <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
            {t("transcript.todo.progress", { done: String(done), total: String(items.length) })}
          </span>
        )}
      </div>
      <ul className="space-y-1">
        {items.map((item, i) => (
          // Index key: a plan is a positional snapshot re-derived from one tool input — there is no
          // identity to preserve across renders, and two items can carry the same words.
          <li key={i} className="flex items-start gap-1.5 text-xs leading-snug">
            <Mark status={item.status} />
            <span
              className={cn(
                "min-w-0 font-content",
                item.status === "completed" && "text-muted-foreground line-through",
                item.status === "in_progress" && "font-medium",
              )}
            >
              {item.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
