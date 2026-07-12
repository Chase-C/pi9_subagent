import { describe, expect, it, vi } from "vitest";
import askExtension from "../src/index.js";

type Tool = {
  execute: (...args: any[]) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
};

function register() {
  let tool: Tool | undefined;
  askExtension({
    registerTool: (definition: Tool) => {
      tool = definition;
    },
  } as never);
  if (!tool) throw new Error("ask tool was not registered");
  return tool;
}

describe("ask tool", () => {
  it("returns a selected option", async () => {
    const tool = register();
    const select = vi.fn().mockResolvedValue("Blue — Calm");
    const input = vi.fn();

    const result = await tool.execute("id", {
      question: "Which color?",
      options: [{ label: "Blue", description: "Calm" }],
    }, undefined, undefined, { hasUI: true, ui: { select, input } });

    expect(select).toHaveBeenCalledWith("Which color?", ["Blue — Calm", "Type a response…"]);
    expect(input).not.toHaveBeenCalled();
    expect(result.details).toEqual({ question: "Which color?", answer: "Blue", cancelled: false });
  });

  it("collects a freeform response", async () => {
    const tool = register();
    const select = vi.fn().mockResolvedValue("Type a response…");
    const input = vi.fn().mockResolvedValue("Something else");

    const result = await tool.execute("id", { question: "What next?" }, undefined, undefined, {
      hasUI: true,
      ui: { select, input },
    });

    expect(result.details).toEqual({ question: "What next?", answer: "Something else", cancelled: false });
  });

  it("rejects use without UI", async () => {
    const tool = register();

    await expect(tool.execute("id", { question: "Continue?" }, undefined, undefined, { hasUI: false }))
      .rejects.toThrow("requires an interactive UI");
  });
});
