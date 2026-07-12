import { describe, expect, it, vi } from "vitest";
import askExtension from "../src/index.js";

function register() {
  let tool: any;
  let contextHandler: any;
  const emit = vi.fn();
  askExtension({
    registerTool: (definition: unknown) => { tool = definition; },
    on: (event: string, handler: unknown) => { if (event === "context") contextHandler = handler; },
    events: { emit },
  } as never);
  if (!tool || !contextHandler) throw new Error("ask integration was not registered");
  return { tool, contextHandler, emit };
}

const rpcUi = (answer = "1. Yes") => ({
  select: vi.fn().mockResolvedValue(answer),
  input: vi.fn().mockResolvedValue(""),
});

describe("ask extension integration", () => {
  it("registers the strict sequential tool, guidance, renderers, and context pruning", () => {
    const { tool, contextHandler } = register();
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(tool.executionMode).toBe("sequential");
    expect(tool.promptGuidelines.join(" ").length).toBeLessThan(240);
    expect(tool.renderCall({ question: "Choose?" }, theme(), {}).render(80).join("\n")).toContain("Choose?");
    expect(tool.renderResult({ content: [{ type: "text", text: "Selected: Yes" }] }, {}, theme(), {}).render(80).join("\n")).toContain("Selected: Yes");

    const details = { status: "answered", question: "Choose", answer: { selections: [{ label: "Yes" }] } };
    const messages: any[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "a", name: "ask", arguments: { question: "Choose", options: [{ label: "Yes" }, { label: "No" }] } }, { type: "toolCall", id: "alternative", name: "other", arguments: {} }] },
      { role: "toolResult", toolCallId: "a", toolName: "ask", details, content: [{ type: "text", text: "original verbose result" }] },
    ];
    const rewritten = contextHandler({ messages }).messages;
    expect(rewritten[0].content[0].arguments.options).toEqual([{ label: "Yes" }]);
    expect(rewritten[1].content).toEqual([{ type: "text", text: "Selected: Yes" }]);
    expect(rewritten[1].details).toEqual(details);
    expect(messages[0].content[0].arguments.options).toHaveLength(2);
    expect(messages[0].content[1].id).toBe("alternative");
    expect(messages[1].details).toBe(details);
  });

  it("normalizes without mutating the questionnaire and uses the full TUI overlay", async () => {
    const { tool, emit } = register();
    const params = { question: "  Choose?  ", options: [{ label: " Yes " }], allowFreeform: false };
    const custom = vi.fn(async (factory, options) => {
      expect(options).toMatchObject({ overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "100%" } });
      let completed: unknown;
      const component = await factory({ requestRender: vi.fn() }, theme(), {}, (value: unknown) => { completed = value; });
      component.handleInput("\r");
      return completed;
    });

    const result = await tool.execute("id", params, undefined, undefined, { mode: "tui", hasUI: true, ui: { custom } });
    expect(result.details).toEqual({ status: "answered", question: "Choose?", answer: { selections: [{ label: "Yes" }] } });
    expect(params).toEqual({ question: "  Choose?  ", options: [{ label: " Yes " }], allowFreeform: false });
    expect(emit).toHaveBeenCalledWith("ask:answered", result.details);
  });

  it.each(["rpc", "tui"])("uses RPC dialogs in %s mode when rich UI is unavailable", async (mode) => {
    const { tool } = register();
    const ui = rpcUi();
    if (mode === "tui") Object.assign(ui, { custom: vi.fn().mockResolvedValue(undefined) });
    const result = await tool.execute("id", { question: "Continue?", options: [{ label: "Yes" }] }, undefined, undefined, { mode, hasUI: true, ui });
    expect(result.details.status).toBe("answered");
    expect(ui.select).toHaveBeenCalled();
  });

  it("threads cancellation through RPC and returns a structured cancelled result", async () => {
    const { tool } = register();
    const controller = new AbortController();
    const ui = rpcUi("1. Yes");
    ui.select.mockImplementation(async (_title, _options, dialogOptions) => {
      expect(dialogOptions).toEqual({ signal: controller.signal });
      controller.abort();
      return "1. Yes";
    });
    const result = await tool.execute("id", { question: "Continue?", options: [{ label: "Yes" }] }, controller.signal, undefined, { mode: "rpc", hasUI: true, ui });
    expect(result.details.status).toBe("cancelled");
    expect(ui.input).not.toHaveBeenCalled();
  });

  it("returns unavailable without throwing or emitting cancellation", async () => {
    const { tool, emit } = register();
    const result = await tool.execute("id", { question: "Continue?" }, undefined, undefined, { mode: "print", hasUI: false, ui: {} });
    expect(result.details).toEqual({ status: "ui_unavailable", question: "Continue?" });
    expect(emit).not.toHaveBeenCalledWith("ask:cancelled", expect.anything());
  });

  it.each([
    ["normal answer", false],
    ["cancellation", true],
  ])("removes the TUI abort listener after %s", async (_label, cancel) => {
    const { tool } = register();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const custom = vi.fn(async (factory) => {
      let completed: unknown;
      const component = factory({ requestRender: vi.fn() }, theme(), {}, (value: unknown) => { completed = value; });
      if (cancel) component.handleInput("\x1b");
      else component.handleInput("\r");
      return completed;
    });
    await tool.execute("id", { question: "Continue?", options: [{ label: "Yes" }], allowFreeform: false }, controller.signal, undefined, { mode: "tui", hasUI: true, ui: { custom } });
    expect(add).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]?.[1]);
  });

  it("preserves pre-aborted TUI behavior without retaining a listener", async () => {
    const { tool } = register();
    const controller = new AbortController();
    controller.abort();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const custom = vi.fn((factory) => new Promise((resolve) => factory({ requestRender: vi.fn() }, theme(), {}, resolve)));
    const result = await tool.execute("id", { question: "Continue?" }, controller.signal, undefined, { mode: "tui", hasUI: true, ui: { custom } });
    expect(result.details.status).toBe("cancelled");
    expect(add).not.toHaveBeenCalled();
  });

  it("wires cancellation and abort to a structured cancelled result", async () => {
    const { tool, emit } = register();
    const controller = new AbortController();
    const custom = vi.fn((factory) => new Promise((resolve) => {
      factory({ requestRender: vi.fn() }, theme(), {}, resolve);
      controller.abort();
    }));
    const result = await tool.execute("id", { question: "Continue?" }, controller.signal, undefined, { mode: "tui", hasUI: true, ui: { custom } });
    expect(result.details.status).toBe("cancelled");
    expect(emit).toHaveBeenCalledWith("ask:cancelled", result.details);
  });
});

function theme() {
  return { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text } as any;
}
