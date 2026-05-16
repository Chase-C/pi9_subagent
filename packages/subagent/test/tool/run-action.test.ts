import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import subagentExtension from "../../src/index.js";
import { AgentManager } from "../../src/runtime/agent-manager.js";
import { completedRun } from "../../src/domain/agent-result.js";
import { fakeAgent } from "../helpers/fake-agent.js";

const baseCtx = () => ({ cwd: process.cwd(), hasUI: false, modelRegistry: { getAll: () => [] } } as any);

function registerExtension(dependencies: any = {}) {
  let registeredTool: any;
  subagentExtension({ registerTool: (tool: any) => { registeredTool = tool; } } as any, dependencies);
  return registeredTool;
}

test("tool execution uses configured maxTasksPerRun from subagent settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-max-tasks-config-"));
  const projectAgents = join(root, ".pi", "agents");
  await mkdir(projectAgents, { recursive: true });
  await writeFile(join(projectAgents, "helper.md"), `---\nname: helper\ndescription: Helps\n---\nHelp prompt`);

  const tool = registerExtension({
    settingsStore: { load: async () => ({ settings: { widgetPlacement: "belowEditor", runtime: { maxTasksPerRun: 1 } } }) },
  });

  const result = await tool.execute("tool-call", {
    action: "run",
    tasks: [{ agent: "helper", prompt: "task 1" }, { agent: "helper", prompt: "task 2" }],
  }, undefined, undefined, { cwd: root });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Too many tasks \(2\)\. Max is 1/);
});

test("tool run action returns full output only once in JSON details for a resume task", async () => {
  const fullOutput = `resume output ${"q".repeat(1500)} tail`;
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [] as any[],
    startBatch(_ctx: any, _signal: any, tasks: any[]) {
      const resultsPromise = Promise.resolve(tasks.map((task: any) => ({
        agent: "helper",
        prompt: task.prompt,
        status: "completed",
        output: fullOutput,
        sessionId: task.sessionId ?? "s1",
        resumable: true,
        resumed: task.kind === "resume",
      })));
      return { groupId: "g1", sessions: [], resultsPromise };
    },
  };

  const tool = registerExtension({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
  });

  const result = await tool.execute("tool-call", {
    action: "run",
    tasks: [{ sessionId: "s1", prompt: "follow up" }],
  }, undefined, undefined, { cwd: process.cwd(), hasUI: false });

  assert.equal(result.isError, false);
  assert.equal(result.details.results[0].output, fullOutput);
  assert.equal((result.content[0].text.match(new RegExp(fullOutput, "g")) ?? []).length, 1);
});

test("tool execution returns structured failed run for unknown agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-unknown-"));
  const tool = registerExtension();

  const result = await tool.execute("tool-call", {
    action: "run",
    tasks: [{ agent: "missing", prompt: "do work" }],
  }, undefined, undefined, { cwd: root });

  assert.equal(result.isError, true);
  assert.deepEqual(result.details.results.map((r: any) => r.agent), ["missing"]);
  assert.equal(result.details.results[0].status, "error");
  assert.match(result.content[0].text, /"results"/);
});

test("subagent tool returns one ordered final group for mixed success, unknown, and failed children", async () => {
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach({ messages: [], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} });
    if (agent.agentName === "flaky") throw new Error("flaky failed");
    return completedRun(agent, `done:${prompt}`);
  };
  const fakeRegistry = {
    agents: new Map([
      ["helper", { name: "helper", description: "Helps", systemPrompt: "s", source: "project" }],
      ["flaky", { name: "flaky", description: "Fails", systemPrompt: "s", source: "project" }],
    ]),
    async reload() {},
    summarizeAgent() { return "helper (project)\nflaky (project)"; },
  };
  const manager = new AgentManager(fakeRegistry as any, 2, runner);
  const tool = registerExtension({ agentRegistry: fakeRegistry, agentManager: manager });

  const result = await tool.execute("tool-call", {
    action: "run",
    tasks: [
      { agent: "helper", prompt: "first" },
      { agent: "missing", prompt: "second" },
      { agent: "flaky", prompt: "third" },
    ],
  }, undefined, undefined, baseCtx());

  assert.equal(result.isError, true);
  assert.deepEqual(result.details.results.map((run: any) => run.agent), ["helper", "missing", "flaky"]);
  assert.equal(result.details.results[0].output, "done:first");
  assert.deepEqual(result.details.results.map((run: any) => run.status), ["completed", "error", "error"]);
  assert.deepEqual(result.details.group.sessions.map((s: any) => s.config.name), ["helper", "missing", "flaky"]);
  assert.deepEqual(result.details.group.sessions.map((s: any) => s.status.kind === "done" ? s.status.outcome : s.status.kind), ["completed", "error", "error"]);
  assert.equal(result.details.group.statusCounts.completed, 1);
  assert.equal(result.details.group.statusCounts.error, 2);
  assert.equal(result.details.group.isError, true);
});

test("subagent tool notifies invalid settings fallback without breaking execution", async () => {
  const runningAgent = fakeAgent({ status: { kind: "running", startedAt: 1 }, turns: 1 });
  const fakeRegistry = {
    agents: new Map([["helper", { name: "helper", description: "Helps", source: "project" }]]),
    async reload() {},
    summarizeAgent() { return "helper (project)"; },
  };
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [] as any[],
    startBatch(_ctx: any, _signal: any, _tasks: any, onUpdate: any) {
      onUpdate?.({ sessions: [runningAgent], active: true });
      const resultsPromise = Promise.resolve([{ agent: "helper", prompt: "work", status: "completed", output: "done", sessionId: "s1", resumable: false, resumed: false }]);
      return { groupId: "g1", sessions: [runningAgent], resultsPromise };
    },
  };
  const tool = registerExtension({
    agentRegistry: fakeRegistry,
    agentManager: fakeManager,
    settingsStore: { async load() { return { settings: { widgetPlacement: "belowEditor" }, warning: "Invalid subagent UI settings." }; } },
  });

  const notifications: any[] = [];
  const widgets: any[] = [];
  const result = await tool.execute("tool-call", {
    action: "run",
    tasks: [{ agent: "helper", prompt: "work" }],
  }, undefined, undefined, {
    cwd: process.cwd(),
    hasUI: true,
    ui: { setWidget: (...args: any[]) => widgets.push(args), notify: (...args: any[]) => notifications.push(args) },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.results[0].output, "done");
  assert.match(notifications[0][0], /Invalid subagent UI settings/);
  assert.equal(notifications[0][1], "warning");
  assert.deepEqual(widgets[0][2], { placement: "belowEditor" });
});

test("subagent tool falls back to default UI settings when settings load rejects", async () => {
  const runningAgent = fakeAgent({ status: { kind: "running", startedAt: 1 }, turns: 1 });
  const fakeRegistry = {
    agents: new Map([["helper", { name: "helper", description: "Helps", source: "project" }]]),
    async reload() {},
    summarizeAgent() { return "helper (project)"; },
  };
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [] as any[],
    startBatch(_ctx: any, _signal: any, _tasks: any, onUpdate: any) {
      onUpdate?.({ sessions: [runningAgent], active: true });
      const resultsPromise = Promise.resolve([{ agent: "helper", prompt: "work", status: "completed", output: "done", sessionId: "s1", resumable: false, resumed: false }]);
      return { groupId: "g1", sessions: [runningAgent], resultsPromise };
    },
  };
  const tool = registerExtension({
    agentRegistry: fakeRegistry,
    agentManager: fakeManager,
    settingsStore: { async load() { throw new Error("disk unreadable"); } },
  });

  const notifications: any[] = [];
  const widgets: any[] = [];
  const result = await tool.execute("tool-call", {
    action: "run",
    tasks: [{ agent: "helper", prompt: "work" }],
  }, undefined, undefined, {
    cwd: process.cwd(),
    hasUI: true,
    ui: { setWidget: (...args: any[]) => widgets.push(args), notify: (...args: any[]) => notifications.push(args) },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.results[0].output, "done");
  assert.match(notifications[0][0], /Failed to load subagent UI settings/);
  assert.equal(notifications[0][1], "warning");
  assert.deepEqual(widgets[0][2], { placement: "belowEditor" });
});

test("subagent tool keeps subagent surfaces working but hides widget when placement is off", async () => {
  const runningAgent = fakeAgent({ status: { kind: "running", startedAt: 1 }, message: "working", turns: 1 });
  const fakeRegistry = {
    agents: new Map([["helper", { name: "helper", description: "Helps", source: "project" }]]),
    async reload() {},
    summarizeAgent() { return "helper (project)"; },
  };
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [runningAgent],
    startBatch(_ctx: any, _signal: any, _tasks: any, onUpdate: any) {
      onUpdate?.({ sessions: [runningAgent], active: true });
      const resultsPromise = Promise.resolve([{ agent: "helper", prompt: "work", status: "completed", output: "done", sessionId: "s1", resumable: false, resumed: false }]);
      return { groupId: "g1", sessions: [runningAgent], resultsPromise };
    },
  };

  const tool = registerExtension({
    agentRegistry: fakeRegistry,
    agentManager: fakeManager,
    settingsStore: { async load() { return { settings: { widgetPlacement: "off" } }; } },
  });

  const widgets: any[] = [];
  const result = await tool.execute("tool-call", {
    action: "run",
    tasks: [{ agent: "helper", prompt: "work" }],
  }, undefined, undefined, {
    cwd: process.cwd(),
    hasUI: true,
    ui: { setWidget: (...args: any[]) => widgets.push(args), notify() {} },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.results[0].output, "done");
  assert.equal(result.details.group.sessions[0].config.name, "helper");
  assert.ok(widgets.length > 0);
  assert.equal(widgets.every((call: any[]) => call[0] === "subagent" && call[1] === undefined), true);
});

test("subagent tool forwards live manager updates to onUpdate and widget UI", async () => {
  const runningAgent = fakeAgent({
    status: { kind: "running", startedAt: 1 },
    message: "working",
    activeTools: ["read"],
    turns: 1,
    toolUses: 1,
  });
  const fakeRegistry = {
    agents: new Map([["helper", { name: "helper", description: "Helps", source: "project" }]]),
    async reload() {},
    summarizeAgent() { return "helper (project)"; },
  };
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [] as any[],
    startBatch(_ctx: any, _signal: any, _tasks: any, onUpdate: any) {
      onUpdate?.({ sessions: [runningAgent], active: true });
      const resultsPromise = Promise.resolve([{ agent: "helper", prompt: "work", status: "completed", output: "done", sessionId: "s1", resumable: false, resumed: false }]);
      return { groupId: "g1", sessions: [runningAgent], resultsPromise };
    },
  };

  const tool = registerExtension({
    agentRegistry: fakeRegistry,
    agentManager: fakeManager,
    settingsStore: { async load() { return { settings: { widgetPlacement: "belowEditor" } }; }, async save() {} },
  });

  const partials: any[] = [];
  const widgets: any[] = [];
  const result = await tool.execute("tool-call", {
    action: "run",
    tasks: [{ agent: "helper", prompt: "work" }],
  }, undefined, (partial: any) => partials.push(partial), {
    cwd: process.cwd(),
    hasUI: true,
    ui: { setWidget: (...args: any[]) => widgets.push(args), notify() {} },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.results[0].output, "done");
  assert.equal(result.details.group.sessions[0].activity.toolHistory.at(-1)?.name, "read");
  assert.equal(partials[0].details.group.sessions[0].activity.toolHistory.at(-1)?.name, "read");
  assert.doesNotMatch(partials[0].content[0].text, /working/);
  assert.equal(widgets[0][0], "subagent");
  assert.match(widgets[0][1][0], /helper/);
  assert.deepEqual(widgets.at(-1), ["subagent", undefined, { placement: "belowEditor" }]);
});

test("subagent action=run accepts a heterogeneous batch of spawn and resume tasks", async () => {
  let receivedTasks: any;
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [] as any[],
    startBatch(_ctx: any, _signal: any, tasks: any[]) {
      receivedTasks = tasks;
      const resultsPromise = Promise.resolve(tasks.map((task: any) => ({
        agent: task.kind === "spawn" ? task.agent : "chatty",
        prompt: task.prompt,
        status: "completed",
        output: `done:${task.prompt}`,
        resumable: task.kind === "resume",
        resumed: task.kind === "resume",
        ...(task.kind === "resume" ? { sessionId: task.sessionId } : {}),
      })));
      return { groupId: "g1", sessions: [], resultsPromise };
    },
  };
  const fakeRegistry = {
    agents: new Map([["helper", { name: "helper", description: "Helps", source: "project" }]]),
    async reload() {},
    summarizeAgent() { return "helper (project)"; },
  };
  const tool = registerExtension({
    agentRegistry: fakeRegistry,
    agentManager: fakeManager,
    settingsStore: { async load() { return { settings: { widgetPlacement: "belowEditor" } }; } },
  });

  const result = await tool.execute("tool-call", {
    action: "run",
    tasks: [
      { agent: "helper", prompt: "one" },
      { sessionId: "s-1", prompt: "two" },
    ],
  }, undefined, undefined, baseCtx());

  assert.equal(result.isError, false);
  assert.deepEqual(receivedTasks.map((t: any) => t.kind), ["spawn", "resume"]);
  assert.equal(receivedTasks[1].sessionId, "s-1");
  assert.equal(result.details.results[0].resumed, false);
  assert.equal(result.details.results[1].resumed, true);
});

test("subagent action=run background:true returns view:background-started immediately with initial session views", async () => {
  let releaseRun: () => void;
  const runGate = new Promise<void>(resolve => { releaseRun = resolve; });
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach({ messages: [], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} });
    await runGate;
    return completedRun(agent, `done:${prompt}`);
  };
  const fakeRegistry = {
    agents: new Map([["helper", { name: "helper", description: "Helps", systemPrompt: "s", source: "project" }]]),
    async reload() {},
    summarizeAgent() { return "helper (project)"; },
  };
  const manager = new AgentManager(fakeRegistry as any, 2, runner);
  const tool = registerExtension({ agentRegistry: fakeRegistry, agentManager: manager });

  const result = await tool.execute("tool-call", {
    action: "run",
    background: true,
    tasks: [{ agent: "helper", prompt: "background work" }],
  }, undefined, undefined, baseCtx());

  assert.equal(result.isError, false);
  assert.equal(result.details.view, "background-started");
  assert.equal(result.details.background, true);
  assert.equal(result.details.sessions.length, 1);
  assert.equal(result.details.sessions[0].kind, "background");
  const liveStatus = manager.listSessions()[0].status.kind;
  assert.ok(liveStatus === "queued" || liveStatus === "running", `expected non-terminal status, got ${liveStatus}`);

  releaseRun!();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
});

test("subagent action=run background:true never invokes the parent onUpdate channel", async () => {
  let releaseRun: () => void;
  const runGate = new Promise<void>(resolve => { releaseRun = resolve; });
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach({ messages: [], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} });
    await runGate;
    return completedRun(agent, `done:${prompt}`);
  };
  const fakeRegistry = {
    agents: new Map([["helper", { name: "helper", description: "Helps", systemPrompt: "s", source: "project" }]]),
    async reload() {},
    summarizeAgent() { return "helper (project)"; },
  };
  const manager = new AgentManager(fakeRegistry as any, 2, runner);
  const tool = registerExtension({ agentRegistry: fakeRegistry, agentManager: manager });

  const onUpdateCalls: unknown[] = [];
  const onUpdate = (partial: unknown) => { onUpdateCalls.push(partial); };

  await tool.execute("tool-call", {
    action: "run",
    background: true,
    tasks: [{ agent: "helper", prompt: "background work" }],
  }, undefined, onUpdate, baseCtx());

  await new Promise(resolve => setTimeout(resolve, 250));
  releaseRun!();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(onUpdateCalls, []);
});

test("subagent action=run rejects a per-task background field with the batch-level migration error", async () => {
  let runCalls = 0;
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [] as any[],
    async run() { runCalls += 1; return []; },
  };
  const tool = registerExtension({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
    settingsStore: { async load() { return { settings: { widgetPlacement: "belowEditor" } }; } },
  });

  const result = await tool.execute("tool-call", {
    action: "run",
    tasks: [{ agent: "helper", prompt: "p", background: true }],
  }, undefined, undefined, baseCtx());

  assert.equal(result.isError, true);
  assert.equal(runCalls, 0);
  assert.match(result.content[0].text, /background is a batch-level flag on action='run', not a per-task field\./);
});

test("subagent action=run rejects a task carrying both agent and sessionId at parse time", async () => {
  let runCalls = 0;
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [] as any[],
    async run() { runCalls += 1; return []; },
  };
  const tool = registerExtension({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
    settingsStore: { async load() { return { settings: { widgetPlacement: "belowEditor" } }; } },
  });

  const result = await tool.execute("tool-call", {
    action: "run",
    tasks: [{ agent: "helper", sessionId: "s", prompt: "p" }],
  }, undefined, undefined, baseCtx());

  assert.equal(result.isError, true);
  assert.equal(runCalls, 0);
  assert.match(result.content[0].text, /both agent and sessionId/);
});

test("a late-arriving grandchild status change triggers a partial re-emit with the grandchild visible", async () => {
  const partials: any[] = [];
  const rootView = fakeAgent({ id: "root", config: { name: "root" }, createdAt: 1, status: { kind: "running", startedAt: 1 } });
  let grandchildArrived = false;
  let capturedListener: any;
  let resolveBatch!: () => void;

  const fakeManager = {
    listSessions(): any[] { return grandchildArrived ? [rootView, grandView()] : [rootView]; },
    subtreeOf(rootIds: string[]) {
      if (!rootIds.includes("root")) return [];
      return grandchildArrived ? [rootView, grandView()] : [rootView];
    },
    onAgentUpdate(listener: any) {
      capturedListener = listener;
      return () => { capturedListener = undefined; };
    },
    suspendAgentSlotDuring<T>(_id: string, fn: () => Promise<T>) { return fn(); },
    startBatch(_ctx: any, _signal: any, _tasks: any[], _onUpdate: any) {
      // Don't emit any batch updates ourselves — let the cross-batch listener be the only source.
      const resultsPromise = new Promise<any[]>(resolve => {
        resolveBatch = () => resolve([{ agent: "root", prompt: "go", status: "completed", output: "ok", sessionId: "root", resumable: false, resumed: false }]);
      });
      return { groupId: "g1", sessions: [rootView], resultsPromise };
    },
  };

  function grandView() {
    return fakeAgent({ id: "grand", parentSessionId: "root", config: { name: "grand" }, createdAt: 2, status: { kind: "running", startedAt: 1 } });
  }

  const tool = registerExtension({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
    settingsStore: { async load() { return { settings: { widgetPlacement: "belowEditor" } }; } },
  });

  const executePromise = tool.execute(
    "tool-call",
    { action: "run", tasks: [{ agent: "root", prompt: "go" }] },
    undefined,
    (partial: any) => partials.push(partial),
    baseCtx(),
  );

  // Wait for the tool to register its cross-batch listener.
  await new Promise(r => setTimeout(r, 10));
  assert.ok(capturedListener, "expected the tool to register an onAgentUpdate listener");

  // Simulate the grandchild's first status change.
  grandchildArrived = true;
  capturedListener({ id: "grand", parentSessionId: "root", agentName: "grand" }, "status");

  await new Promise(r => setTimeout(r, 50));
  resolveBatch();
  await executePromise;

  const lastPartialWithSubtree = partials.filter(p => Array.isArray(p.details.subtree)).at(-1);
  assert.ok(lastPartialWithSubtree, "expected at least one partial with a subtree");
  assert.deepEqual(
    lastPartialWithSubtree.details.subtree.map((s: any) => s.id),
    ["root", "grand"],
  );
});

test("partial tool results carry the full descendant subtree; final tool result stays flat", async () => {
  const partials: any[] = [];
  const rootView = fakeAgent({ id: "root", config: { name: "root" }, createdAt: 1, status: { kind: "running", startedAt: 1 } });
  const childView = fakeAgent({ id: "child", parentSessionId: "root", config: { name: "child" }, createdAt: 2, status: { kind: "running", startedAt: 1 } });

  const fakeManager = {
    listSessions(): any[] { return [rootView, childView]; },
    subtreeOf(rootIds: string[]) {
      // For any call that includes "root" as a root id, return both root and child.
      if (rootIds.includes("root")) return [rootView, childView];
      return [];
    },
    onAgentUpdate(_listener: any) { return () => {}; },
    suspendAgentSlotDuring<T>(_id: string, fn: () => Promise<T>) { return fn(); },
    startBatch(_ctx: any, _signal: any, _tasks: any[], onUpdate: any) {
      // Drive one partial update first, then resolve with the final flat result.
      Promise.resolve().then(() => {
        onUpdate({ sessions: [rootView], active: true });
      });
      const resultsPromise = new Promise<any[]>(resolve => {
        setTimeout(() => resolve([{ agent: "root", prompt: "go", status: "completed", output: "ok", sessionId: "root", resumable: false, resumed: false }]), 10);
      });
      return { groupId: "g1", sessions: [rootView], resultsPromise };
    },
  };

  const tool = registerExtension({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
    settingsStore: { async load() { return { settings: { widgetPlacement: "belowEditor" } }; } },
  });

  const final = await tool.execute(
    "tool-call",
    { action: "run", tasks: [{ agent: "root", prompt: "go" }] },
    undefined,
    (partial: any) => partials.push(partial),
    baseCtx(),
  );

  // Partial(s) include the subtree (both root and child visible)
  assert.ok(partials.length >= 1, `expected at least one partial; got ${partials.length}`);
  const lastPartial = partials[partials.length - 1];
  assert.deepEqual(
    (lastPartial.details.subtree ?? []).map((s: any) => s.id),
    ["root", "child"],
  );

  // Final result does NOT include subtree — stays flat batch-only
  assert.equal(final.details.subtree, undefined);
  assert.deepEqual(final.details.group.sessions.map((s: any) => s.id), ["root"]);
});
