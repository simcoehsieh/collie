import { useCallback, useInsertionEffect, useRef } from "react";

// FORK. A function whose IDENTITY never changes and whose BODY is always the latest render's.
//
// The strips and the list on the pane screen are memo()'d, and a memo is only as good as its
// props: a handler written inline at the call site is a new function every render, so the child
// re-renders on every poll tick whether or not anything it shows has changed. Pulling each of
// those handlers into a `useCallback` with a correct dependency list would mean threading a dozen
// values through it, and getting one wrong is a stale closure that reads like a bug on a phone.
//
// This is the `useEffectEvent` shape: the ref is written in an insertion effect (before any layout
// effect or child effect of the same commit can call it) and the returned function reads it at call
// time. Do not call the result during render — it exists for event handlers, and its whole
// contract is that the render that created it has committed.
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn);
  useInsertionEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: A) => latest.current(...args), []);
}
