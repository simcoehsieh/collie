# Antigravity (agy) TUI Choreography & Keystroke Notes

Empirical findings from driving live Antigravity CLI (`agy`) sessions in sandbox panes through Herdr / the
Collie bridge, captured byte-for-byte (`GET /api/pane/:id?lines=N`) into `web/src/fixtures/panes/agy--*.txt`.
Ground truth behind `web/src/lib/harness/agy/`.

Two corpora: **1.1.17** (2026-08-26: idle/working/done, select, permission ×2, trust, plan) and **1.2.0**
(2026-09-10: multi-select ×3, wizard steps ×2, `/model` + `/permissions` menus, the slash popup, the `?`
overlay, a multi-line draft). Every recipe below was re-probed on 1.2.0.

## Screen anatomy

AGY frames its composer between full-width rules (`─` U+2500) and paints a status row beneath
(`? for shortcuts … <model> · <effort>`, or `esc to cancel …` mid-turn). A dialog sits ABOVE the status
row and ends in its own `·`-separated hint row; a modal (`/model`, `/permissions`, `?`) ends in a
`Keyboard:`-prefixed hint row with a blank row between it and the status row.

```
Question 1/2: Which color?                 ← the question header (k/N even for one question)
> 1. Red                                   ← `>` pointer, single digit, label
  2. Green
  3. Blue
  4. Write-in...                           ← free-text row: never a button
  ↑/↓ Navigate · enter Select · esc Skip   ← hint row (classifyFooter → family)
esc to cancel                    Gemini 3.8 Flash · high
```

## Keystroke recipes — all probed on 1.2.0, 2026-09-10

| Screen | Footer discriminator | Emitted | Measured effect |
|---|---|---|---|
| ask_user_question, single choice (`select`) | `enter Select` | `[digit]` | The digit selects **and submits**. `2` on "Pick a fruit" answered Banana and the turn continued. **`[digit, Enter]` is wrong**: the Enter lands after the dialog is gone (an empty composer submit on a single question; on a multi-question call it chose the NEXT question's pointed default sight unseen). |
| multi-question call, step k/N (`select`) | `enter Select` (+ `← Back` from step 2) | `[digit]` | Selects **and advances** to `Question k+1/N`; on the last step it submits the whole set. No stepper, no review screen — each step is its own prompt-select, never a `wizard`. `Esc` skips the current question (`(skipped)` in the transcript). |
| tool permission (`permission`) | `tab Amend` | `[digit]` | Instant decision (1.1.17 probe; unchanged). |
| folder trust (`trust`) | `enter Confirm` | `[digit]` | Instant (1.1.17 probe; unchanged). |
| plan approval (`plan`) | `ctrl+r Review` | `[digit]` | It is an ask_user_question — the digit alone, as above. |
| multi-select (`is_multi_select`) | `space Toggle · enter Submit` | digit = toggle, `Enter` = submit | A **digit moves the pointer onto that row and toggles it**. `space` toggles the pointed row (not emitted). **`Enter` submits the set from any option row without toggling** — pressed with nothing checked it submitted the empty set. On the `Write-in...` row `Enter` instead opens a text field (`Your answer:` over `enter Submit · esc Back`) where every later key TYPES; that state is refused to raw and the direct-submit path nudges `Up` first. |
| `/model`, `/permissions` (menu) | `Keyboard: …` | only the footer's keys | `↑/↓` moves the highlight, `←/→ Effort` slides the effort marker, `enter Select`/`Save`, `esc Go Back`/`Close`. Digits do nothing we measured and are never sent (.adr/0009). |
| slash popup (autocomplete) | `↑/↓ Navigate · enter Select · tab Complete` | none | The box is live under it; typing keeps filtering. Lifted as a keyless list. |
| `?` shortcuts overlay | `Keyboard: ↑/↓ Navigate  ←/→ Switch View  esc Close` | none (raw) | No rule anchors it within the scan window; stays raw with the composer refused (no box at the tail). |

## What agy does not have

- **No paste placeholder.** A 40-line paste is inserted literally; the box grows a row per line and
  `extractInputDraft` space-joins them. `ctrl+u` clears ONE line per press.
- **No preview variant.** The tool's own schema (printed by the agent): `questions[].{question, options[],
  is_multi_select}` plus `toolAction`/`toolSummary`. Nothing carries a preview.
- **No stepper.** See the multi-question row above.

## Fail-closed rules the detectors keep

- A dialog lifts only when its hint row is the last non-blank line or the one above the status row;
  output scrolled beneath it → raw.
- Numbered lists without a dialog footer (`/skills`, markdown) → raw; a numbering that is not `1..m`
  → raw; `m > 9` → raw (no single-digit key).
- The multi-select's focused Write-in field, and any `Your answer:` row → raw.
- A menu needs a rule/border within 30 rows above its footer and a title under it; a footer written in
  another harness's `<key> to <verb>` grammar, or with any token the whitelist cannot map, is not agy's.
