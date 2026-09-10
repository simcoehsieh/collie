import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import * as ansi from "@/lib/ansi";
import { useMirrorModel } from "./use-mirror-model";

describe("useMirrorModel — the one parse of the mirror", () => {
  it("parses once per display string, and holds identity across re-renders", () => {
    const spy = vi.spyOn(ansi, "parseAnsi");
    const { result, rerender } = renderHook(({ display }) => useMirrorModel(display, undefined), {
      initialProps: { display: "hello\nworld" },
    });
    const first = result.current;
    expect(first.lines).toHaveLength(2);
    expect(first.blocks).toEqual([{ kind: "raw", lines: first.lines }]);
    expect(spy).toHaveBeenCalledTimes(1);

    rerender({ display: "hello\nworld" });
    expect(result.current).toBe(first); // same object: nothing re-derived, no consumer re-runs
    expect(spy).toHaveBeenCalledTimes(1);

    rerender({ display: "hello\nworld\n!" });
    expect(result.current).not.toBe(first);
    expect(result.current.lines).toHaveLength(3);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("rebuilds the blocks, not the lines, when only the adapter changes", () => {
    interface Props {
      agent?: string;
    }
    const initial: Props = {};
    const { result, rerender } = renderHook(
      ({ agent }: Props) => useMirrorModel("plain output", agent),
      { initialProps: initial },
    );
    const lines = result.current.lines;
    rerender({ agent: "claude" });
    expect(result.current.lines).toBe(lines);
    // Claude's grammars ran over the same lines; a plain screen is still one raw block.
    expect(result.current.blocks.map((b) => b.kind)).toEqual(["raw"]);
  });
});
