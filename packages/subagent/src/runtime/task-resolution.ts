import { Agent, type AgentUpdateListener } from "../domain/agent.js";
import { AgentRegistry } from "../domain/agent-registry.js";
import type { AgentDispatch } from "../domain/agent-lifecycle.js";
import { preflightFailure } from "../domain/preflight-failure.js";
import type { TaskRequest } from "../schema.js";

export interface ResolveTaskArgs {
  task: TaskRequest;
  dispatch: AgentDispatch;
  groupId: string;
  inputIndex: number;
  registry: AgentRegistry;
  findAgent: (id: string) => Agent | undefined;
  allocateSessionId: () => string | undefined;
  listener: AgentUpdateListener;
  parentId?: string;
}

/** Resolve one task and apply a valid resume transition to its existing Agent. */
export function resolveTask(args: ResolveTaskArgs) {
  const { task, dispatch, registry, findAgent, listener, parentId } = args;
  if (task.kind === "spawn") {
    const config = registry.agents.get(task.agent);
    if (config) {
      const id = args.allocateSessionId();
      if (id !== undefined) {
        return {
          kind: "spawn" as const,
          agent: new Agent(id, config, task, listener, { dispatch, parentId }),
        };
      }

      return {
        kind: "failure" as const,
        failure: preflightFailure(
          { groupId: args.groupId, inputIndex: args.inputIndex, task, dispatch },
          { error: "Subagent session ID space exhausted." },
        ),
      };
    }

    const available = Array.from(registry.agents.values()).map(a => `- ${a.name} (${a.source})`).join("\n");
    const error = `Unknown agent: ${task.agent}. Available agents:\n${available}`;
    return {
      kind: "failure" as const,
      failure: preflightFailure({ groupId: args.groupId, inputIndex: args.inputIndex, task, dispatch }, { error }),
    };
  }

  const target = findAgent(task.sessionId);
  let error: string | undefined;
  if (!target) {
    error = `Unknown retained subagent session: ${task.sessionId}`;
  } else if (target.hasCurrentAttempt) {
    error = `Cannot resume subagent session ${task.sessionId}: it is already resuming.`;
  } else if (!target.retentionDecision.canResume) {
    error = `Cannot resume subagent session ${task.sessionId} while it is ${target.status.kind === "done" ? target.status.outcome : target.status.kind}.`;
  } else {
    target.beginResume(task.prompt, dispatch);
    return { kind: "resume" as const, agent: target };
  }

  return {
    kind: "failure" as const,
    failure: preflightFailure(
      { groupId: args.groupId, inputIndex: args.inputIndex, task, dispatch },
      { error: error!, target: target ? {
        id: target.id,
        agentName: target.agentName,
        label: target.label,
        config: target.config,
        requestedConfig: target.requestedConfig,
      } : undefined },
    ),
  };
}
