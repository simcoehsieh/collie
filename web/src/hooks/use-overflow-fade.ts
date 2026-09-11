import { useCallback, useRef } from "react";

// FORK: "there is more this way", as an attribute a stylesheet can act on.
//
// A horizontal scroller that overflows cuts its last child mid-glyph at the viewport edge, which
// reads as broken layout rather than as more content — the tab strip's "shell" sliced in half under
// the collapse chevron. The fix is a mask that dissolves the edge instead, and the whole reason this
// hook exists is that CSS cannot ask the question: there is no selector for "this element
// overflows", and a mask applied unconditionally fades the last tab of a row that fits, which is
// worse than the cut.
//
// WHY NOT SCROLL-DRIVEN ANIMATIONS. `animation-timeline: scroll(self inline)` answers it natively
// and for free — an inactive timeline means the animation is simply not applied, which is exactly
// the "only when it overflows" behaviour. Safari shipped it in 26; this app's own phone is on iOS
// 18, where it does not exist and the mask would never appear. So the attribute, and the day that
// floor moves the rule in skin.css can be rewritten to a timeline and this file deleted.
//
// It writes `data-overflow="start" | "end" | "both"` and never re-renders: the value is a paint
// decision, so it goes straight onto the DOM node. A state hook here would re-render the whole strip
// on every scroll frame.
//
// THE ATTRIBUTE IS REMOVED, not set to a falsy string, when the row fits — `[data-overflow]` is then
// an honest selector and the fitting case costs no rule at all.

/** One px of slack, deliberately. Sub-pixel layout leaves `scrollWidth` a hair over `clientWidth` on
 *  rows that do not actually scroll, and a row masked on both edges for half a pixel of phantom
 *  overflow is the exact failure this is meant to prevent. */
const SLACK = 1;

/**
 * A ref callback for a horizontally scrolling element. Attach it and the element carries
 * `data-overflow` whenever it has somewhere to scroll, saying which end has more.
 *
 * Watches three things, because a strip changes size for three different reasons: the viewport
 * (ResizeObserver on the element), the content (MutationObserver — a tab opening or closing does not
 * resize the scroller, so the resize observer alone would miss it), and the scroll position itself.
 */
export function useOverflowFade<T extends HTMLElement>() {
  const teardown = useRef<(() => void) | null>(null);
  return useCallback((el: T | null) => {
    teardown.current?.();
    teardown.current = null;
    if (el === null) return;

    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      if (max <= SLACK) {
        el.removeAttribute("data-overflow");
        return;
      }
      const atStart = el.scrollLeft <= SLACK;
      const atEnd = el.scrollLeft >= max - SLACK;
      el.setAttribute("data-overflow", atStart ? "end" : atEnd ? "start" : "both");
    };

    update();
    el.addEventListener("scroll", update, { passive: true });
    // `in window`, the same feature probe collie-home.tsx uses for `getAnimations`: the question
    // is whether this DOM implementation HAS the constructor — jsdom under test does not have
    // ResizeObserver — which is a fact about the object and not about the shape of a value. Absent,
    // the strip is simply never re-measured, which is correct: nothing in a test resizes.
    const ro = "ResizeObserver" in window ? new ResizeObserver(update) : null;
    ro?.observe(el);
    const mo = "MutationObserver" in window ? new MutationObserver(update) : null;
    mo?.observe(el, { childList: true, subtree: true, characterData: true });

    teardown.current = () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, []);
}
