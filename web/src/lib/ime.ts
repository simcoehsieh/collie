// IS THIS KEYSTROKE THE IME'S, OR MINE?
//
// While an input method is composing — picking a 繁體中文 candidate, a Japanese conversion, a
// Korean syllable — the keys you press belong to the IME's candidate window, not to the app. Enter
// COMMITS the candidate. Up and Down move through the list. Escape cancels it. Every one of those
// is a key this app otherwise treats as an action, and acting on them steals the keystroke from the
// composition: the operator picks a word and the message sends with the word half-typed.
//
// Reported on the desktop composer, 2026-09-19: "when typing in Traditional Chinese, the first
// Enter confirms the candidate, but it sends the message".
//
// TWO PROBES, BECAUSE ONE IS NOT ENOUGH IN PRACTICE.
//
//   • `isComposing` is the standard answer and is true through the whole composition in every
//     modern engine — including on the Enter that commits, which is the case that matters here.
//
//   • `keyCode === 229` is the fallback for the ordering some IMEs use on Chromium, where
//     `compositionend` fires BEFORE the `keydown` of the committing Enter. `isComposing` is already
//     false by then and a composition-tracking ref has already been cleared, so the commit key
//     looks like an ordinary Enter — this is exactly the case both of those miss. 229 is the
//     "processed by IME" sentinel every engine still reports for it. `keyCode` is deprecated and
//     there is no replacement for this particular question; the standard one is the line above.
//
// Neither probe can be checked from React's synthetic event alone — `isComposing` lives on the
// native `KeyboardEvent` — so this takes the native event and the two call sites pass
// `event.nativeEvent`.

/**
 * Whether this keydown belongs to an input method's composition and must be left alone.
 *
 * Callers should `return` WITHOUT `preventDefault()`: the IME needs the event to reach the field.
 */
export function isComposingKey(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}
