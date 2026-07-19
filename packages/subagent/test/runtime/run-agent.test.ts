import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test, vi } from "vitest";
import { Agent } from "../../src/domain/agent.js";
import { completedRun } from "../../src/domain/agent-finalize.js";
import { ResolveModel, ResolveTaskCwd, RunAttempt } from "../../src/runtime/run-agent.js";

const config = { name: "worker", description: "", systemPrompt: "", source: "project" } as any;
function resumable(messages: any[], prompt: () => Promise<void>, abort = vi.fn()) {
  const agent = new Agent("amber-acorn" as any, "adapt-ably" as any, config, { kind: "spawn", agent: "worker", prompt: "first" }, () => {});
  const session = { messages, subscribe: () => () => {}, prompt, abort } as any;
  agent.bindSession(session); completedRun(agent, "adapt-ably" as any, "first");
  const attempt = agent.beginResume("balance-boldly" as any, "continue");
  return { agent, attempt, session, abort };
}

test("resume completes with the final assistant text", async () => {
  const f = resumable([{ role: "assistant", content: [{ type: "text", text: "finished" }] }], async () => {});
  await expect(RunAttempt({} as any, f.agent, f.attempt)).resolves.toMatchObject({ status: { kind: "done", outcome: "completed", output: "finished" } });
});

test("assistant errors and prompt failures terminalize the run as errors", async () => {
  const modelError = resumable([{ role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "error", errorMessage: "model failed" }], async () => {});
  await expect(RunAttempt({} as any, modelError.agent, modelError.attempt)).resolves.toMatchObject({ status: { kind: "done", outcome: "error", error: "model failed" } });
  const thrown = resumable([], async () => { throw new Error("transport failed"); });
  await expect(RunAttempt({} as any, thrown.agent, thrown.attempt)).resolves.toMatchObject({ status: { kind: "done", outcome: "error", error: "transport failed" } });
});

test("cancellation aborts the SDK session and records interruption", async () => {
  let reject!: (error: Error) => void;
  const f = resumable([], () => new Promise<void>((_, r) => { reject = r; }));
  const controller = new AbortController();
  const result = RunAttempt({} as any, f.agent, f.attempt, controller.signal);
  await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
  controller.abort(); reject(new Error("cancelled"));
  await expect(result).resolves.toMatchObject({ status: { kind: "done", outcome: "interrupted", error: "cancelled" } });
  expect(f.abort).toHaveBeenCalled();
});

function model(provider: string, id: string) {
  return { provider, id } as any;
}

function registry(...models: any[]) {
  return { getAll: () => models } as any;
}

test("resolves canonical and unique bare model references", () => {
  const parent = model("parent-provider", "parent-model");
  const qualified = model("other-provider", "shared");
  const unique = model("other-provider", "other-model");
  const models = registry(qualified, unique);

  expect(ResolveModel("other-provider/shared", parent, models)).toEqual({ ok: true, value: qualified });
  expect(ResolveModel("other-model", parent, models)).toEqual({ ok: true, value: unique });
});

test("resolves canonical references whose model IDs contain slashes", () => {
  const canonical = model("openrouter", "anthropic/claude-3-haiku");
  const bareCollision = model("parent-provider", "openrouter/anthropic/claude-3-haiku");
  const parent = model("parent-provider", "parent-model");

  expect(ResolveModel("openrouter/anthropic/claude-3-haiku", parent, registry(bareCollision, canonical))).toEqual({
    ok: true,
    value: canonical,
  });
});

test("treats the complete reference as a bare model ID when it is not canonical", () => {
  const slashId = model("gateway", "anthropic/claude-3-haiku");
  expect(ResolveModel("anthropic/claude-3-haiku", undefined, registry(slashId))).toEqual({
    ok: true,
    value: slashId,
  });
});

test("uses the parent provider to disambiguate a bare model ID", () => {
  const parent = model("parent-provider", "parent-model");
  const preferred = model("parent-provider", "shared");
  const other = model("other-provider", "shared");

  expect(ResolveModel("shared", parent, registry(other, preferred))).toEqual({ ok: true, value: preferred });
});

test("rejects an ambiguous bare model ID without a parent-provider match", () => {
  const first = model("first-provider", "shared");
  const second = model("second-provider", "shared");
  const parent = model("unmatched-provider", "parent-model");

  expect(ResolveModel("shared", parent, registry(first, second))).toEqual({
    ok: false,
    error: "Ambiguous model \"shared\": matches first-provider/shared, second-provider/shared. Use a provider-qualified model reference.",
  });
});

test("inherits the parent model only when no model is requested", () => {
  const parent = model("parent-provider", "parent-model");
  expect(ResolveModel(undefined, parent, registry())).toEqual({ ok: true, value: parent });
});

test.each([
  "",
  "   ",
  "/",
  "/model",
  "provider/",
  "provider//model",
])("rejects malformed model %j", requested => {
  expect(ResolveModel(requested, undefined, registry())).toMatchObject({
    ok: false,
    error: expect.stringContaining("Invalid model"),
  });
});

test.each(["missing", "provider/missing", "provider/model/extra"])("rejects unknown model %j without falling back", requested => {
  const parent = model("parent-provider", "parent-model");
  expect(ResolveModel(requested, parent, registry(parent))).toEqual({
    ok: false,
    error: `Unknown model: ${requested}`,
  });
});

test("does not reinterpret an unknown qualified reference as a different bare model ID", () => {
  const modelWithSameSuffix = model("known-provider", "known-model");
  expect(ResolveModel("unknown-provider/known-model", undefined, registry(modelWithSameSuffix))).toEqual({
    ok: false,
    error: "Unknown model: unknown-provider/known-model",
  });
});

test("RunAttempt terminalizes an invalid requested model before session allocation", async () => {
  const parent = model("parent-provider", "parent-model");
  const invalidConfig = { ...config, model: "missing" };
  const agent = new Agent("amber-acorn" as any, "adapt-ably" as any, invalidConfig, { kind: "spawn", agent: "worker", prompt: "first" }, () => {});

  await expect(RunAttempt({ cwd: "/unvalidated-parent", model: parent, modelRegistry: registry(parent) } as any, agent, agent.requireCurrentAttempt())).resolves.toMatchObject({
    status: { kind: "done", outcome: "error", error: "Unknown model: missing" },
  });
});

test("resolves and validates relative and absolute requested working directories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "run-agent-cwd-"));
  const relative = path.join("nested", "task");
  const absolute = path.join(root, "absolute");
  await mkdir(path.join(root, relative), { recursive: true });
  await mkdir(absolute);

  expect(ResolveTaskCwd(root, relative)).toEqual({ ok: true, value: path.join(root, relative) });
  expect(ResolveTaskCwd(path.join(root, "unused"), absolute)).toEqual({ ok: true, value: absolute });
});

test("does not revalidate the inherited parent working directory", () => {
  const parentCwd = path.join(tmpdir(), "run-agent-parent-does-not-need-to-exist");
  expect(ResolveTaskCwd(parentCwd, undefined)).toEqual({ ok: true, value: parentCwd });
});

test("rejects missing working directories and files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "run-agent-invalid-cwd-"));
  const missing = path.join(root, "missing");
  const file = path.join(root, "file.txt");
  await writeFile(file, "not a directory");

  expect(ResolveTaskCwd(root, "missing")).toEqual({
    ok: false,
    error: `Working directory does not exist: ${missing}`,
  });
  expect(ResolveTaskCwd(root, "file.txt")).toEqual({
    ok: false,
    error: `Working directory is not a directory: ${file}`,
  });
});
