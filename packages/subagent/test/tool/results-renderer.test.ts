import { test } from "vitest";
import assert from "node:assert/strict";

import subagentExtension from "../../src/index.js";
import { fakeAgent } from "../helpers/fake-agent.js";

function registerExtension() {
  let registeredTool: any;
  subagentExtension({ registerTool: (tool: any) => { registeredTool = tool; } } as any);
  return registeredTool;
}

const passthroughTheme = { fg: (_color: string, text: string) => text };

function render(details: any, expanded: boolean): string {
  const tool = registerExtension();
  const component = tool.renderResult(
    { content: [{ type: "text", text: JSON.stringify(details) }], details },
    { expanded },
    passthroughTheme,
  );
  return component.render(120).join("\n");
}

test("results collapsed counts ready entries by outcome and pending entries by state", () => {
  const details = {
    view: "results",
    results: [
      { snapshot: fakeAgent({ id: "s1", config: { name: "a" }, status: { kind: "completed", startedAt: 1, completedAt: 2, response: "ok" } }) },
      { snapshot: fakeAgent({ id: "s2", config: { name: "a" }, status: { kind: "running", startedAt: 1 } }) },
      { sessionId: "s3", error: "Unknown subagent session: s3" },
    ],
  };

  const rendered = render(details, false);

  assert.match(rendered, /3 results/);
  assert.match(rendered, /1 completed/);
  assert.match(rendered, /1 running/);
  assert.match(rendered, /1 error/);
});

test("results collapsed omits zero-count segments", () => {
  const details = {
    view: "results",
    results: [
      { snapshot: fakeAgent({ id: "s1", config: { name: "a" }, status: { kind: "completed", startedAt: 1, completedAt: 2, response: "ok" } }) },
    ],
  };

  const rendered = render(details, false);

  assert.match(rendered, /1 result/);
  assert.match(rendered, /1 completed/);
  assert.doesNotMatch(rendered, /running|queued/);
  assert.doesNotMatch(rendered, /error/);
});

test("results expanded shows a section per entry with status, snippet, and error", () => {
  const details = {
    view: "results",
    results: [
      { snapshot: fakeAgent({ id: "ready-id", label: "phase 1", config: { name: "helper", resumable: true }, status: { kind: "completed", startedAt: 1, completedAt: 2, response: "all done" } }) },
      { snapshot: fakeAgent({ id: "queued-id", label: "phase 2", config: { name: "helper" }, status: { kind: "queued", queuedAt: 1 } }) },
      { sessionId: "err-id", error: "Unknown subagent session: err-id" },
    ],
  };

  const rendered = render(details, true);

  assert.match(rendered, /helper/);
  assert.match(rendered, /phase 1/);
  assert.match(rendered, /all done/);
  assert.match(rendered, /session:ready-id/);
  assert.match(rendered, /queued/);
  assert.match(rendered, /phase 2/);
  assert.match(rendered, /err-id/);
  assert.match(rendered, /Unknown subagent session: err-id/);
});

test("results expanded omits session label for ready entries without a collectable session id", () => {
  const details = {
    view: "results",
    results: [
      { snapshot: fakeAgent({ id: "x", config: { name: "helper" }, status: { kind: "completed", startedAt: 1, completedAt: 2, response: "all done" } }) },
    ],
  };

  const rendered = render(details, true);

  assert.match(rendered, /helper/);
  assert.match(rendered, /all done/);
  assert.doesNotMatch(rendered, /session:/);
});
