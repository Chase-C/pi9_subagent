import { test } from "vitest";
import assert from "node:assert/strict";

import subagentExtension from "../../src/index.js";

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
      { sessionId: "s1", ready: true, result: { agent: "a", prompt: "p", status: "completed", output: "ok", resumable: false, resumed: false } },
      { sessionId: "s2", ready: false, status: "running", elapsedMs: 1000, agent: "a" },
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
      { sessionId: "s1", ready: true, result: { agent: "a", prompt: "p", status: "completed", output: "ok", resumable: false, resumed: false } },
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
      { sessionId: "ready-id", ready: true, result: { agent: "helper", label: "phase 1", prompt: "p", status: "completed", output: "all done", resumable: false, resumed: false } },
      { sessionId: "queued-id", ready: false, status: "queued", elapsedMs: 5000, agent: "helper", label: "phase 2" },
      { sessionId: "err-id", error: "Unknown subagent session: err-id" },
    ],
  };

  const rendered = render(details, true);

  assert.match(rendered, /helper/);
  assert.match(rendered, /phase 1/);
  assert.match(rendered, /all done/);
  assert.match(rendered, /queued/);
  assert.match(rendered, /phase 2/);
  assert.match(rendered, /err-id/);
  assert.match(rendered, /Unknown subagent session: err-id/);
});
