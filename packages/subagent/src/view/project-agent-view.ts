import type { Agent } from "../domain/agent.js";
import type { AgentView, AgentViewStatus } from "../domain/agent-view.js";
import type { SubagentDisplaySettings } from "../ui/settings.js";
import { compact, compactMultiline } from "./view-helpers.js";

/**
 * Build the session DTO from a domain Agent. Lives in the view layer so the
 * domain object stays free of display/snippet/runtime-timing concerns. Snippet
 * compaction uses the passed display settings, which keeps the mapping pure for
 * a given (agent snapshot, settings) pair.
 */
export function projectAgentView(
  agent: Agent,
  display: SubagentDisplaySettings,
  options: { inputIndex?: number } = {},
): AgentView {
  const activity = agent.activitySnapshot();
  const label = agent.label;
  const prompt = agent.activePrompt;
  const dispatch = agent.background ? "background" : "foreground";
  const retention = agent.background || agent.resumable ? "persistent" : "transient";
  const active = agent.status.kind === "queued" || agent.status.kind === "running";
  return {
    id: agent.id,
    ...(options.inputIndex !== undefined ? { inputIndex: options.inputIndex } : {}),
    ...(agent.parentSessionId !== undefined ? { parentSessionId: agent.parentSessionId } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    createdAt: agent.createdAt,
    dispatch,
    retention,
    config: {
      name: agent.agentName,
      description: agent.config.description,
      source: agent.config.source,
      sourcePath: agent.config.sourcePath,
      model: agent.spawn.model ?? agent.config.model,
      thinking: agent.spawn.thinking ?? agent.config.thinking,
      tools: agent.config.tools,
      ...(agent.config.skills !== undefined ? { skills: agent.config.skills } : {}),
      resumable: agent.resumable,
    },
    status: projectStatus(agent, display),
    activity: {
      messageSnippet: activity.message ? compact(activity.message, display.messageSnippetLength) : undefined,
      turns: activity.turns,
      compactions: activity.compactions,
      toolHistory: activity.toolHistory,
    },
    usage: activity.usage,
    capabilities: {
      canResume: agent.canResume,
      canClear: agent.resumable && !active,
    },
  };
}

function projectStatus(agent: Agent, display: SubagentDisplaySettings): AgentViewStatus {
  const status = agent.status;
  if (status.kind === "queued") return { kind: "queued", queuedAt: status.queuedAt };
  if (status.kind === "running") return { kind: "running", startedAt: status.startedAt };
  const result = status.result;
  const rawSnippet = result.status === "completed" ? result.output : result.error ?? result.status;
  return {
    kind: "done",
    outcome: result.status,
    completedAt: status.completedAt,
    ...(status.startedAt !== undefined ? { startedAt: status.startedAt } : {}),
    ...(rawSnippet ? { snippet: compactMultiline(rawSnippet, display.outputSnippetLength, display.outputSnippetMaxLines) } : {}),
  };
}
