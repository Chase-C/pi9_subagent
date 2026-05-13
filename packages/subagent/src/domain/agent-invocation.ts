import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

import { ResumeRequest, SpawnRequest, TaskRequest } from "../schema.js";

export interface AgentSpawn {
  agent: string;
  model?: string;
  thinking?: ModelThinkingLevel;
  cwd?: string;
  skills?: string[];
}

export interface AgentInvocation {
  prompt: string;
  label?: string;
  resumable?: boolean;
}

export function InvocationFromTask(
  task: SpawnRequest,
): { spawn: AgentSpawn, invocation: AgentInvocation };

export function InvocationFromTask(
  task: ResumeRequest,
): { invocation: AgentInvocation };

export function InvocationFromTask(
  task: TaskRequest,
): { spawn?: AgentSpawn, invocation: AgentInvocation } {
  let spawn: AgentSpawn | undefined;

  if (task.kind === "spawn") {
    spawn = {
      agent: task.agent,
      ...(task.skills !== undefined ? { skills: task.skills } : {}),
      ...(task.model !== undefined ? { model: task.model } : {}),
      ...(task.thinking !== undefined ? { thinking: task.thinking } : {}),
      ...(task.cwd !== undefined ? { cwd: task.cwd } : {}),
    }
  }

  const invocation: AgentInvocation = {
    prompt: task.prompt,
    ...(task.label !== undefined ? { label: task.label } : {}),
    ...(task.resumable !== undefined ? { resumable: task.resumable } : {}),
  };

  return { spawn, invocation };
}
