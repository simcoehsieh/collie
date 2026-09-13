import { useCallback, useEffect, useState } from "react";

import { getNotifyPrefs, setNotifyPrefs, type NotifyPrefs } from "@/lib/api";
import { mutate } from "@/lib/mutate";
import type { PaneNotifyRule } from "@/lib/types";

// Settings-page controller for the bridge-wide notification-type prefs (which agent statuses push).
// Loads once on mount; a toggle is optimistic — flip the switch immediately, POST the single-key
// partial, and revert on failure — so it feels instant. These prefs live on the bridge and fan out
// to every device (like the snooze), so there's nothing per-device to persist locally.
//
// FORK: the same controller carries the per-pane rule list (`panes`). A rule edit posts the WHOLE
// list — the bridge replaces it rather than merging, because the phone edits the list it was shown.

/** The three switches — the keys a `toggle` may name. */
export type NotifySwitch = "blocked" | "done" | "updates";

export function useNotifyPrefs() {
  const [prefs, setPrefs] = useState<NotifyPrefs | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    getNotifyPrefs()
      .then((p) => alive && setPrefs(p))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // The switch flipping under the thumb is the echo — it says the tap was taken — and the reconcile
  // below is what makes it honest, because the server's merged view is the last word.
  //
  // THE REVERT MUST SPEAK. It used to flip back in silence, and a silent revert is worse than no
  // optimism at all: the switch moves twice with no cause the operator can see, and the second move
  // is invisible to anyone who has already stopped looking at this row — scrolled on, locked the
  // phone, put it in a pocket. What they carry away is the state they saw first, which is the one
  // that did not happen. So the revert and an error status land together; the status channel is the
  // only surface that survives the operator leaving this screen.
  const toggle = useCallback(async (key: NotifySwitch, next: boolean) => {
    setPrefs((prev) => (prev ? { ...prev, [key]: next } : prev)); // optimistic
    setBusy(true);
    const res = await mutate(() => setNotifyPrefs({ [key]: next }));
    if (res.ok) setPrefs(res.value); // reconcile with the server's merged view
    else setPrefs((prev) => (prev ? { ...prev, [key]: !next } : prev)); // revert, and `mutate` said why
    setBusy(false);
  }, []);

  /** FORK: replace the per-pane rule list. Optimistic like `toggle`, reverting to the list that was
   *  shown when the bridge refuses. */
  const setPanes = useCallback(async (panes: PaneNotifyRule[]) => {
    let before: PaneNotifyRule[] | undefined;
    setPrefs((prev) => {
      if (!prev) return prev;
      before = prev.panes ?? [];
      return { ...prev, panes };
    });
    setBusy(true);
    const res = await mutate(() => setNotifyPrefs({ panes }));
    if (res.ok) setPrefs(res.value);
    else setPrefs((prev) => (prev ? { ...prev, panes: before ?? [] } : prev));
    setBusy(false);
  }, []);

  return { prefs, busy, toggle, setPanes };
}
