import { describe, expect, it } from "vitest";

import { parseAnsi } from "./ansi";
import { splitLines } from "./blocks";
import { codeFences } from "./code-fences";

const fences = (text: string) => codeFences(splitLines(parseAnsi(text)));

describe("codeFences", () => {
  it("finds a closed fence and reports the line indices of its two rows", () => {
    expect(fences("prose\n```sh\nls -la\n```\nmore")).toEqual([{ open: 1, close: 3 }]);
  });

  it("reports an OPEN fence not at all — the agent is still writing it", () => {
    expect(fences("```ts\nconst a = 1;\n")).toEqual([]);
  });

  it("does not let a tagged row close a fence: ```sh opens, a bare ``` closes", () => {
    // Two opens in a row are two half-written blocks, not one closed one.
    expect(fences("```sh\necho\n```js\nx\n")).toEqual([]);
    expect(fences("```sh\necho\n```js\nx\n```")).toEqual([{ open: 0, close: 4 }]);
  });

  it("finds several, in order, non-overlapping", () => {
    expect(fences("```\na\n```\n\n```py\nb\n```")).toEqual([
      { open: 0, close: 2 },
      { open: 4, close: 6 },
    ]);
  });

  it("accepts an indented fence (a code block inside a list item) and a longer close", () => {
    expect(fences("- step\n  ```\n  cmd\n  ````")).toEqual([{ open: 1, close: 3 }]);
  });

  it("refuses a close shorter than its open (CommonMark)", () => {
    expect(fences("````\n```\nstill inside\n````")).toEqual([{ open: 0, close: 3 }]);
  });

  it("reads the visible text, so a styled fence row still counts", () => {
    expect(fences("\x1b[2m```\x1b[0m\ncode\n\x1b[2m```\x1b[0m")).toEqual([{ open: 0, close: 2 }]);
  });
});
