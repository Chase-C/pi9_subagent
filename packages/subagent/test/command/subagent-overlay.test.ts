import { test } from "vitest";
import assert from "node:assert/strict";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";

import { DEFAULT_SUBAGENT_SETTINGS } from "../../src/config/settings.js";
import { SubagentOverlayComponent } from "../../src/command/components/overlay.js";
import { fakeAgent } from "../helpers/fake-agent.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function overlay(manager: any, initialPage: "sessions" | "agents" | "attached" | "settings" = "sessions") {
  let renders = 0;
  let closed = false;
  const component = new SubagentOverlayComponent(
    manager,
    { requestRender: () => { renders += 1; } },
    theme as any,
    undefined,
    () => { closed = true; },
    {
      initialPage,
      agents: [],
      settings: DEFAULT_SUBAGENT_SETTINGS,
      onSettingsChange() {},
      onResume() {},
      notify() {},
    },
  );
  return { component, get renders() { return renders; }, get closed() { return closed; } };
}

test("narrow rendering keeps the selected logical session row visible", () => {
  const sessions = Array.from({ length: 6 }, (_, index) => fakeAgent({
    id: `session-${index}`,
    prompt: index === 2 ? "▶ misleading task text" : `Task ${index}`,
    status: { kind: "running" },
  }));
  const manager = {
    listSessions: () => sessions,
    listAttachedSessions: () => [],
    onAgentUpdate: () => () => {},
  };
  const { component } = overlay(manager);
  for (let index = 0; index < 5; index++) component.handleInput("\x1b[B");

  const text = component.render(60).join("\n");

  assert.match(text, /▶.*helper/);
  assert.match(text, /Task 5/);
});

test("filter focus propagates the hardware cursor marker and all narrow lines fit", () => {
  const session = fakeAgent({ id: "long", prompt: "A very long task description ".repeat(20), status: { kind: "running" } });
  const manager = {
    listSessions: () => [session],
    listAttachedSessions: () => [],
    onAgentUpdate: () => () => {},
  };
  const { component } = overlay(manager);
  component.focused = true;
  component.handleInput("/");

  const lines = component.render(60);

  assert.equal(lines.some(line => line.includes(CURSOR_MARKER)), true);
  assert.equal(lines.every(line => visibleWidth(line) <= 60), true);
});

test("disposing the overlay unsubscribes live manager updates", () => {
  let unsubscribed = false;
  const manager = {
    listSessions: () => [],
    listAttachedSessions: () => [],
    onAgentUpdate: () => () => { unsubscribed = true; },
  };
  const { component } = overlay(manager);

  component.dispose();

  assert.equal(unsubscribed, true);
});

test("queued sessions can be stopped from Sessions and Attached", async () => {
  const queued = fakeAgent({ id: "queued", status: { kind: "queued" } });
  const stopped: string[] = [];
  const manager = {
    listSessions: () => [queued],
    listAttachedSessions: () => [queued],
    stopSession: async (id: string) => { stopped.push(id); },
    onAgentUpdate: () => () => {},
  };
  const sessionsOverlay = overlay(manager, "sessions").component;
  sessionsOverlay.handleInput("x");
  const attachedOverlay = overlay(manager, "attached").component;
  attachedOverlay.handleInput("x");
  await Promise.resolve();

  assert.deepEqual(stopped, ["queued", "queued"]);
});

test("changing attached selection clears the prior session's composer draft", async () => {
  const first = fakeAgent({ id: "first", status: { kind: "running" } });
  const second = fakeAgent({ id: "second", status: { kind: "running" } });
  const steered: Array<[string, string]> = [];
  const manager = {
    listSessions: () => [first, second],
    listAttachedSessions: () => [first, second],
    attachedSessionDetail: (id: string) => ({ session: id === "first" ? first : second, messages: [], pending: { steering: [], followUp: [] } }),
    steerSession: async (id: string, text: string) => { steered.push([id, text]); },
    onAgentUpdate: () => () => {},
  };
  const { component } = overlay(manager, "attached");

  component.handleInput("\r");
  for (const character of "first draft") component.handleInput(character);
  component.handleInput("\x1b");
  component.handleInput("\x1b[B");
  component.handleInput("\r");
  component.handleInput("\r");
  await Promise.resolve();

  assert.deepEqual(steered, []);
});

test("attaching another session cannot reuse an existing composer draft", async () => {
  const first = fakeAgent({ id: "first", status: { kind: "running" } });
  const second = fakeAgent({ id: "second", status: { kind: "running" } });
  const attached = [first];
  const steered: Array<[string, string]> = [];
  const manager = {
    listSessions: () => [second],
    listAttachedSessions: () => attached,
    attachToSession: () => { attached.push(second); return second; },
    attachedSessionDetail: (id: string) => ({ session: id === "first" ? first : second, messages: [], pending: { steering: [], followUp: [] } }),
    steerSession: async (id: string, text: string) => { steered.push([id, text]); },
    onAgentUpdate: () => () => {},
  };
  const { component } = overlay(manager, "attached");

  component.handleInput("\r");
  for (const character of "first draft") component.handleInput(character);
  component.handleInput("\x1b");
  component.handleInput("\t");
  component.handleInput("\t");
  component.handleInput("a");
  component.handleInput("\r");
  component.handleInput("\r");
  await Promise.resolve();

  assert.deepEqual(steered, []);
});

test("the Attached composer steers a running session in place", async () => {
  const session = fakeAgent({ id: "running", status: { kind: "running" }, capabilities: { canResume: false } });
  const steered: string[] = [];
  const manager = {
    listSessions: () => [session],
    listAttachedSessions: () => [session],
    attachedSessionDetail: () => ({ session, messages: [], pending: { steering: [], followUp: [] } }),
    steerSession: async (_id: string, text: string) => { steered.push(text); },
    onAgentUpdate: () => () => {},
  };
  const { component } = overlay(manager, "attached");

  component.handleInput("\r");
  for (const character of "Focus parser") component.handleInput(character);
  component.handleInput("\r");
  await Promise.resolve();

  assert.deepEqual(steered, ["Focus parser"]);
  assert.match(component.render(100).join("\n"), /\[ Attached \]/);
});

test("the Attached composer resumes a completed attached session through its callback", () => {
  const session = fakeAgent({ id: "done", retention: "persistent", capabilities: { canResume: true }, status: { kind: "completed" } });
  const resumes: Array<[string, string]> = [];
  const manager = {
    listSessions: () => [session],
    listAttachedSessions: () => [session],
    attachedSessionDetail: () => ({ session, messages: [], pending: { steering: [], followUp: [] } }),
    onAgentUpdate: () => () => {},
  };
  const component = new SubagentOverlayComponent(
    manager as any,
    { requestRender() {} },
    theme as any,
    undefined,
    () => {},
    {
      initialPage: "attached",
      agents: [],
      settings: DEFAULT_SUBAGENT_SETTINGS,
      onSettingsChange() {},
      onResume: (id, prompt) => resumes.push([id, prompt]),
      notify() {},
    },
  );

  component.handleInput("\r");
  for (const character of "Follow up") component.handleInput(character);
  component.handleInput("\r");

  assert.deepEqual(resumes, [["done", "Follow up"]]);
});

test("attaching from Sessions opens a flat Attached list containing only explicit attachments", () => {
  const first = fakeAgent({ id: "first", prompt: "First task", status: { kind: "running" } });
  const child = fakeAgent({ id: "child", parentSessionId: "first", prompt: "Child task", status: { kind: "running" } });
  const attached: any[] = [];
  const manager = {
    listSessions: () => [first, child],
    listAttachedSessions: () => attached,
    attachToSession(id: string) {
      const session = [first, child].find(item => item.id === id)!;
      attached.push(session);
      return session;
    },
    onAgentUpdate: () => () => {},
  };
  const { component } = overlay(manager);

  component.handleInput("a");
  const text = component.render(100).join("\n");

  assert.match(text, /\[ Attached \]/);
  assert.match(text, /First task/);
  assert.doesNotMatch(text, /Child task/);
});
