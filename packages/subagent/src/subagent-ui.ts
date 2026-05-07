import type { Usage } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";

import type { Agent } from "./agent.js";

const PROMPT_PREVIEW_LENGTH = 120;
const MESSAGE_SNIPPET_LENGTH = 200;
const OUTPUT_SNIPPET_LENGTH = 200;

export interface SubagentFinalOutcomeDto {
  status: "completed" | "error" | "aborted" | "skipped" | "interrupted";
  message?: string;
}

export interface SubagentSessionDto {
  id: string;
  sessionId: string;
  groupId: string;
  agent: string;
  status: string;
  resumable: boolean;
  promptPreview: string;
  messageSnippet?: string;
  outputSnippet?: string;
  errorSnippet?: string;
  activeTool?: string;
  turns: number;
  toolUses: number;
  compactions: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  source?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  usage?: Usage;
  inputIndex?: number;
  finalOutcome?: SubagentFinalOutcomeDto;
  availableActions: string[];
}

export interface SubagentGroupDto {
  id: string;
  createdAt: number;
  statusCounts: Record<string, number>;
  sessions: SubagentSessionDto[];
  isError: boolean;
}

export interface SubagentGroupUpdateDto {
  groupId: string;
  group: SubagentGroupDto;
  sessions: SubagentSessionDto[];
  active: boolean;
  updatedAt: number;
}

export function createSubagentGroupDto(
  id: string,
  createdAt: number,
  sessions: SubagentSessionDto[],
): SubagentGroupDto {
  const statusCounts: Record<string, number> = {};
  for (const session of sessions) {
    statusCounts[session.status] = (statusCounts[session.status] ?? 0) + 1;
  }

  return {
    id,
    createdAt,
    statusCounts,
    sessions,
    isError: sessions.some(session => !isActiveStatus(session.status) && session.status !== "completed"),
  };
}

export function createSubagentErrorSessionDto(
  id: string,
  groupId: string,
  task: { agent: string; prompt: string; model?: string },
  error: string,
  createdAt: number,
  inputIndex?: number,
): SubagentSessionDto {
  return {
    id,
    sessionId: id,
    groupId,
    agent: task.agent,
    status: "error",
    resumable: false,
    promptPreview: compact(task.prompt, PROMPT_PREVIEW_LENGTH),
    turns: 0,
    toolUses: 0,
    compactions: 0,
    createdAt,
    completedAt: createdAt,
    model: task.model,
    inputIndex,
    errorSnippet: compact(error, OUTPUT_SNIPPET_LENGTH),
    finalOutcome: { status: "error", message: error },
    availableActions: ["inspect"],
  };
}

export function agentToSessionDto(agent: Agent): SubagentSessionDto {
  const status = agent.status;
  const dto: SubagentSessionDto = {
    id: agent.id,
    sessionId: agent.id,
    groupId: agent.groupId,
    agent: agent.options.agent,
    status: status.kind,
    resumable: Boolean(agent.config.resumable && (status.kind === "queued" || ("session" in status && status.session))),
    promptPreview: compact(agent.options.prompt, PROMPT_PREVIEW_LENGTH),
    messageSnippet: agent.message ? compact(agent.message, MESSAGE_SNIPPET_LENGTH) : undefined,
    activeTool: agent.tool,
    turns: agent.turns,
    toolUses: agent.toolUses,
    compactions: agent.compactions,
    createdAt: agent.createdAt,
    source: agent.config.source,
    model: agent.options.model ?? agent.config.model,
    thinking: agent.options.thinking ?? agent.config.thinking,
    tools: agent.config.tools,
    usage: agent.totalUsage,
    availableActions: ["inspect"],
  };

  if (!isActiveStatus(status.kind) && dto.resumable) dto.availableActions.push("clear");

  if ("startedAt" in status) dto.startedAt = status.startedAt;

  if (status.kind === "completed") {
    dto.completedAt = status.completedAt;
    dto.outputSnippet = compact(status.response, OUTPUT_SNIPPET_LENGTH);
    dto.finalOutcome = { status: "completed" };
  } else if (status.kind === "error") {
    dto.completedAt = status.errorAt;
    dto.errorSnippet = compact(status.error, OUTPUT_SNIPPET_LENGTH);
    dto.finalOutcome = { status: "error", message: status.error };
  } else if (status.kind === "skipped") {
    dto.completedAt = status.skippedAt;
    dto.errorSnippet = "Agent skipped.";
    dto.finalOutcome = { status: "skipped", message: "Agent skipped." };
  } else if (status.kind === "interrupted") {
    dto.completedAt = status.interruptedAt;
    dto.errorSnippet = compact(status.error ?? "Agent interrupted.", OUTPUT_SNIPPET_LENGTH);
    dto.finalOutcome = { status: "interrupted", message: status.error ?? "Agent interrupted." };
  } else if (status.kind === "aborted") {
    dto.completedAt = status.abortedAt;
    dto.errorSnippet = "Agent aborted.";
    dto.finalOutcome = { status: "aborted", message: "Agent aborted." };
  }

  return dto;
}

export function formatSubagentToolLines(
  details: unknown,
  expanded = false,
  now = Date.now(),
): string[] {
  const group = extractGroup(details);
  if (group) {
    if (!expanded) return [formatSubagentGroupLine(group)];
    return group.sessions.map(session => formatSubagentSessionLine(session, now));
  }

  const sessions = extractSessions(details);
  if (sessions.length === 0) return ["No subagent sessions."];

  if (!expanded && sessions.length > 1) {
    const group = createSubagentGroupDto("subagent", Date.now(), sessions);
    return [formatSubagentGroupLine(group)];
  }

  return sessions.map(session => formatSubagentSessionLine(session, now));
}

export function formatSubagentGroupLine(group: SubagentGroupDto): string {
  const knownStatuses = ["queued", "running", "completed", "error", "interrupted", "skipped", "aborted"];
  const counts = knownStatuses
    .filter(status => group.statusCounts[status])
    .map(status => `${group.statusCounts[status]} ${status}`);
  const extraCounts = Object.keys(group.statusCounts)
    .filter(status => !knownStatuses.includes(status))
    .sort()
    .map(status => `${group.statusCounts[status]} ${status}`);
  const active = group.sessions.some(session => isActiveStatus(session.status));
  const outcome = group.isError ? "error" : active ? "running" : "completed";
  return [`${group.sessions.length} subagents`, ...counts, ...extraCounts, `outcome:${outcome}`].join(" · ");
}

export function formatSubagentSessionSummary(session: SubagentSessionDto): string {
  const badges = [
    session.resumable ? "resumable" : undefined,
    `session:${session.sessionId}`,
  ].filter(Boolean);
  return [session.agent, session.status, ...badges, `“${session.promptPreview}”`].join(" · ");
}

export function formatSubagentSessionInspect(session: SubagentSessionDto, now = Date.now()): string[] {
  const elapsed = formatElapsed((session.startedAt ?? session.createdAt), session.completedAt ?? now);
  const lines = [
    `Session ${session.sessionId}`,
    `Status: ${session.status}${session.resumable ? " · resumable" : ""}`,
    `Agent: ${session.agent}${session.source ? ` (${session.source})` : ""}`,
  ];

  if (session.model || session.thinking) {
    lines.push(`Model: ${session.model ?? "default"}${session.thinking ? ` · thinking:${session.thinking}` : ""}`);
  }
  lines.push(`Tools: ${session.tools?.length ? session.tools.join(", ") : "default"}`);
  lines.push(`Prompt: ${session.promptPreview}`);
  if (session.activeTool) lines.push(`Active tool: ${session.activeTool}`);
  lines.push(`Progress: ${session.turns} turn${session.turns === 1 ? "" : "s"} · ${session.toolUses} tool use${session.toolUses === 1 ? "" : "s"} · ${session.compactions} compaction${session.compactions === 1 ? "" : "s"}`);
  if (session.usage) lines.push(`Usage: ${formatUsage(session.usage)}`);
  lines.push(`Timestamps: created ${formatTimestamp(session.createdAt)}${session.startedAt ? ` · started ${formatTimestamp(session.startedAt)}` : ""}${session.completedAt ? ` · completed ${formatTimestamp(session.completedAt)}` : ""} · elapsed ${elapsed}`);
  if (session.outputSnippet) lines.push(`Output: ${session.outputSnippet}`);
  if (session.errorSnippet) lines.push(`Error: ${session.errorSnippet}`);
  if (session.messageSnippet) lines.push(`Message: ${session.messageSnippet}`);
  lines.push(`Actions: ${session.availableActions.length ? session.availableActions.join(", ") : "none"}`);
  return lines;
}

export function canClearSubagentSession(session: SubagentSessionDto): boolean {
  return session.availableActions.includes("clear") && !isActiveStatus(session.status);
}

export function formatSubagentSessionLine(session: SubagentSessionDto, now = Date.now()): string {
  const elapsed = formatElapsed((session.startedAt ?? session.createdAt), session.completedAt ?? now);
  const parts = [
    session.agent,
    session.status,
    `${session.turns} turn${session.turns === 1 ? "" : "s"}`,
    elapsed,
  ];

  if (session.activeTool) parts.push(`tool:${session.activeTool}`);
  if (session.messageSnippet) parts.push(`“${session.messageSnippet}”`);
  if (session.finalOutcome) {
    const outcome = session.finalOutcome.message
      ? `${session.finalOutcome.status}:${session.finalOutcome.message}`
      : session.finalOutcome.status;
    parts.push(`outcome:${outcome}`);
  }

  return parts.join(" · ");
}

export function createSubagentTextComponent(
  details: unknown,
  expanded: boolean,
  theme: any,
  now = Date.now(),
) {
  const lines = formatSubagentToolLines(details, expanded, now);
  const text = lines.map(line => colorLine(line, theme)).join("\n");
  return new Text(text, 0, 0);
}

export function activeOrRetainedSessions(sessions: SubagentSessionDto[]) {
  return sessions.filter(session => isActiveStatus(session.status) || session.resumable);
}

export function formatWidgetLines(sessions: SubagentSessionDto[], now = Date.now()): string[] {
  const visible = activeOrRetainedSessions(sessions);
  if (visible.length === 0) return [];
  if (visible.length === 1) return [formatSubagentSessionLine(visible[0], now)];

  const active = visible.filter(session => isActiveStatus(session.status)).length;
  const retained = visible.length - active;
  return [`Subagents: ${active} active · ${retained} retained`];
}

function extractGroup(details: unknown): SubagentGroupDto | undefined {
  if (!details || typeof details !== "object") return undefined;
  const record = details as { group?: unknown; groups?: unknown };
  if (record.group && typeof record.group === "object") return record.group as SubagentGroupDto;
  if (Array.isArray(record.groups) && record.groups[0] && typeof record.groups[0] === "object") {
    return record.groups[0] as SubagentGroupDto;
  }
  return undefined;
}

function extractSessions(details: unknown): SubagentSessionDto[] {
  if (!details || typeof details !== "object") return [];
  const record = details as { sessions?: unknown; session?: unknown };
  if (Array.isArray(record.sessions)) return record.sessions as SubagentSessionDto[];
  if (record.session && typeof record.session === "object") return [record.session as SubagentSessionDto];
  return [];
}

function isActiveStatus(status: string) {
  return status === "queued" || status === "running";
}

function compact(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd() + "…";
}

function formatElapsed(from: number, to: number) {
  const seconds = Math.max(0, Math.floor((to - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m${rest.toString().padStart(2, "0")}s`;
}

function formatTimestamp(value: number) {
  return new Date(value).toISOString();
}

function formatUsage(usage: Usage) {
  const tokens = `${usage.totalTokens} tokens`;
  const cost = usage.cost?.total ? ` · $${usage.cost.total.toFixed(4)}` : "";
  return `${tokens}${cost}`;
}

function colorLine(line: string, theme: any) {
  if (!theme?.fg) return line;
  if (line.includes("status:error") || line.includes("outcome:error")) return theme.fg("error", line);
  if (line.includes("status:aborted") || line.includes("outcome:aborted")) return theme.fg("warning", line);
  if (line.includes("status:interrupted") || line.includes("outcome:interrupted")) return theme.fg("warning", line);
  if (line.includes("status:skipped") || line.includes("outcome:skipped")) return theme.fg("warning", line);
  if (line.includes("completed") || line.includes("outcome:completed")) return theme.fg("success", line);
  if (line.includes("running")) return theme.fg("accent", line);
  return theme.fg("muted", line);
}
