import { describe, expect, it } from "vitest";
import { createPromptSnapshotStore } from "../src/prompt-snapshot.js";

describe("createPromptSnapshotStore", () => {
  it("starts with no captured snapshot", () => {
    const store = createPromptSnapshotStore();
    expect(store.getLatest()).toBeNull();
  });

  it("captures system prompt and options from before_agent_start data", () => {
    const store = createPromptSnapshotStore();
    const capturedAt = 1_700_000_000_000;

    store.capture({
      systemPrompt: "You are helpful.",
      systemPromptOptions: {
        cwd: "/project",
        contextFiles: [{ path: "AGENTS.md", content: "rules" }],
      },
      capturedAt,
    });

    expect(store.getLatest()).toEqual({
      capturedAt,
      systemPrompt: "You are helpful.",
      options: {
        cwd: "/project",
        contextFiles: [{ path: "AGENTS.md", content: "rules" }],
      },
    });
  });

  it("replaces the previous snapshot on each capture", () => {
    const store = createPromptSnapshotStore();

    store.capture({
      systemPrompt: "first",
      systemPromptOptions: { cwd: "/a" },
      capturedAt: 100,
    });
    store.capture({
      systemPrompt: "second",
      systemPromptOptions: { cwd: "/b" },
      capturedAt: 200,
    });

    expect(store.getLatest()?.systemPrompt).toBe("second");
    expect(store.getLatest()?.capturedAt).toBe(200);
  });

  it("clones context files so later mutations do not affect the snapshot", () => {
    const store = createPromptSnapshotStore();
    const contextFiles = [{ path: "AGENTS.md", content: "rules" }];

    store.capture({
      systemPrompt: "You are helpful.",
      systemPromptOptions: {
        cwd: "/project",
        contextFiles,
      },
    });

    contextFiles[0].content = "changed";
    contextFiles.push({ path: "OTHER.md", content: "more" });

    expect(store.getLatest()?.options.contextFiles).toEqual([
      { path: "AGENTS.md", content: "rules" },
    ]);
  });
});
