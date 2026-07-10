import { describe, expect, it } from "vitest";
import { buildContextReport } from "../src/builders.js";

describe("buildContextReport", () => {
  it("builds a complete report from the current command context", () => {
    const pi = {
      getThinkingLevel: () => "medium",
      getActiveTools: () => [],
      getAllTools: () => [],
    };
    const ctx = {
      model: {
        provider: "test-provider",
        id: "test-model",
        name: "Test Model",
        contextWindow: 10_000,
      },
      getContextUsage: () => ({ contextWindow: 10_000, tokens: 2_000, percent: 20 }),
      getSystemPrompt: () => "current prompt",
      getSystemPromptOptions: () => ({
        cwd: "/project",
        contextFiles: [{ path: "AGENTS.md", content: "current rules" }],
        skills: [],
      }),
      sessionManager: { getBranch: () => [] },
    };

    const report = buildContextReport(pi as never, ctx as never);

    expect(report).toMatchObject({
      kind: "conversation",
      promptTokens: 4,
      memory: [{ path: "AGENTS.md", tokens: 4 }],
      conversation: {
        tokens: 0,
        history: [],
      },
    });
  });
});
