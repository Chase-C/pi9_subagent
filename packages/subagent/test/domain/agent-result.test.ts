import { test } from "vitest";
import assert from "node:assert/strict";

import { Agent, type AgentUpdateListener } from "../../src/domain/agent.js";
import type { AgentViewStatus } from "../../src/domain/agent-snapshot.js";
import { completedRun, errorRun, interruptedRun } from "../../src/domain/agent-finalize.js";
import { toResult } from "../../src/domain/agent-result.js";

const noop: AgentUpdateListener = () => {};

function doneStatus(agent: Agent): Extract<AgentViewStatus, { kind: "done" }> {
  if (agent.status.kind !== "done") throw new Error(`expected done, got ${agent.status.kind}`);
  return agent.status;
}

const baseConfig = {
  retainConversation: false,
  name: "helper",
  description: "d",
  systemPrompt: "s",
  source: "project" as const,
};

test("finalize returns a terminal snapshot that projects the agent label across outcomes", () => {
  const labeled = new Agent("id1", baseConfig, { kind: "spawn", agent: "helper", prompt: "work", label: "researcher" }, noop);
  assert.equal(toResult(completedRun(labeled, "done")).label, "researcher");

  const labeledErr = new Agent("id2", baseConfig, { kind: "spawn", agent: "helper", prompt: "work", label: "researcher" }, noop);
  assert.equal(toResult(errorRun(labeledErr, "fail")).label, "researcher");

  const labeledInt = new Agent("id3", baseConfig, { kind: "spawn", agent: "helper", prompt: "work", label: "researcher" }, noop);
  assert.equal(toResult(interruptedRun(labeledInt, "stop")).label, "researcher");

  const unlabeled = new Agent("id4", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);
  const result = toResult(completedRun(unlabeled, "done"));
  assert.equal(Object.prototype.hasOwnProperty.call(result, "label"), false);
});

test("the terminal snapshot carries parentSessionId when the agent has one and omits it otherwise", () => {
  const session = { subscribe: () => () => {}, abort: () => {} };

  const child = new Agent("c1", baseConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop, { parentId: "root-1" });
  child.bindSession(session as any);
  assert.equal(completedRun(child, "done").parentSessionId, "root-1");

  const root = new Agent("r1", baseConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  root.bindSession(session as any);
  assert.equal(Object.prototype.hasOwnProperty.call(completedRun(root, "done"), "parentSessionId"), false);
});

test("the projected result reflects the per-task retainConversation override and exposes the sessionId", () => {
  const config = { ...baseConfig };
  const session = { subscribe: () => () => {}, abort: () => {} };

  const agent = new Agent("id1", config, { kind: "spawn", agent: "helper", prompt: "work", retainConversation: true }, noop);
  agent.bindSession(session as any);
  const result = toResult(completedRun(agent, "done"));

  assert.equal(result.canResume, true);
  assert.equal(result.sessionId, "id1");
  assert.equal(result.kind, "spawn");
  assert.equal(result.dispatch, "foreground");
  assert.deepEqual(result.retentionReasons, ["conversation-policy"]);
  for (const alias of ["resumable", "resumed", "canClear"])
    assert.equal(Object.prototype.hasOwnProperty.call(result, alias), false);
});

test("agent transitions through start, finalize, and is idempotent on second finalize", () => {
  const config = { name: "agent", description: "desc", systemPrompt: "prompt", source: "project" as const, retainConversation: false };
  const spawn = { kind: "spawn" as const, agent: "agent", prompt: "do work" };
  const session = { subscribe: () => () => {}, abort: () => {} };

  const running = new Agent("id", config, spawn, noop);
  running.bindSession(session as any);
  assert.equal(running.status.kind, "running");
  assert.throws(() => running.bindSession(session as any), /Cannot bind/);

  completedRun(running, "done");
  const firstDone = doneStatus(running);
  assert.equal(firstDone.outcome, "completed");
  assert.equal(firstDone.output, "done");

  errorRun(running, "late");
  const stillDone = doneStatus(running);
  assert.equal(stillDone.outcome, "completed", "finalize is idempotent — terminal state is sticky");

  const queued = new Agent("q", config, spawn, noop);
  errorRun(queued, "failed before start");
  const queuedDone = doneStatus(queued);
  assert.equal(queuedDone.outcome, "error");
  assert.equal(queuedDone.error, "failed before start");
});

test("finalize is idempotent and returns the existing terminal snapshot when already done", () => {
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);
  agent.bindSession({ subscribe: () => () => {}, abort: () => {} } as any);
  const first = completedRun(agent, "done");

  const second = errorRun(agent, "late");
  assert.equal(second.status.kind === "done" && second.status.outcome, "completed");
  assert.equal(toResult(second).output, toResult(first).output);
});
