import { test } from "vitest";
import assert from "node:assert/strict";

import {
  createBackgroundCompletionMessage,
  formatBackgroundCompletionMessage,
} from "../../src/view/background-completion-message.js";
import { DEFAULT_SUBAGENT_SETTINGS } from "../../src/config/settings.js";

const entry = {
  sessionId: "session-1",
  agent: "helper",
  label: "short task",
  status: "completed" as const,
  elapsedMs: 1_250,
};

test("background completion factory keeps content and structured details on the same projection", () => {
  const message = createBackgroundCompletionMessage([entry]);

  assert.deepEqual(message.details, { completions: [entry] });
  assert.equal(message.content, formatBackgroundCompletionMessage(message.details, true, undefined));
});

test("background completion content lists 20 of 21 entries with exact overflow and boundary truncation", () => {
  const display = {
    ...DEFAULT_SUBAGENT_SETTINGS.display,
    toolCallLabelMaxLength: 10,
  };
  const completions = Array.from({ length: 21 }, (_, index) => ({
    sessionId: `session-${index + 1}`,
    agent: "helper",
    ...(index === 0 ? { label: "abcdefghijk" } : {}),
    status: "completed" as const,
    elapsedMs: 1_250,
  }));

  const message = createBackgroundCompletionMessage(completions, display);
  const lines = message.content.split("\n");

  assert.equal(message.details.completions.length, 21, "details retain every completion");
  const entries = lines.filter(line => line.includes("sessionId "));
  assert.equal(entries.length, 20, "content lists only 20 entries");
  assert.match(entries[0], /helper \(abcdefg\.\.\.\).*session-1$/);
  assert.match(entries.at(-1)!, /session-20$/);
  assert.match(message.content, /1 more/);
  assert.doesNotMatch(message.content, /session-21/);

  const collapsed = formatBackgroundCompletionMessage(message.details, false, undefined);
  assert.match(collapsed, /^21 background subagents completed/);
  assert.doesNotMatch(collapsed, /session-1|session-21|Call subagent results/);
});
