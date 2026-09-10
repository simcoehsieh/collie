import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { dashPrefs } from "@/hooks/use-dash-prefs";
import { hasDocument, hasWindow } from "@/lib/env";
import { paneScope } from "@/lib/hosts";
import type { HomeData } from "@/lib/loaders";
import { homePath, panePath, settingsPath } from "@/lib/nav";
import { overviewPath } from "@/lib/overview";
import { triage } from "@/lib/triage";

// FORK: keyboard shortcuts for a desk. The app is phone-first by charter and upstream has none —
// but the same PWA sits in a browser tab beside the terminal all day, and there a mouse trip to a
// row is the slow way. Vim-shaped where there is a convention (j/k, g-then-letter), the app's own
// where there is not (a digit opens the nth pane in the dashboard's order).
//
// ── WHEN THEY ARE LIVE ──────────────────────────────────────────────────────────────────────────
// Only with a fine pointer (`(pointer: fine)` — a mouse or trackpad), so a phone with a Bluetooth
// keyboard attached is left alone: its on-screen composer is the one that would eat a stray `j`.
// And never while the operator is TYPING: any input, textarea, select or contenteditable target
// is passed through untouched, the composer included. The one exception is ⌘K / Ctrl+K, which
// is a chord no field wants and which the palette should answer from anywhere on the pane.
//
// ── HOW A ROW IS "SELECTED" ─────────────────────────────────────────────────────────────────────
// Focus, not a store. Every pane row on the dashboard and every card on the overview carries
// `data-pane-row`; j/k move the browser's focus between them in document order, and Enter is then
// the button's own activation — no second code path for "open the selected row", and the focus
// ring is the selection's only rendering, which is also the accessible one.

/** The two-key window for `g` chords. */
export const CHORD_MS = 800;

/** Whether this device has a fine pointer — the gate on the whole feature. */
export function finePointer(): boolean {
  if (!hasWindow() || window.matchMedia === undefined) return false;
  try {
    return window.matchMedia("(pointer: fine)").matches;
  } catch {
    return false;
  }
}

/** Whether a key event is aimed at something that takes text. */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.closest('[contenteditable=""], [contenteditable="true"]') !== null;
}

/** The dashboard's order, flattened — what a digit indexes into. */
export function paneOrder(data: HomeData | undefined) {
  if (!data) return [];
  return triage(data.agents, dashPrefs().recentDir, dashPrefs().pinned).flatMap((s) => s.agents);
}

/** The pane rows on the page, in document order. */
function rows(): HTMLElement[] {
  if (!hasDocument()) return [];
  return [...document.querySelectorAll<HTMLElement>("[data-pane-row]")];
}

/** Move focus one row from wherever it is; from nowhere, `+1` lands on the first row. */
export function stepRow(delta: -1 | 1): boolean {
  const list = rows();
  if (list.length === 0) return false;
  const at = list.findIndex((el) => el === document.activeElement);
  const next = at < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, at + delta));
  const el = list[next];
  if (!el) return false;
  el.focus();
  el.scrollIntoView?.({ block: "nearest" });
  return true;
}

/** The event the command palette listens for (components/command-palette.tsx). */
export const PALETTE_EVENT = "collie:palette";

export interface UseHotkeysReturn {
  /** The "?" cheat sheet is open. */
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
}

/**
 * Install the shortcuts for the life of the root layout. `data` is the root snapshot — the
 * digit shortcuts index into its order — and `enabled` is the fine-pointer gate, overridable so a
 * test can drive the handler without a `matchMedia`.
 */
export function useHotkeys(data: HomeData | undefined, enabled: boolean = finePointer()): UseHotkeysReturn {
  const navigate = useNavigate();
  const [helpOpen, setHelpOpen] = useState(false);
  const dataRef = useRef(data);
  dataRef.current = data;
  const helpRef = useRef(helpOpen);
  helpRef.current = helpOpen;
  // A `g` seen less than CHORD_MS ago, waiting for its second key.
  const chordAt = useRef(0);

  useEffect(() => {
    if (!enabled || !hasDocument()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const meta = e.metaKey || e.ctrlKey;
      // ⌘K / Ctrl+K — answered from anywhere, the composer included.
      if (meta && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent(PALETTE_EVENT));
        return;
      }
      if (meta || e.altKey) return;
      if (isEditable(e.target)) {
        // The one thing a field may hand back: Escape releases it.
        if (e.key === "Escape" && e.target instanceof HTMLElement) e.target.blur();
        return;
      }
      const d = dataRef.current;
      const scope = d?.scope;
      const now = Date.now();
      const chorded = now - chordAt.current < CHORD_MS;
      chordAt.current = 0;

      if (chorded) {
        switch (e.key) {
          case "o":
            e.preventDefault();
            navigate(overviewPath(scope));
            return;
          case "h":
            e.preventDefault();
            navigate(homePath(scope));
            return;
          case "s":
            e.preventDefault();
            navigate(settingsPath(scope));
            return;
          default:
          // Not a chord — fall through and read the key on its own.
        }
      }

      switch (e.key) {
        case "g":
          chordAt.current = now;
          return;
        case "j":
          if (stepRow(1)) e.preventDefault();
          return;
        case "k":
          if (stepRow(-1)) e.preventDefault();
          return;
        case "/": {
          const input = document.querySelector<HTMLElement>('[data-slot="chat-input"]');
          if (input) {
            e.preventDefault();
            input.focus();
          }
          return;
        }
        case "?":
          e.preventDefault();
          setHelpOpen(!helpRef.current);
          return;
        case "Escape":
          if (helpRef.current) {
            e.preventDefault();
            setHelpOpen(false);
          } else if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
          }
          return;
        default:
      }
      if (/^[1-9]$/.test(e.key) && d) {
        const pane = paneOrder(d)[Number(e.key) - 1];
        if (!pane) return;
        e.preventDefault();
        navigate(panePath(pane.paneId, paneScope(d.scope, pane, d.servers, d.sessions)));
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled, navigate]);

  return { helpOpen, setHelpOpen };
}
