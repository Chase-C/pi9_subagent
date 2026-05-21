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
  parentSessionId?: string;
  resumable: boolean;
  resumed: boolean;
}

export type FinalizeRunArgs =
  | { status: "completed"; output?: string; error?: never; resumed?: boolean }
  | { status: Exclude<AgentRunStatus, "completed">; output?: never; error?: string; resumed?: boolean };

export interface AgentResultContext {
  sessionId: string;
  agentName: string;
  label?: string;
  prompt: string;
  model?: string;
  parentSessionId?: string;
  resumable: boolean;
}

/** Build an AgentRunResult from a plain context snapshot. Pure: no domain dependency. */
export function buildAgentResult(ctx: AgentResultContext, args: FinalizeRunArgs): AgentRunResult {
  return {
    agent: ctx.agentName,
    ...(ctx.label !== undefined ? { label: ctx.label } : {}),
    prompt: ctx.prompt,
    ...(ctx.model !== undefined ? { model: ctx.model } : {}),
    resumable: ctx.resumable,
    resumed: Boolean(args.resumed),
    status: args.status,
    ...(ctx.resumable ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.parentSessionId !== undefined ? { parentSessionId: ctx.parentSessionId } : {}),
    ...(args.output !== undefined ? { output: args.output } : {}),
    ...(args.error !== undefined ? { error: args.error } : {}),
  };
}
