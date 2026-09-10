import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetTts,
  prime,
  readAloudEnabled,
  setReadAloudEnabled,
  speak,
  speakable,
  stop,
  ttsPrimed,
  ttsSupported,
  useReadAloud,
  useSpeaking,
} from "./use-tts";

// FORK: text-to-speech on `speechSynthesis` alone. jsdom has none, so the engine is stubbed.

class FakeUtterance extends EventTarget {
  text: string;
  lang = "";
  volume = 1;
  constructor(text: string) {
    super();
    this.text = text;
  }
}
const spoken: FakeUtterance[] = [];
const synth = {
  speak: vi.fn((u: FakeUtterance) => spoken.push(u)),
  cancel: vi.fn(),
};

beforeEach(() => {
  spoken.length = 0;
  synth.speak.mockClear();
  synth.cancel.mockClear();
  vi.stubGlobal("speechSynthesis", synth);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  localStorage.clear();
  __resetTts();
});
afterEach(() => vi.unstubAllGlobals());

describe("speakable", () => {
  it("drops fenced code, unwraps inline code, links and emphasis, and collapses whitespace", () => {
    expect(speakable("Run `ls` now.\n```\nrm -rf /\n```\n**Done**, see [docs](http://x).")).toBe(
      "Run ls now. Done, see docs.",
    );
    expect(speakable("# Title\n- one\n- two")).toBe("Title one two");
  });
});

describe("speak / stop", () => {
  it("cancels what is playing, speaks the words in the app's language, and reports speaking", () => {
    expect(ttsSupported()).toBe(true);
    const { result } = renderHook(() => useSpeaking());
    act(() => {
      expect(speak("**Hello** there")).toBe(true);
    });
    expect(synth.cancel).toHaveBeenCalled();
    expect(spoken[0]!.text).toBe("Hello there");
    expect(spoken[0]!.lang).toBe("en");
    expect(result.current).toBe(true);
    act(() => {
      spoken[0]!.dispatchEvent(new Event("end"));
    });
    expect(result.current).toBe(false);
  });

  it("says nothing for an empty or code-only reply", () => {
    expect(speak("```\nx\n```")).toBe(false);
    expect(synth.speak).not.toHaveBeenCalled();
  });

  it("stop cancels and clears the flag", () => {
    const { result } = renderHook(() => useSpeaking());
    act(() => {
      speak("words");
    });
    act(() => stop());
    expect(synth.cancel).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(false);
  });

  it("is a no-op without an engine", () => {
    vi.stubGlobal("speechSynthesis", undefined);
    expect(ttsSupported()).toBe(false);
    expect(speak("words")).toBe(false);
    stop();
  });
});

describe("read aloud setting", () => {
  it("persists, primes the engine on the tap that turns it on, and stops speech when turned off", () => {
    const { result } = renderHook(() => useReadAloud());
    expect(result.current).toBe(false);
    expect(ttsPrimed()).toBe(false);
    act(() => setReadAloudEnabled(true));
    expect(result.current).toBe(true);
    expect(readAloudEnabled()).toBe(true);
    expect(ttsPrimed()).toBe(true);
    // The priming utterance is silent.
    expect(spoken[0]!.volume).toBe(0);
    expect(localStorage.getItem("collie:tts-read-aloud:v1")).toBe("1");
    act(() => setReadAloudEnabled(false));
    expect(synth.cancel).toHaveBeenCalled();
  });

  it("prime is idempotent", () => {
    prime();
    prime();
    expect(synth.speak).toHaveBeenCalledTimes(1);
  });
});
