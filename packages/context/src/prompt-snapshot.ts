import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

export interface PromptSnapshot {
  capturedAt: number;
  systemPrompt: string;
  options: BuildSystemPromptOptions;
}

export interface PromptSnapshotCaptureInput {
  systemPrompt: string;
  systemPromptOptions: BuildSystemPromptOptions;
  capturedAt?: number;
}

export interface PromptSnapshotStore {
  capture(input: PromptSnapshotCaptureInput): void;
  getLatest(): PromptSnapshot | null;
}

export function cloneSystemPromptOptions(
  options: BuildSystemPromptOptions,
): BuildSystemPromptOptions {
  return {
    ...options,
    selectedTools: options.selectedTools ? [...options.selectedTools] : undefined,
    toolSnippets: options.toolSnippets ? { ...options.toolSnippets } : undefined,
    promptGuidelines: options.promptGuidelines ? [...options.promptGuidelines] : undefined,
    contextFiles: options.contextFiles?.map((file) => ({
      path: file.path,
      content: file.content,
    })),
    skills: options.skills ? [...options.skills] : undefined,
  };
}

export function createPromptSnapshotStore(): PromptSnapshotStore {
  let latest: PromptSnapshot | null = null;

  return {
    capture(input) {
      latest = {
        capturedAt: input.capturedAt ?? Date.now(),
        systemPrompt: input.systemPrompt,
        options: cloneSystemPromptOptions(input.systemPromptOptions),
      };
    },
    getLatest() {
      return latest;
    },
  };
}
