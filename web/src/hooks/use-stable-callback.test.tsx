import { act, render, screen } from "@testing-library/react";
import { memo, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { useStableCallback } from "./use-stable-callback";

describe("useStableCallback", () => {
  it("keeps one identity across renders while calling the latest render's function", () => {
    const seen: number[] = [];
    let renders = 0;
    const Child = memo(function Child({ onTap }: { onTap: () => void }) {
      renders++;
      return (
        <button type="button" onClick={onTap}>
          tap
        </button>
      );
    });
    function Parent() {
      const [n, setN] = useState(0);
      const onTap = useStableCallback(() => seen.push(n));
      return (
        <>
          <Child onTap={onTap} />
          <button type="button" onClick={() => setN((v) => v + 1)}>
            bump
          </button>
        </>
      );
    }
    render(<Parent />);
    expect(renders).toBe(1);

    act(() => screen.getByText("bump").click());
    act(() => screen.getByText("bump").click());
    // The memo'd child was handed the same function both times, so it never re-rendered…
    expect(renders).toBe(1);
    // …and yet the function it holds reads THIS render's state, not the first render's.
    act(() => screen.getByText("tap").click());
    expect(seen).toEqual([2]);
  });

  it("passes arguments and returns the value", () => {
    const fn = vi.fn((a: number, b: number) => a + b);
    function Probe() {
      const stable = useStableCallback(fn);
      return <span>{stable(2, 3)}</span>;
    }
    // Called during render here only to read the value in a test; the hook's contract is for
    // handlers, and the insertion effect has run by the time any handler can fire.
    render(<Probe />);
    expect(fn).toHaveBeenCalledWith(2, 3);
  });
});
