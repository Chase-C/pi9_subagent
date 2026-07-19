import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SUBAGENT_SETTINGS } from "../../src/config/settings.js";
import { SubagentOverlayComponent, type OverlayOptions } from "../../src/command/components/overlay.js";
import { fakeAgent } from "../helpers/fake-agent.js";

function overlay(conversations: any[], overrides: Partial<OverlayOptions> = {}) {
  let listener: (() => void) | undefined;
  const unsubscribe = vi.fn();
  const requestRender = vi.fn();
  const callbacks = {
    notify: vi.fn(),
    onStart: vi.fn(),
    onResume: vi.fn(),
    onRemove: vi.fn(),
    onSettingsChange: vi.fn(),
  };
  const manager = {
    listConversations: () => conversations,
    onAgentUpdate: (next: () => void) => { listener = next; return unsubscribe; },
  };
  const component = new SubagentOverlayComponent(
    manager as any,
    { requestRender } as any,
    {} as any,
    undefined,
    vi.fn(),
    {
      initialPage: "conversations",
      agents: [{ name: "worker", description: "Works", source: "project" } as any],
      settings: DEFAULT_SUBAGENT_SETTINGS,
      ...callbacks,
      ...overrides,
    },
  );
  component.focused = true;
  return { component, callbacks, requestRender, unsubscribe, update: () => listener?.() };
}

describe("subagent overlay behavior", () => {
  it("starts an agent from the agent page", () => {
    const { component, callbacks } = overlay([], { initialPage: "agents" });

    component.handleInput("\r");
    component.handleInput("do work");
    component.handleInput("\r");

    expect(callbacks.onStart).toHaveBeenCalledWith("worker", "do work");
  });

  it("keeps the selected conversation stable while the catalog reorders", () => {
    const first = fakeAgent({ conversationId: "conversation-1", canResume: true });
    const second = fakeAgent({ conversationId: "conversation-2", canResume: true });
    const conversations = [first, second];
    const { component, callbacks } = overlay(conversations);

    component.handleInput("\x1b[B");
    conversations.reverse();
    component.handleInput("r");
    component.handleInput("follow up");
    component.handleInput("\r");

    expect(callbacks.onResume).toHaveBeenCalledWith("conversation-2", "follow up");
  });

  it("does not resume active or non-resumable conversations", () => {
    for (const conversation of [
      fakeAgent({ status: { kind: "running" }, canResume: true }),
      fakeAgent({ status: { kind: "completed" }, canResume: false }),
    ]) {
      const { component, callbacks } = overlay([conversation]);
      component.handleInput("r");
      component.handleInput("prompt");
      component.handleInput("\r");
      expect(callbacks.onResume).not.toHaveBeenCalled();
    }
  });

  it("removes the selected conversation", () => {
    const { component, callbacks } = overlay([fakeAgent({ conversationId: "conversation-1" })]);
    component.handleInput("x");
    expect(callbacks.onRemove).toHaveBeenCalledWith("conversation-1");
  });

  it("rerenders on manager updates and unsubscribes on disposal", () => {
    const { component, requestRender, unsubscribe, update } = overlay([]);
    update();
    expect(requestRender).toHaveBeenCalled();
    component.dispose();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("renders wide and narrow views without throwing", () => {
    const { component } = overlay([fakeAgent()]);
    expect(() => component.render(120)).not.toThrow();
    expect(() => component.render(56)).not.toThrow();
  });
});
