import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import subagentExtension from "../../src/index.js";
import { AgentManager } from "../../src/runtime/agent-manager.js";
import { completedRun, errorRun, interruptedRun } from "../../src/domain/agent-finalize.js";

const baseCtx = () => ({ cwd: process.cwd(), hasUI: false, modelRegistry: { getAll: () => [] } } as any);

function registerExtension(dependencies: any = {}) {
  let registeredTool: any;
  subagentExtension({ registerTool: (tool: any) => { registeredTool = tool; } } as any, dependencies);
  return registeredTool;
}

test("subagent tool action=list with status filter [completed, error] returns terminal-success and terminal-failed sessions but excludes others", async () => {
  let nextRunner: ((agent: any) => any) | null = null;
  const runner = async (_ctx: any, agent: any, _attempt: any) => {
    agent.bindSession({ messages: [], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} });
    return nextRunner!(agent);
  };
  const fakeRegistry = {
    agents: new Map([
      ["good", { name: "good", description: "", systemPrompt: "", source: "project", retainConversation: true, tools: [] }],
      ["bad", { name: "bad", description: "", systemPrompt: "", source: "project", retainConversation: true, tools: [] }],
      ["cut", { name: "cut", description: "", systemPrompt: "", source: "project", retainConversation: true, tools: [] }],
    ]),
    async reload() {},
    summarizeAgent() { return ""; },
  };
  const manager = new AgentManager(fakeRegistry as any, 1, runner);
  const tool = registerExtension({ agentRegistry: fakeRegistry, agentManager: manager });

  nextRunner = (agent) => completedRun(agent, "ok");
  await tool.execute("tool-call", { action: "run", tasks: [{ agent: "good", prompt: "good task", label: "good task" }] }, undefined, undefined, baseCtx());
  nextRunner = (agent) => errorRun(agent, "failed");
  await tool.execute("tool-call", { action: "run", tasks: [{ agent: "bad", prompt: "bad task", label: "bad task" }] }, undefined, undefined, baseCtx());
  nextRunner = (agent) => interruptedRun(agent, "cancelled");
  await tool.execute("tool-call", { action: "run", tasks: [{ agent: "cut", prompt: "cut task", label: "cut task" }] }, undefined, undefined, baseCtx());

  const result = await tool.execute("tool-call", { action: "list", status: ["completed", "error"] }, undefined, undefined, baseCtx());

  assert.equal(result.isError, false);
  assert.equal(result.details.sessions.length, 2);
  const outcomes = result.details.sessions.map((s: any) => s.status.outcome).sort();
  assert.deepEqual(outcomes, ["completed", "error"]);
  assert.deepEqual(JSON.parse(result.content[0].text).filter, { status: ["completed", "error"] });
});

test("subagent tool action=list rejects an empty status filter", async () => {
  const runner = async (_ctx: any, agent: any, _attempt: any) => {
    agent.bindSession({ messages: [], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} });
    return completedRun(agent, "ok");
  };
  const fakeRegistry = {
    agents: new Map([["good", { name: "good", description: "", systemPrompt: "", source: "project", retainConversation: true, tools: [] }]]),
    async reload() {},
    summarizeAgent() { return ""; },
  };
  const manager = new AgentManager(fakeRegistry as any, 1, runner);
  const tool = registerExtension({ agentRegistry: fakeRegistry, agentManager: manager });

  await tool.execute("tool-call", { action: "run", tasks: [{ agent: "good", prompt: "go", label: "good task" }] }, undefined, undefined, baseCtx());

  const noFilter = await tool.execute("tool-call", { action: "list" }, undefined, undefined, baseCtx());
  assert.equal(noFilter.details.sessions.length, 1);

  const emptyFilter = await tool.execute("tool-call", { action: "list", status: [] }, undefined, undefined, baseCtx());
  assert.equal(emptyFilter.isError, true);
  assert.match(emptyFilter.content[0].text, /at least one status/);
});

test("subagent tool action=list with an unknown status value returns the unknown-status error", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-list-unknown-status-"));
  const tool = registerExtension();
  const result = await tool.execute("tool-call", { action: "list", status: ["weird"] }, undefined, undefined, { cwd: root });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown status 'weird'/);
  assert.match(result.content[0].text, /queued, running, completed, error, aborted, interrupted, skipped/);
});

test("subagent tool action=list with no filter returns retained sessions with normalized completed status", async () => {
  const runner = async (_ctx: any, agent: any, _attempt: any) => {
    agent.setEffectiveConfig({
      model: "test/model",
      thinking: "high",
      cwd: "/work/project",
      skills: ["requested-skill"],
      tools: ["read"],
      retainConversation: true,
    });
    agent.bindSession({ messages: [], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} });
    return completedRun(agent, "The final answer from the child.");
  };
  const fakeRegistry = {
    agents: new Map([
      ["chatty", { name: "chatty", description: "Keeps context", systemPrompt: "s", source: "project", retainConversation: true, model: "test/model", tools: ["read"], skills: ["default-skill"] }],
    ]),
    async reload() {},
    summarizeAgent() { return "chatty (project)"; },
  };
  const manager = new AgentManager(fakeRegistry as any, 1, runner);
  const tool = registerExtension({ agentRegistry: fakeRegistry, agentManager: manager });

  await tool.execute("tool-call", { action: "run", tasks: [{ agent: "chatty", prompt: "Remember this work.", label: "remember work", skills: ["requested-skill"] }] }, undefined, undefined, baseCtx());

  const result = await tool.execute("tool-call", { action: "list" }, undefined, undefined, baseCtx());

  assert.equal(result.isError, false);
  assert.equal(result.details.view, "inventory");
  assert.equal(result.details.sessions.length, 1);
  const retained = result.details.sessions[0];
  assert.equal(retained.config.name, "chatty");
  assert.equal(retained.status.kind, "done");
  assert.equal(retained.status.outcome, "completed");
  assert.equal(retained.config.source, "project");
  assert.equal(retained.config.model, "test/model");
  assert.deepEqual(retained.config.tools, ["read"]);
  assert.deepEqual(retained.config.skills, ["requested-skill"]);
  assert.equal(retained.status.output, "The final answer from the child.");
  assert.deepEqual(retained.attempt, { kind: "spawn", dispatch: "foreground" });
  assert.equal(retained.retention.catalog, "persistent");

  const modelSession = JSON.parse(result.content[0].text).sessions[0];
  assert.equal(modelSession.sessionId, retained.id);
  assert.equal(modelSession.agent, "chatty");
  assert.equal(modelSession.status, "completed");
  assert.deepEqual(modelSession.attempt, { kind: "spawn", dispatch: "foreground" });
  assert.equal(modelSession.label, "remember work");
  assert.equal("elapsedMs" in modelSession, false);
  assert.deepEqual(modelSession.capabilities, { canResume: true, canRemove: true });
  assert.deepEqual(Object.keys(modelSession).sort(), [
    "agent",
    "attempt",
    "capabilities",
    "conversation",
    "label",
    "retention",
    "sessionId",
    "status",
  ]);
});

test("model-facing inventory reports background sessions as removable", async () => {
  const runner = async (_ctx: any, agent: any, _attempt: any) => {
    agent.bindSession({ messages: [], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} });
    return completedRun(agent, "done");
  };
  const fakeRegistry = {
    agents: new Map([
      ["oneshot", { name: "oneshot", description: "", systemPrompt: "", source: "project", retainConversation: false, tools: [] }],
    ]),
    async reload() {},
    summarizeAgent() { return ""; },
  };
  const manager = new AgentManager(fakeRegistry as any, 1, runner);
  const handle = manager.startRun(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "oneshot", prompt: "go" }],
    undefined,
    { dispatch: "background" },
  );
  await handle.resultsPromise;
  const tool = registerExtension({ agentRegistry: fakeRegistry, agentManager: manager });

  const result = await tool.execute("tool-call", { action: "list" }, undefined, undefined, baseCtx());

  assert.equal(result.details.sessions[0].capabilities.canRemove, true);
  const modelSession = JSON.parse(result.content[0].text).sessions[0];
  assert.deepEqual(modelSession.capabilities, { canResume: false, canRemove: true });
});

test("model-facing inventory does not advertise active sessions as safely removable", async () => {
  let release!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const runner = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession({ messages: [], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} });
    markStarted();
    await gate;
    return completedRun(agent, "done");
  };
  const fakeRegistry = {
    agents: new Map([
      ["worker", { name: "worker", description: "Works", systemPrompt: "", source: "project", retainConversation: true, tools: [] }],
    ]),
    async reload() {},
    summarizeAgent() { return ""; },
  };
  const manager = new AgentManager(fakeRegistry as any, 1, runner);
  const handle = manager.startRun(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "worker", prompt: "go" }],
    undefined,
    { dispatch: "foreground" },
  );
  await started;
  const tool = registerExtension({ agentRegistry: fakeRegistry, agentManager: manager });

  const result = await tool.execute("tool-call", { action: "list" }, undefined, undefined, baseCtx());
  const detailsSession = result.details.sessions[0];
  assert.equal(detailsSession.status.kind, "running");
  assert.equal(detailsSession.capabilities.canRemove, false);
  assert.deepEqual(JSON.parse(result.content[0].text).sessions[0].capabilities, {
    canResume: false,
    canRemove: false,
  });

  release();
  await handle.resultsPromise;
});
