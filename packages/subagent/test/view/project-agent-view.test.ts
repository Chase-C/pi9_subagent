import { test } from "vitest";
import assert from "node:assert/strict";

import { Agent } from "../../src/domain/agent.js";
import { completedRun } from "../../src/domain/agent-finalize.js";
import { DEFAULT_SUBAGENT_SETTINGS } from "../../src/ui/settings.js";
import { projectAgentView } from "../../src/view/project-agent-view.js";

const fakeSession = { subscribe: () => () => {}, abort: () => {} } as any;

const baseConfig = {
  name: "helper",
  description: "d",
  systemPrompt: "s",
  source: "project" as const,
  resumable: false,
};

const displaySettings = DEFAULT_SUBAGENT_SETTINGS.display;

test("projectAgentView labels a fresh foreground spawn as foreground+transient", () => {
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" });
  const view = projectAgentView(agent, displaySettings);
  assert.equal(view.dispatch, "foreground");
  assert.equal(view.retention, "transient");
});

test("projectAgentView marks background-dispatched agents as dispatch=background and retention=persistent", () => {
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, { background: true });
  const view = projectAgentView(agent, displaySettings);
  assert.equal(view.dispatch, "background");
  assert.equal(view.retention, "persistent");
});

test("projectAgentView marks a completed foreground resumable agent as persistent", () => {
  const config = { ...baseConfig, resumable: true };
  const agent = new Agent("id", config, { kind: "spawn", agent: "helper", prompt: "work" });
  agent.attach(fakeSession);
  completedRun(agent, "done");
  const view = projectAgentView(agent, displaySettings);
  assert.equal(view.dispatch, "foreground");
  assert.equal(view.retention, "persistent");
});

test("projectAgentView marks a completed foreground non-resumable agent as transient", () => {
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" });
  agent.attach(fakeSession);
  completedRun(agent, "done");
  const view = projectAgentView(agent, displaySettings);
  assert.equal(view.dispatch, "foreground");
  assert.equal(view.retention, "transient");
});

test("projectAgentView truncates the done snippet to the display settings' outputSnippetLength", () => {
  const tightDisplay = { ...displaySettings, outputSnippetLength: 10, outputSnippetMaxLines: 4 };
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" });
  agent.attach(fakeSession);
  completedRun(agent, "x".repeat(200));
  const view = projectAgentView(agent, tightDisplay);
  if (view.status.kind !== "done") throw new Error("expected done status");
  assert.ok(view.status.snippet);
  assert.ok(view.status.snippet.length <= 10, `snippet was ${view.status.snippet.length} chars`);
});
