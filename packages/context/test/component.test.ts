import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  contentViewportLines,
  createContextReportComponent,
  formatContextReportLines,
} from "../src/component.js";
import type { ContextReport } from "../src/types.js";

const report: ContextReport = {
  kind: "conversation",
  model: {
    provider: "test-provider",
    id: "test-model",
    name: "Test Model",
    thinking: "medium",
    contextWindow: 1_000,
  },
  usage: { contextWindow: 1_000, tokens: 640, percent: 64 },
  promptTokens: 100,
  tools: [
    { name: "bash", tokens: 80, source: { kind: "builtin" }, active: true },
    { name: "custom_tool", tokens: 40, source: { kind: "extension", name: "test" }, active: true },
    { name: "inactive_tool", tokens: 20, source: { kind: "extension", name: "test" }, active: false },
  ],
  skills: [
    { name: "skill:test", descTokens: 30, bodyTokens: 120, scope: "project" },
  ],
  memory: [
    { path: "AGENTS.md", tokens: 50 },
  ],
  snapshot: { capturedAt: Date.now() },
  conversation: {
    tokens: 340,
    stats: {
      userMessages: 2,
      assistantMessages: 2,
      toolResults: 1,
      toolCalls: 1,
      thinkingBlocks: 0,
      imageBlocks: 0,
    },
    history: [
      { kind: "tool-call", tool: "bash", tokens: 10 },
    ],
  },
};

const graphReport: ContextReport = {
  kind: "static",
  model: {
    provider: "test-provider",
    id: "static-model",
    name: "Static Model",
    contextWindow: 5_000,
  },
  usage: { contextWindow: 5_000, tokens: 3_000, percent: 60 },
  promptTokens: 2_000,
  tools: [
    { name: "bash", tokens: 1_000, source: { kind: "builtin" }, active: true },
  ],
  skills: [],
};

const largeGraphReport: ContextReport = {
  kind: "static",
  model: {
    provider: "test-provider",
    id: "large-model",
    name: "Large Model",
    contextWindow: 50_000,
  },
  usage: { contextWindow: 50_000, tokens: 20_000, percent: 40 },
  promptTokens: 20_000,
  tools: [],
  skills: [],
};

const plainTheme = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
};

const ansiTheme = {
  fg: (_role: string, text: string) => `\u001b[36m${text}\u001b[0m`,
  bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
};

describe("context report formatting", () => {
  it("formats section headers with token totals", () => {
    const text = formatContextReportLines(report, plainTheme as never).join("\n");

    expect(text).toContain("Context Usage");
    expect(text).toContain("Estimated breakdown · 640 tokens");
    expect(text).toContain("Conversation (estimated) · 340 tokens");
    expect(text).toContain("Memory files (estimated) · 50 tokens");
    expect(text).toContain("Tools (estimated) · 120 tokens");
    expect(text).toContain("Skills (estimated) · 30 tokens");
  });

  it("renders one graph character per thousand context tokens", () => {
    const text = formatContextReportLines(graphReport, plainTheme as never, 80).join("\n");

    expect(text).toContain("1 char = 1K tokens");
    expect(text).toContain("● System prompt: 2K");
    expect(text).not.toContain("◇ Other: 1K");
    expect(text).toMatch(/^● ● ◆ □ □ {4}/m);
  });

  it("counts spaces when wrapping graph cells", () => {
    const lines = formatContextReportLines(largeGraphReport, plainTheme as never, 20);
    const graphLines = lines.filter((line) => /^[●◆▤✦◍◇□ ]+$/.test(line));

    expect(graphLines.length).toBeGreaterThan(1);
    expect(graphLines[0]).toContain(" ");
    for (const line of graphLines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(20);
    }
  });

  it("renders unknown capacity separately when current usage is unavailable", () => {
    const unknownUsageReport: ContextReport = {
      ...graphReport,
      usage: { contextWindow: 5_000, tokens: null, percent: null },
    };

    const text = formatContextReportLines(unknownUsageReport, plainTheme as never, 80).join("\n");

    expect(text).toMatch(/^● ● ◆ \? \? {4}/m);
    expect(text).toContain("? Unknown capacity: 2K");
  });
});

describe("context report component", () => {
  it("keeps rendered lines within the requested width", () => {
    const component = createContextReportComponent(report, {
      theme: ansiTheme as never,
      tui: { terminal: { rows: 18 }, requestRender: vi.fn() } as never,
      onClose: vi.fn(),
    });
    const lines = component.render(48);

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(48);
    }
  });

  it("closes on escape", () => {
    const onClose = vi.fn();
    const component = createContextReportComponent(report, {
      theme: plainTheme as never,
      tui: { terminal: { rows: 18 }, requestRender: vi.fn() } as never,
      onClose,
    });

    component.handleInput?.("\u001b");

    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("contentViewportLines", () => {
  it("reserves space for the view chrome", () => {
    expect(contentViewportLines(40)).toBe(32);
    expect(contentViewportLines(10)).toBe(5);
    expect(contentViewportLines(6)).toBe(1);
  });
});
