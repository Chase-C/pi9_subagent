import { test } from "vitest";
import assert from "node:assert/strict";

import { inspectHelp, listHelp } from "../../src/command/input.js";
import { formatSubagentSessionInspect } from "../../src/view/format.js";
import { fakeAgent } from "../helpers/fake-agent.js";

test("subagent session help and inspect actions use remove terminology", () => {
  const retainedSession = fakeAgent({
    config: { resumable: true },
    status: { kind: "completed", startedAt: 2_000, completedAt: 5_000, response: "done" },
  });

  assert.match(listHelp(retainedSession), /c remove retained/);
  assert.doesNotMatch(listHelp(retainedSession), /clear/);
  assert.match(inspectHelp(retainedSession), /c remove/);
  assert.doesNotMatch(inspectHelp(retainedSession), /clear/);
  assert.match(formatSubagentSessionInspect(retainedSession).join("\n"), /Actions: inspect, resume, remove/);
  assert.doesNotMatch(formatSubagentSessionInspect(retainedSession).join("\n"), /clear/);
});
