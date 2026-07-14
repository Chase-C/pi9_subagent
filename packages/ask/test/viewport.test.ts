import { describe, expect, it } from "vitest";

import { fitViewport } from "../src/viewport.js";

const lines = ["top", "middle 0", "middle 1", "middle 2", "middle 3", "middle 4", "bottom"];

function viewport(focus: { start: number; end: number } | undefined, maxRows = 5) {
  return fitViewport(lines, focus, maxRows, 1, 1);
}

describe("fitViewport", () => {
  it("returns fitting content unchanged without overflow flags", () => {
    const input = ["one", "two", "three"];

    expect(fitViewport(input, { start: 1, end: 2 }, 3, 1, 1)).toEqual({
      lines: input,
      hiddenAbove: false,
      hiddenBelow: false,
    });
  });

  it("keeps focus visible near the top, middle, and bottom", () => {
    expect(viewport({ start: 1, end: 2 }).lines).toEqual([
      "top", "middle 0", "middle 1", "↓ middle 2", "bottom",
    ]);
    expect(viewport({ start: 3, end: 4 }).lines).toEqual([
      "top", "↑ middle 1", "middle 2", "↓ middle 3", "bottom",
    ]);
    expect(viewport({ start: 5, end: 6 }).lines).toEqual([
      "top", "↑ middle 2", "middle 3", "middle 4", "bottom",
    ]);
  });

  it("keeps an entire multi-row focus visible when it fits", () => {
    const result = fitViewport(lines, { start: 2, end: 5 }, 6, 1, 1);

    expect(result.lines).toEqual([
      "top", "↑ middle 1", "middle 2", "middle 3", "middle 4", "bottom",
    ]);
  });

  it("shows the focus-leading portion when a multi-row focus is taller than the middle", () => {
    const result = viewport({ start: 2, end: 6 }, 4);

    expect(result.lines).toEqual(["top", "↑ middle 1", "↓ middle 2", "bottom"]);
  });

  it("reports and marks only downward, only upward, and two-way overflow", () => {
    expect(viewport({ start: 1, end: 2 })).toMatchObject({ hiddenAbove: false, hiddenBelow: true });
    expect(viewport({ start: 5, end: 6 })).toMatchObject({ hiddenAbove: true, hiddenBelow: false });
    expect(viewport({ start: 3, end: 4 })).toMatchObject({ hiddenAbove: true, hiddenBelow: true });

    expect(viewport({ start: 3, end: 4 }, 3)).toEqual({
      lines: ["top", "↕ middle 2", "bottom"],
      hiddenAbove: true,
      hiddenBelow: true,
    });
  });

  it("degrades tiny terminals deterministically, retaining both chrome edges when possible", () => {
    const chromeHeavy = ["top 0", "top 1", "middle", "bottom 0", "bottom 1"];

    expect(fitViewport(chromeHeavy, undefined, 3, 2, 2)).toEqual({
      lines: ["top 0", "top 1", "bottom 1"],
      hiddenAbove: false,
      hiddenBelow: true,
    });
    expect(fitViewport(chromeHeavy, undefined, 2, 2, 2).lines).toEqual(["top 0", "bottom 1"]);
    expect(fitViewport(chromeHeavy, undefined, 1, 2, 2).lines).toEqual(["top 0"]);
    expect(fitViewport(chromeHeavy, undefined, 0, 2, 2).lines).toEqual([]);
    expect(fitViewport(chromeHeavy, undefined, -10, 2, 2).lines).toEqual([]);
    expect(fitViewport(chromeHeavy, undefined, Number.NaN, 2, 2).lines).toEqual([]);
  });

  it("never exceeds maxRows across viewport sizes", () => {
    for (const maxRows of [-3, 0, 1, 2, 3, 4, 5, 6, 7, 20]) {
      const result = fitViewport(lines, { start: 3, end: 6 }, maxRows, 1, 1);
      expect(result.lines.length, `maxRows=${maxRows}`).toBeLessThanOrEqual(Math.max(0, maxRows));
    }
  });
});
