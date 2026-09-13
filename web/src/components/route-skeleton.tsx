import { Card } from "@/components/ui/card";
import { ListGroup } from "@/components/ui/list-group";
import { Skeleton, SkeletonScreen } from "@/components/ui/skeleton";

// FORK — THE FOUR SCREENS, DRAWN EMPTY.
//
// One file rather than a skeleton beside each route, and that is not laziness: `router.tsx` is
// where three of these are mounted, and a route's own module is exactly what has not arrived yet at
// the moment the fallback renders. Importing the shape from the lazy chunk would pull the chunk
// onto the cold-start path — which is the cost the lazy split was made to avoid in the first place
// (see router.tsx's own note). So the shapes live here, in the eager graph, costing a few hundred
// bytes.
//
// Each shape is measured against the screen it stands in for, not invented:
//   • a dashboard row is a card at px-4 py-3.5 around a 20px title line and a 16px detail line;
//   • Settings is a column of `Card`s with a 4px gutter, each a title line over a description;
//   • Crew is one card holding the formation;
//   • History is a run of transcript turns, long/short/long, in the reading column.
//
// When the real screen lands it lands ON these boxes, not next to them.

/** A dashboard/sidebar run of pane rows, card density — the shape `agent-list.tsx` draws. */
export function PaneRowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <SkeletonScreen className="flex flex-col gap-2 px-4 py-4">
      {Array.from({ length: rows }, (_, i) => (
        <Card key={i} className="gap-0 px-4 py-3.5">
          <div className="flex items-center gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex items-center gap-2">
                {/* The dot and the agent tile that lead every title line. */}
                <Skeleton className="size-2.5 shrink-0 rounded-full" />
                <Skeleton className="size-4 shrink-0 rounded-sm" />
                {/* Three different widths, because a column of identical bars reads as a pattern
                    rather than as names. */}
                <Skeleton className={`h-4 ${TITLE_WIDTHS[i % TITLE_WIDTHS.length]}`} />
              </div>
              <Skeleton className="h-3 w-1/3" />
            </div>
            <Skeleton className="h-3 w-8 shrink-0" />
          </div>
        </Card>
      ))}
    </SkeletonScreen>
  );
}

const TITLE_WIDTHS = ["w-2/5", "w-1/2", "w-1/3"] as const;

/** Settings: a column of cards, each an icon, a title line and a description line. */
export function SettingsSkeleton() {
  return (
    <SkeletonScreen className="mx-auto flex w-full max-w-screen-sm flex-col gap-4 p-4">
      {Array.from({ length: 5 }, (_, i) => (
        <Card key={i} className="gap-0 px-4 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <Skeleton className="mt-0.5 size-5 shrink-0" />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-3/5" />
              </div>
            </div>
            {/* The switch slot — the same h-6 w-11 the real rows reserve. */}
            <Skeleton className="h-6 w-11 shrink-0 rounded-full" />
          </div>
        </Card>
      ))}
    </SkeletonScreen>
  );
}

/** Crew: one card, the formation inside it. */
export function CrewSkeleton() {
  return (
    <SkeletonScreen className="mx-auto flex w-full max-w-screen-sm flex-col gap-4 p-4">
      <Card className="gap-0 px-4 py-4">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-4 w-1/4" />
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-3 w-2/5" />
        </div>
      </Card>
    </SkeletonScreen>
  );
}

/** History: a run of transcript turns in the reading column. */
export function HistorySkeleton() {
  return (
    <SkeletonScreen className="mx-auto flex w-full max-w-screen-md flex-col gap-4 p-4">
      <ListGroup>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2 px-3.5 py-3">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className={`h-4 ${TURN_WIDTHS[i % TURN_WIDTHS.length]}`} />
          </div>
        ))}
      </ListGroup>
    </SkeletonScreen>
  );
}

const TURN_WIDTHS = ["w-4/5", "w-2/3", "w-11/12"] as const;
