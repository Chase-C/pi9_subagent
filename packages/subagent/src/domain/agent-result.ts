import { Agent } from "./agent.js";
import type { AgentRunStatus } from "./agent-view.js";

export interface AgentRunResult {
  agent: string;
  label?: string;
  prompt: string;
  status: AgentRunStatus;
  output?: string;
  error?: string;
  model?: string;
  sessionId?: string;
  resumable: boolean;
  resumed: boolean;
}

export type FinalizeRunArgs =
  | { status: "completed"; output?: string; error?: never; resumed?: boolean }
  | { status: Exclude<AgentRunStatus, "completed">; output?: never; error?: string; resumed?: boolean };

export function finalizeRun(agent: Agent, prompt: string, args: FinalizeRunArgs): AgentRunResult {
  if (agent.status.kind === "done") return agent.status.result;
  const result = agent.buildResult(prompt, args);
  agent.finalize(result);
  return result;
}

export function completedRun(agent: Agent, prompt: string, output: string, resumed = false): AgentRunResult {
  return finalizeRun(agent, prompt, { status: "completed", output, resumed });
}

export function errorRun(agent: Agent, prompt: string, error: string, resumed = false): AgentRunResult {
  return finalizeRun(agent, prompt, { status: "error", error, resumed });
}

export function interruptedRun(agent: Agent, prompt: string, error: string, resumed = false): AgentRunResult {
  return finalizeRun(agent, prompt, { status: "interrupted", error, resumed });
}

export function skippedRun(agent: Agent, prompt: string, resumed = false): AgentRunResult {
  return finalizeRun(agent, prompt, { status: "skipped", error: "Agent skipped.", resumed });
}
