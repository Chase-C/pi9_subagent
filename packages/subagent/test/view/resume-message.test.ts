import { test } from "vitest";
import assert from "node:assert/strict";

import { createSubagentResumeMessage } from "../../src/view/resume-message.js";

test("subagent resume message keeps context concise while preserving structured result details", () => {
  const fullOutput = `done ${"x".repeat(1500)} secret-tail`;
  const message = createSubagentResumeMessage({
    agent: "helper",
    prompt: `follow up ${"y".repeat(300)} prompt-tail`,
    status: "completed",
    output: fullOutput,
    sessionId: "s1",
  });

  assert.equal(message.customType, "subagent-resume");
  assert.equal(message.display, true);
  assert.match(message.content, /Subagent resume completed/);
  assert.match(message.content, /agent: helper/);
  assert.match(message.content, /session: s1/);
  assert.match(message.content, /prompt: follow up/);
  assert.match(message.content, /output: done/);
  assert.equal(message.content.includes("prompt-tail"), false);
  assert.equal(message.content.includes("secret-tail"), false);
  assert.ok(message.content.length < 700);
  assert.equal((message.details.result as { output: string }).output, fullOutput);
  assert.equal(message.details.promptPreview.includes("prompt-tail"), false);
  assert.equal(message.details.outputSnippet!.includes("secret-tail"), false);
});
