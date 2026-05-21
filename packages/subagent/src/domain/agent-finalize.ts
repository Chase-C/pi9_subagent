import { Agent } from "./agent.js";
import { buildAgentResult, type AgentRunResult, type FinalizeRunArgs } from "./agent-result.js";

/** Build an AgentRunResult from the agent's current attempt. Pure: does not mutate the agent. */
export function buildAgentResultFor(agent: Agent, args: FinalizeRunArgs): AgentRunResult {
  return buildAgentResult(agent.resultContext(), args);
}

export function finalizeRun(agent: Agent, args: FinalizeRunArgs): AgentRunResult {
  if (agent.status.kind === "done" && !agent.hasCurrentAttempt) return agent.status.result;
  const result = buildAgentResultFor(agent, args);
  agent.settle(result);
  return result;
}

export function completedRun(agent: Agent, output: string, resumed = false): AgentRunResult {
  return finalizeRun(agent, { status: "completed", output, resumed });
}

export function errorRun(agent: Agent, error: string, resumed = false): AgentRunResult {
  return finalizeRun(agent, { status: "error", error, resumed });
}

export function interruptedRun(agent: Agent, error: string, resumed = false): AgentRunResult {
  return finalizeRun(agent, { status: "interrupted", error, resumed });
}

export function skippedRun(agent: Agent, resumed = false): AgentRunResult {
  return finalizeRun(agent, { status: "skipped", error: "Agent skipped.", resumed });
}
