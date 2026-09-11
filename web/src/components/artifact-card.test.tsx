import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { fixtureArtifact } from "@/test/artifacts";
import { ArtifactCard, ArtifactCountChip, artifactWhen } from "./artifact-card";

// One artifact as a row (components/artifact-card.tsx): what it says, and that a tap hands the
// artifact up rather than navigating itself.

describe("ArtifactCard", () => {
  it("names the artifact, its kind, size and time, and hands the artifact to onOpen", async () => {
    const onOpen = vi.fn();
    const artifact = fixtureArtifact({ createdMs: Date.now() - 60_000 });
    render(<ArtifactCard artifact={artifact} onOpen={onOpen} />);
    const row = screen.getByRole("button", { name: "Open Q3 report" });
    expect(row).toHaveTextContent("Q3 report");
    expect(row).toHaveTextContent("page");
    expect(row).toHaveTextContent("2.0 KB");
    expect(row).not.toHaveTextContent("v1");
    await userEvent.setup().click(row);
    expect(onOpen).toHaveBeenCalledWith(artifact);
  });

  it("shows a version badge past v1, and the pane only when asked", () => {
    const { rerender } = render(<ArtifactCard artifact={fixtureArtifact({ version: 3 })} onOpen={() => {}} />);
    expect(screen.getByRole("button")).toHaveTextContent("v3");
    expect(screen.getByRole("button")).not.toHaveTextContent("webapp");
    rerender(<ArtifactCard artifact={fixtureArtifact({ version: 3 })} onOpen={() => {}} showPane />);
    expect(screen.getByRole("button")).toHaveTextContent("webapp › claude");
    rerender(<ArtifactCard artifact={fixtureArtifact({ pane: null, origin: "scheduler" })} onOpen={() => {}} showPane />);
    expect(screen.getByRole("button")).toHaveTextContent("scheduler");
  });

  it("the header chip carries the count and opens the list", async () => {
    const onClick = vi.fn();
    render(<ArtifactCountChip count={3} onClick={onClick} />);
    const chip = screen.getByRole("button", { name: "3 artifacts — open the list" });
    expect(chip).toHaveTextContent("3");
    await userEvent.setup().click(chip);
    expect(onClick).toHaveBeenCalled();
  });
});

describe("artifactWhen", () => {
  it("is a clock today, a date this year, an ISO day otherwise", () => {
    const now = Date.parse("2026-09-11T12:00:00");
    expect(artifactWhen(Date.parse("2026-09-11T10:03:00"), now)).toBe("10:03");
    expect(artifactWhen(Date.parse("2026-07-25T10:03:00"), now)).not.toContain(":");
    expect(artifactWhen(Date.parse("2025-07-25T10:03:00Z"), now)).toBe("2025-07-25");
  });
});
