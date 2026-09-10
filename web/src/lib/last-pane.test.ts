import { beforeEach, describe, expect, it } from "vitest";

import { __clearLastPane, lastPane, lastPanePath, rememberLastPane } from "./last-pane";

// FORK: the pane `/pane/last` means.

beforeEach(() => __clearLastPane());

describe("last pane", () => {
  it("is nothing until a pane has been opened", () => {
    expect(lastPane()).toBeNull();
    expect(lastPanePath("")).toBeNull();
  });

  it("remembers the pane and its scope, and builds the path with the seed carried across", () => {
    rememberLastPane("w1:p2", { session: "work" });
    expect(lastPane()).toEqual({ paneId: "w1:p2", scope: { session: "work" } });
    expect(lastPanePath("")).toBe("/pane/w1%3Ap2?s=work");
    expect(lastPanePath("?send=continue%20please&h=other")).toBe(
      "/pane/w1%3Ap2?s=work&send=continue%20please",
    );
    rememberLastPane("w1:p3");
    expect(lastPanePath("?send=go")).toBe("/pane/w1%3Ap3?send=go");
  });

  it("reads garbage as nothing", () => {
    localStorage.setItem("collie:last-pane:v1", "{nope");
    expect(lastPane()).toBeNull();
    localStorage.setItem("collie:last-pane:v1", JSON.stringify({ paneId: 3 }));
    expect(lastPane()).toBeNull();
  });
});
