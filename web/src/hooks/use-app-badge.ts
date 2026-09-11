import { useEffect, useMemo } from "react";

import { applyBadge, attentionCount, browserBadge, type BadgeSink } from "@/lib/app-badge";
import type { AgentView } from "@/lib/types";

// FORK — keep the app icon's badge equal to what needs you, while the app is open.
//
// The service worker sets the badge when a push arrives (sw.ts `applyBadge`), with the count the
// bridge knew then. That count goes stale the moment you read the pane, and on iOS no retraction
// ever arrives to correct it (bridge/push.ts skips Apple's endpoints for clears). So the open app
// is the corrector: every snapshot re-derives the count (lib/app-badge.ts) and writes it, which
// clears the dot the moment nothing is unseen. Mounted once, at the data root.
//
// `sink` is the test seam; the app passes nothing and gets the browser's own API, resolved once.

export function useAppBadge(agents: readonly AgentView[], sink?: BadgeSink | null): void {
  const resolved = useMemo(() => (sink === undefined ? browserBadge() : sink), [sink]);
  const count = attentionCount(agents);
  useEffect(() => {
    if (resolved === null) return;
    void applyBadge(resolved, count);
  }, [resolved, count]);
}
