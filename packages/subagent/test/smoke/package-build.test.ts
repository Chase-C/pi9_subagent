import { test } from "vitest";
import assert from "node:assert/strict";

// Smoke test the shipped artifact (`dist/`) by exercising the public surface end-to-end.
// All other suites import the TypeScript source directly for fast feedback; this one
// catches build regressions: missing exports, broken types compilation, accidental
// changes to the published module entry. Run via `npm run test:smoke` which builds first.

test("the built package registers a subagent tool with the documented shape", async () => {
  const { default: subagentExtension } = await import("../../dist/index.js");
  let registeredTool: any;
  const commands = new Map<string, any>();

  subagentExtension({
    registerTool: (tool: any) => { registeredTool = tool; },
    registerCommand: (name: string, command: any) => commands.set(name, command),
  } as any);

  assert.equal(registeredTool.name, "subagent");
  assert.equal(typeof registeredTool.execute, "function");
  assert.equal(typeof registeredTool.renderResult, "function");
  assert.match(registeredTool.description, /action="run"/);
  assert.match(registeredTool.description, /action="remove"/);
  assert.ok(commands.has("subagents"));
  assert.equal(typeof commands.get("subagents").handler, "function");
});

test("the built package surfaces parseTask and TaskSchema from schema.js", async () => {
  const { parseTask, TaskSchema, SESSION_STATUSES, isSessionStatus } =
    (await import("../../dist/schema.js")) as typeof import("../../src/schema.js");

  assert.equal(typeof parseTask, "function");
  assert.ok(TaskSchema);
  assert.deepEqual(
    [...SESSION_STATUSES].sort(),
    ["aborted", "completed", "error", "interrupted", "queued", "running", "skipped"],
  );
  assert.equal(isSessionStatus("running"), true);
  assert.equal(isSessionStatus("not-a-status"), false);

  const spawn = parseTask({ agent: "helper", prompt: "do it" });
  assert.equal("error" in spawn, false);
  if (!("error" in spawn)) assert.equal(spawn.kind, "spawn");
});
