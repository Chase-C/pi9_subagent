import { test } from "vitest";
import assert from "node:assert/strict";

import { createSubagentResumeMessage, formatSubagentResumeMessageRender } from "../../src/view/resume-message.js";

const longOutput = `done ${"x".repeat(1500)} secret-tail`;
const longPrompt = `follow up ${"y".repeat(300)} prompt-tail`;

const makeMessage = () => createSubagentResumeMessage({
  agent: "helper",
  prompt: longPrompt,
  status: "completed",
  output: longOutput,
  sessionId: "s1",
});

test("subagent resume message exposes structured identity and result details", () => {
  const message = makeMessage();
  assert.equal(message.customType, "subagent-resume");
  assert.equal(message.display, true);
  assert.equal(message.details.agent, "helper");
  assert.equal(message.details.sessionId, "s1");
  assert.equal(message.details.status, "completed");
  assert.equal((message.details.result as { output: string }).output, longOutput);
});

test("subagent resume message truncates both prompt and output in the displayed content", () => {
  const message = makeMessage();
  assert.equal(message.content.includes("prompt-tail"), false);
  assert.equal(message.content.includes("secret-tail"), false);
  assert.ok(message.content.length < 700, `content length should stay tight, got ${message.content.length}`);
  assert.equal(message.details.promptPreview.includes("prompt-tail"), false);
  assert.equal(message.details.outputSnippet!.includes("secret-tail"), false);
});

test("subagent resume renderer colors status and keeps collapsed output compact", () => {
  const message = makeMessage();
  const rendered = formatSubagentResumeMessageRender(
    message.details,
    false,
    { fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
  );

  assert.match(rendered, /<success>completed<\/success>/);
  assert.doesNotMatch(rendered, /\n/);
  assert.equal(rendered.includes("secret-tail"), false);
});

test("subagent resume renderer expands each detail onto its own line", () => {
  const message = createSubagentResumeMessage({
    agent: "helper",
    prompt: "try another approach",
    status: "error",
    error: "boom",
    sessionId: "s2",
  });

  const rendered = formatSubagentResumeMessageRender(message.details, true, { fg: (_color: string, text: string) => text });

  const lines = rendered.split("\n");
  assert.equal(lines.length, 6);
  const values = new Set(lines.slice(1).map(line => line.slice(line.indexOf(":") + 2)));
  assert.deepEqual(values, new Set(["helper", "error", "s2", "try another approach", "boom"]));
});
