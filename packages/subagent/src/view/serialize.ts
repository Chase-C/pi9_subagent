import type { AgentConfig } from "../domain/agent-config.js";
import type { AgentRegistry } from "../domain/agent-registry.js";
import type { AgentGroupView, AgentSnapshot } from "../domain/agent-snapshot.js";
import { effectiveStatus, isActiveStatusKind } from "../domain/agent-decisions.js";
import type { SessionStatus } from "../schema.js";

export function serializeGroup(sessions: AgentSnapshot[]): AgentGroupView {
  const statusCounts: Record<string, number> = {};
  for (const session of sessions) {
    const status = effectiveStatus(session.status);
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }

  return {
    statusCounts,
    sessions,
    isError: sessions.some(session => {
      const status = effectiveStatus(session.status);
      return !isActiveStatusKind(status) && status !== "completed";
    }),
  };
}

export function serializeAgentConfig(config: AgentConfig) {
  return {
    name: config.name,
    description: config.description,
    source: config.source,
    model: config.model,
    thinking: config.thinking,
    tools: config.tools,
    skills: config.skills,
    resumable: config.resumable,
    sourcePath: config.sourcePath,
  };
}

export function listAgentDefinitions(agentRegistry: AgentRegistry) {
  return Array.from(agentRegistry.agents.values()).map(serializeAgentConfig);
}

export function listAgentDefinitionsForModel(agentRegistry: AgentRegistry) {
  return listAgentDefinitions(agentRegistry).map(({ resumable, ...agent }) => ({
    ...agent,
    defaultResumable: resumable,
  }));
}

export interface ModelInventoryEntry {
  sessionId: string;
  agent: string;
  label?: string;
  parentSessionId?: string;
  status: SessionStatus;
  dispatch: AgentSnapshot["dispatch"];
  capabilities: {
    canResume: boolean;
    canRemove: boolean;
  };
}

export interface ModelInventory {
  view: "inventory";
  sessions: ModelInventoryEntry[];
  filter?: { status?: SessionStatus[] };
}

export function serializeInventoryForModel(
  sessions: AgentSnapshot[],
  filter?: { status?: SessionStatus[] },
): ModelInventory {
  return {
    view: "inventory",
    sessions: sessions.map(serializeSessionForModel),
    ...(filter ? { filter } : {}),
  };
}

function serializeSessionForModel(session: AgentSnapshot): ModelInventoryEntry {
  return {
    sessionId: session.id,
    agent: session.config.name,
    ...(session.label !== undefined ? { label: session.label } : {}),
    ...(session.parentSessionId !== undefined ? { parentSessionId: session.parentSessionId } : {}),
    status: serializeStatusForInventory(session.status),
    dispatch: session.dispatch,
    capabilities: {
      canResume: session.capabilities.canResume,
      canRemove: session.capabilities.canRemove,
    },
  };
}

function serializeStatusForInventory(status: AgentSnapshot["status"]): SessionStatus {
  return status.kind === "done" ? status.outcome : status.kind;
}
