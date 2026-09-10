import { useSyncExternalStore } from "react";

import { getLocaleSnapshot } from "@/lib/i18n";

// FORK: the phone's half of TEXT-TO-SPEECH — the mirror image of lib/stt.ts. Speech-to-text was
// fully built (the mic, `/api/stt`, hands-free), which left the loop half closed: you could talk to
// an agent from across the room and then had to walk over to read what it said. This is the other
// half, on `speechSynthesis` alone — no provider, no upload, nothing leaves the phone.
//
// TWO SETTINGS' WORTH OF STATE, ONE PERSISTED. `readAloud` (persisted, per device) is the switch
// under hands-free in Settings: while it AND hands-free are on, each new reply is spoken as it
// lands (hooks/use-latest-reply.ts). `speaking` is live state for the speaker button on the reply
// card, so a tap can stop what is playing.
//
// iOS WILL NOT SPEAK UNTIL A TAP HAS ASKED IT TO. The first `speak()` must run inside a user
// gesture; after that the page may speak on its own. `prime()` is that first call — an empty
// utterance fired from the switch's own tap — and the auto-read path checks `primed` before it
// tries, so a phone that never tapped never queues speech that would silently not play.

const READ_ALOUD_KEY = "collie:tts-read-aloud:v1";

/** Whether this browser can speak at all. */
export function ttsSupported(): boolean {
  return globalThis.speechSynthesis !== undefined && globalThis.SpeechSynthesisUtterance !== undefined;
}

let readAloud = loadReadAloud();
let primed = false;
let speaking = false;
const listeners = new Set<() => void>();

function loadReadAloud(): boolean {
  try {
    return localStorage.getItem(READ_ALOUD_KEY) === "1";
  } catch {
    return false;
  }
}

function notify(): void {
  for (const fn of listeners) fn();
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function readAloudEnabled(): boolean {
  return readAloud;
}

export function setReadAloudEnabled(on: boolean): void {
  readAloud = on;
  try {
    localStorage.setItem(READ_ALOUD_KEY, on ? "1" : "0");
  } catch {
    // The in-memory value still applies for this session.
  }
  if (on) prime();
  else stop();
  notify();
}

export function useReadAloud(): boolean {
  return useSyncExternalStore(subscribe, readAloudEnabled, readAloudEnabled);
}

function isSpeaking(): boolean {
  return speaking;
}
export function useSpeaking(): boolean {
  return useSyncExternalStore(subscribe, isSpeaking, isSpeaking);
}

/** Whether a tap has unlocked speech on this page (see the header). */
export function ttsPrimed(): boolean {
  return primed;
}

/** Unlock speech from inside a user gesture. Harmless to call again. */
export function prime(): void {
  if (!ttsSupported() || primed) return;
  try {
    const u = new SpeechSynthesisUtterance("");
    u.volume = 0;
    speechSynthesis.speak(u);
    primed = true;
  } catch {
    // An engine that refuses the empty utterance is one that will refuse the real one too.
  }
}

/**
 * What of a reply is worth saying: fenced code is dropped (a read-out of a diff is noise),
 * inline code loses its ticks, markdown emphasis and headings lose their marks, and links keep
 * their text. Exported for the test.
 */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The BCP-47 tag the reply is spoken in: the app's own language, which is the operator's. */
function lang(): string {
  const locale = getLocaleSnapshot().locale;
  return locale === "zh" ? "zh-CN" : locale;
}

/**
 * Speak `text`, replacing whatever is playing. A no-op where speech is unsupported or the text
 * has nothing to say. Returns whether an utterance was queued.
 */
export function speak(text: string): boolean {
  if (!ttsSupported()) return false;
  const words = speakable(text);
  if (words === "") return false;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(words);
    u.lang = lang();
    const done = () => {
      speaking = false;
      notify();
    };
    u.addEventListener("end", done);
    u.addEventListener("error", done);
    speaking = true;
    primed = true;
    notify();
    speechSynthesis.speak(u);
    return true;
  } catch {
    speaking = false;
    notify();
    return false;
  }
}

/** Stop whatever is playing. Safe to call when nothing is. */
export function stop(): void {
  if (!ttsSupported()) return;
  try {
    speechSynthesis.cancel();
  } catch {
    // ignore
  }
  if (speaking) {
    speaking = false;
    notify();
  }
}

/** Test seam. */
export function __resetTts(): void {
  readAloud = false;
  primed = false;
  speaking = false;
  listeners.clear();
}
