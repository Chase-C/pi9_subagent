import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderResult } from "../src/renderer.js";
import type { TodoToolDetails } from "../src/types.js";
import { todo } from "./helpers.js";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => `*${text}*`,
};

const details: TodoToolDetails = {
  action: "transition",
  state: { phases: [
    { name: "Planning", tasks: [todo("Plan release announcement")] },
    { name: "Build", tasks: [
      todo("Implement renderer", "in_progress"),
      todo("Publish package", "completed"),
    ] },
  ], workingOn: "Implementing the renderer" },
  changedTasks: [{ phase: "Build", task: "Implement renderer" }],
};

describe("todo renderer", () => {
  it("renders collapsed results as one muted line", () => {
    const colors: string[] = [];
    const theme = {
      ...plainTheme,
      fg: (color: string, text: string) => {
        colors.push(color);
        return text;
      },
    };

    expect(renderResult({ details }, { expanded: false }, theme).render(120)).toHaveLength(1);
    expect(colors).toEqual(["muted"]);
  });

  it("applies widget task colors in expanded results", () => {
    const calls: { color: string; text: string }[] = [];
    const themed = {
      fg: (color: string, text: string) => {
        calls.push({ color, text });
        return text;
      },
      bold: (text: string) => text,
    };
    renderResult({ details }, { expanded: true }, themed).render(120);

    expect(calls.find(({ text }) => text.includes("Plan release announcement"))?.color).toBe("muted");
    expect(calls.find(({ text }) => text.includes("Implement renderer"))?.color).toBe("text");
    expect(calls.find(({ text }) => text.includes("Publish package"))?.color).toBe("success");
  });

  it("keeps every phase and orders active, pending, then terminal tasks", () => {
    const expanded = renderResult({ details: {
      action: "view",
      state: { phases: [
        { name: "Plan", tasks: [
          todo("Done first", "completed"),
          todo("Pending first"),
          todo("Active", "in_progress"),
          todo("Pending second"),
          todo("Cancelled", "cancelled"),
        ] },
        { name: "Review", tasks: [todo("Review pending")] },
        { name: "Empty", tasks: [] },
      ], workingOn: "Handling the active task" },
      changedTasks: [],
    } }, { expanded: true }, plainTheme, { fallbackGlyphs: true }).render(120).join("\n");

    expect(expanded.indexOf("Active")).toBeLessThan(expanded.indexOf("Pending first"));
    expect(expanded.indexOf("Pending first")).toBeLessThan(expanded.indexOf("Done first"));
    expect(expanded).toContain("3. Empty");
  });

  it("handles narrow and empty states safely", () => {
    const narrow = renderResult({ details }, { expanded: true }, plainTheme).render(12);
    expect(narrow.every((line) => visibleWidth(line) <= 12)).toBe(true);
    const empty: TodoToolDetails = { action: "view", state: { phases: [] }, changedTasks: [] };
    expect(renderResult({ details: empty }, { expanded: true }, plainTheme).render(80)).toHaveLength(1);
  });
});
