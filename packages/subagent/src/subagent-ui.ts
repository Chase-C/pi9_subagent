import { Text } from "@mariozechner/pi-tui";

import type { Agent } from "./agent.js";

const PROMPT_PREVIEW_LENGTH = 120;
const MESSAGE_SNIPPET_LENGTH = 200;

export interface SubagentFinalOutcomeDto {
  status: "completed" | "error" | "aborted";
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
  activeTool?: string;
  turns: number;
  toolUses: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  model?: string;
  finalOutcome?: SubagentFinalOutcomeDto;
}

export interface SubagentGroupUpdateDto {
  groupId: string;
  sessions: SubagentSessionDto[];
  active: boolean;
  updatedAt: number;
}

export function agentToSessionDto(agent: Agent): SubagentSessionDto {
  const status = agent.status;
  const dto: SubagentSessionDto = {
    id: agent.id,
    sessionId: agent.id,
    groupId: agent.groupId,
    agent: agent.options.agent,
    status: status.kind,
    resumable: Boolean(agent.config.resumable),
    promptPreview: compact(agent.options.prompt, PROMPT_PREVIEW_LENGTH),
    messageSnippet: agent.message ? compact(agent.message, MESSAGE_SNIPPET_LENGTH) : undefined,
    activeTool: agent.tool,
    turns: agent.turns,
    toolUses: agent.toolUses,
    createdAt: agent.createdAt,
    model: agent.options.model ?? agent.config.model,
  };

  if ("startedAt" in status) dto.startedAt = status.startedAt;

  if (status.kind === "completed") {
    dto.completedAt = status.completedAt;
    dto.finalOutcome = { status: "completed" };
  } else if (status.kind === "error") {
    dto.completedAt = status.errorAt;
    dto.finalOutcome = { status: "error", message: status.error };
  } else if (status.kind === "aborted") {
    dto.completedAt = status.abortedAt;
    dto.finalOutcome = { status: "aborted", message: "Agent aborted." };
  }

  return dto;
}

export function formatSubagentToolLines(
  details: unknown,
  expanded = false,
  now = Date.now(),
): string[] {
  const sessions = extractSessions(details);
  if (sessions.length === 0) return ["No subagent sessions."];

  if (!expanded && sessions.length > 1) {
    const running = sessions.filter(session => isActiveStatus(session.status)).length;
    const completed = sessions.filter(session => session.status === "completed").length;
    const failed = sessions.filter(session => session.status === "error" || session.status === "aborted").length;
    return [`${sessions.length} subagents · ${running} active · ${completed} completed · ${failed} failed`];
  }

  return sessions.map(session => formatSubagentSessionLine(session, now));
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

function colorLine(line: string, theme: any) {
  if (!theme?.fg) return line;
  if (line.includes("status:error") || line.includes("outcome:error")) return theme.fg("error", line);
  if (line.includes("status:aborted") || line.includes("outcome:aborted")) return theme.fg("warning", line);
  if (line.includes("completed") || line.includes("outcome:completed")) return theme.fg("success", line);
  if (line.includes("running")) return theme.fg("accent", line);
  return theme.fg("muted", line);
}
