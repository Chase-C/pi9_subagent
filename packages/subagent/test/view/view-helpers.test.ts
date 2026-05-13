import { test } from "vitest";
import assert from "node:assert/strict";

import { canResumeSubagentSession } from "../../src/view/view-helpers.js";
import { fakeAgent } from "../helpers/fake-agent.js";

test("canResumeSubagentSession allows resume only for completed resumable agents", () => {
  assert.equal(canResumeSubagentSession(fakeAgent({ config: { resumable: true } })), true);
  assert.equal(canResumeSubagentSession(fakeAgent({ config: { resumable: false } })), false);

  const nonCompleted = [
    { kind: "queued" as const },
    { kind: "running" as const, startedAt: 1 },
    { kind: "error" as const, startedAt: 1, errorAt: 2, error: "e", session: {} },
    { kind: "aborted" as const, startedAt: 1, abortedAt: 2, session: {} },
    { kind: "interrupted" as const, startedAt: 1, interruptedAt: 2, session: {} },
    { kind: "skipped" as const, skippedAt: 1 },
  ];
  for (const status of nonCompleted) {
    assert.equal(
      canResumeSubagentSession(fakeAgent({ config: { resumable: true }, status })),
      false,
      status.kind,
    );
  }
});
