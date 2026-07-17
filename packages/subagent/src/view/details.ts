import type { AgentConfig } from "../domain/agent-config.js";
import type { AgentSnapshot } from "../domain/agent-snapshot.js";
import type { ResultEntry } from "../domain/agent-result.js";

export type AgentListingEntry = Omit<AgentConfig, "systemPrompt">;

export type RemoveSummary = {
  removed: number;
  aborted: number;
  sessionIds: string[];
  errors?: Array<{ sessionId: string; error: string }>;
};

export type InventoryFilter = { status?: string[] };

export type BackgroundSpawnHandle = {
  sessionId: string;
  agent: string;
  label?: string;
};

export type BackgroundPreflightError = {
  agent: string;
  label?: string;
  error: string;
};

export type SubagentDetails =
  | { view: "agents"; agents: AgentListingEntry[] }
  | { view: "run"; sessions: AgentSnapshot[]; subtree?: AgentSnapshot[]; runStartedAt?: number }
  | { view: "results"; results: ResultEntry[] }
  | { view: "inventory"; sessions: AgentSnapshot[]; filter?: InventoryFilter }
  | { view: "remove-summary"; summary: RemoveSummary }
  | { view: "background-started"; handles: BackgroundSpawnHandle[]; count: number; errors?: BackgroundPreflightError[] }
  | { view: "error"; errors?: string[] };

export type AgentsDetails = Extract<SubagentDetails, { view: "agents" }>;
export type RunDetails = Extract<SubagentDetails, { view: "run" }>;
export type ResultsDetails = Extract<SubagentDetails, { view: "results" }>;
export type InventoryDetails = Extract<SubagentDetails, { view: "inventory" }>;
export type RemoveSummaryDetails = Extract<SubagentDetails, { view: "remove-summary" }>;
export type BackgroundStartedDetails = Extract<SubagentDetails, { view: "background-started" }>;

export function agentsDetails(agents: AgentListingEntry[]): AgentsDetails {
  return { view: "agents", agents };
}

export function runDetails(sessions: AgentSnapshot[], extras: { subtree?: AgentSnapshot[]; runStartedAt?: number } = {}): RunDetails {
  return { view: "run", sessions, ...extras };
}

export function resultsDetails(results: ResultEntry[]): ResultsDetails {
  return { view: "results", results };
}

export function inventoryDetails(sessions: AgentSnapshot[], filter?: InventoryFilter): InventoryDetails {
  return { view: "inventory", sessions, ...(filter ? { filter } : {}) };
}

export function backgroundStartedDetails(sessions: AgentSnapshot[]): BackgroundStartedDetails {
  const handles: BackgroundSpawnHandle[] = sessions.flatMap(session => {
    const status = session.status;
    if (status.kind === "done" && status.startedAt === undefined) return [];
    return [{
      sessionId: session.id,
      agent: session.config.name,
      ...(session.label !== undefined ? { label: session.label } : {}),
    }];
  });
  const errors = sessions.flatMap(session => {
    const status = session.status;
    if (session.retention.catalog !== "transient" || status.kind !== "done" || status.outcome === "completed" || status.startedAt !== undefined) return [];
    return [{
      agent: session.config.name,
      ...(session.label !== undefined ? { label: session.label } : {}),
      error: status.error ?? `Subagent ${status.outcome}.`,
    }];
  });
  return {
    view: "background-started",
    handles,
    count: handles.length,
    ...(errors.length > 0 ? { errors } : {}),
  };
}
