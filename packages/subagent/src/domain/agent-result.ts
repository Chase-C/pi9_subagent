import { getQueuedAt, getStartedAt } from "./agent-decisions.js";
import type {
  AgentDispatch,
  AgentRetentionReason,
  AgentRunStatus,
  AttemptKind,
} from "./agent-lifecycle.js";
import type { AgentEffectiveConfig, AgentSnapshot } from "./agent-snapshot.js";

export interface AgentResult {
  agent: string;
  label?: string;
  prompt: string;
  status: AgentRunStatus;
  output?: string;
  error?: string;
  model?: string;
  effectiveConfig?: AgentEffectiveConfig;
  sessionId?: string;
  kind: AttemptKind;
  dispatch: AgentDispatch;
  canResume: boolean;
  retentionReasons: readonly AgentRetentionReason[];
  turns: number;
  tokens: number;
  elapsedMs: number;
}

export function toResult(snapshot: AgentSnapshot): AgentResult {
  const done = snapshot.status.kind === "done" ? snapshot.status : undefined;
  const elapsedMs =
    done?.startedAt !== undefined ? done.completedAt - done.startedAt : 0;
  const cataloged =
    snapshot.status.kind !== "done" ||
    snapshot.retention.catalog === "persistent";
  return {
    agent: snapshot.config.name,
    ...(snapshot.label !== undefined ? { label: snapshot.label } : {}),
    prompt: snapshot.prompt ?? "",
    status: done?.outcome ?? "error",
    ...(done?.output !== undefined ? { output: done.output } : {}),
    ...(done?.error !== undefined ? { error: done.error } : {}),
    ...(snapshot.config.model !== undefined
      ? { model: snapshot.config.model }
      : {}),
    ...(snapshot.effectiveConfig
      ? { effectiveConfig: snapshot.effectiveConfig }
      : {}),
    ...(cataloged ? { sessionId: snapshot.id } : {}),
    kind: snapshot.attempt.kind,
    dispatch: snapshot.attempt.dispatch,
    canResume: snapshot.capabilities.canResume,
    retentionReasons: snapshot.retention.reasons,
    turns: snapshot.activity.turns,
    tokens: snapshot.usage?.totalTokens ?? 0,
    elapsedMs,
  };
}

export type ResultEntry =
  { snapshot: AgentSnapshot } | { sessionId: string; error: string };
export type BackgroundResult =
  | { sessionId?: string; ready: true; result: AgentResult }
  | {
      sessionId: string;
      ready: false;
      status: "queued" | "running";
      elapsedMs: number;
      agent: string;
      label?: string;
    }
  | { sessionId: string; error: string };

export function toResults(
  entries: readonly ResultEntry[],
  opts: { exposeId?: boolean } = {},
): BackgroundResult[] {
  return entries.map((entry) => {
    if ("error" in entry)
      return { sessionId: entry.sessionId, error: entry.error };
    const { snapshot } = entry;
    if (snapshot.status.kind === "done") {
      const result = toResult(snapshot);
      const sessionId = opts.exposeId ? snapshot.id : result.sessionId;
      return {
        ...(sessionId !== undefined ? { sessionId } : {}),
        ready: true,
        result,
      };
    }
    const beginAt =
      getStartedAt(snapshot.status) ??
      getQueuedAt(snapshot.status) ??
      snapshot.createdAt;
    return {
      sessionId: snapshot.id,
      ready: false,
      status: snapshot.status.kind,
      elapsedMs: Math.max(0, Date.now() - beginAt),
      agent: snapshot.config.name,
      ...(snapshot.label !== undefined ? { label: snapshot.label } : {}),
    };
  });
}
