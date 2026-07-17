import { StringEnum, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

import {
  isModelThinkingLevel,
  MODEL_THINKING_LEVELS,
} from "./domain/model-thinking-level.js";
import type { AgentDispatch } from "./domain/agent-lifecycle.js";

export {
  isModelThinkingLevel,
  MODEL_THINKING_LEVELS,
} from "./domain/model-thinking-level.js";

export const TaskSchema = Type.Object({
  agent: Type.Optional(
    Type.String({ description: "New session only: agent name." }),
  ),
  sessionId: Type.Optional(
    Type.String({ description: "Resume only: retained session handle." }),
  ),
  prompt: Type.String({
    description:
      "Delegated task or follow-up; resumes retain prior child context.",
  }),
  label: Type.Optional(
    Type.String({
      description:
        "New session only: display label; required for new sessions.",
    }),
  ),
  retainConversation: Type.Optional(
    Type.Boolean({
      description: "New session only: retain child context for follow-ups.",
    }),
  ),
  model: Type.Optional(
    Type.String({ description: "New session model override." }),
  ),
  thinking: Type.Optional(
    StringEnum(MODEL_THINKING_LEVELS, {
      description: "New session thinking override.",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "New session working directory; relative paths use the parent cwd.",
    }),
  ),
  skills: Type.Optional(
    Type.Array(Type.String(), {
      description: "New session skills; replaces agent defaults ([] disables).",
    }),
  ),
});

export const SUBAGENT_ACTIONS = [
  "agents",
  "list",
  "run",
  "results",
  "remove",
] as const;
export const SESSION_STATUSES = [
  "queued",
  "running",
  "completed",
  "error",
  "aborted",
  "interrupted",
  "skipped",
] as const;

export const SubagentParams = Type.Object({
  action: StringEnum(SUBAGENT_ACTIONS),
  tasks: Type.Optional(
    Type.Array(TaskSchema, {
      minItems: 1,
      description:
        "run only: tasks execute concurrently; avoid dependencies and overlapping writes.",
    }),
  ),
  dispatch: Type.Optional(
    StringEnum(["foreground", "background"] as const, {
      description:
        "run only: foreground (default) waits; background returns handles immediately.",
    }),
  ),
  status: Type.Optional(
    Type.Array(StringEnum(SESSION_STATUSES), {
      minItems: 1,
      description: "list only: statuses to include.",
    }),
  ),
  sessionIds: Type.Optional(
    Type.Array(Type.String(), {
      minItems: 1,
      description: "results/remove: session handles to target.",
    }),
  ),
  remove: Type.Optional(
    Type.Boolean({
      description:
        "results only: remove terminal sessions once returned; pending sessions remain.",
    }),
  ),
});

export type SubagentParams = Static<typeof SubagentParams>;
export type SubagentAction = (typeof SUBAGENT_ACTIONS)[number];
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export const isSessionStatus = (value: unknown): value is SessionStatus =>
  typeof value === "string" &&
  (SESSION_STATUSES as readonly string[]).includes(value);

export type SpawnRequest = {
  kind: "spawn";
  agent: string;
  prompt: string;
  label?: string;
  skills?: string[];
  retainConversation?: boolean;
  model?: string;
  thinking?: ModelThinkingLevel;
  cwd?: string;
};
export type ResumeRequest = {
  kind: "resume";
  sessionId: string;
  prompt: string;
};
export type TaskRequest = SpawnRequest | ResumeRequest;
export type ParsedTask = TaskRequest | { error: string };

export type SubagentInvocation =
  | { action: "agents" }
  | { action: "list"; status?: SessionStatus[] }
  | { action: "run"; tasks: TaskRequest[]; dispatch?: AgentDispatch }
  | { action: "results"; sessionIds: string[]; remove?: boolean }
  | { action: "remove"; sessionIds: string[] };
export type SubagentInvocationParseError = {
  error: string;
  action?: SubagentAction;
  errors?: string[];
  missingAction?: boolean;
  taskCountError?: boolean;
};
export type ParsedSubagentInvocation =
  SubagentInvocation | SubagentInvocationParseError;
export interface ParseSubagentInvocationOptions {
  maxTasks?: number;
}

export function parseSubagentInvocation(
  raw: unknown,
  options: ParseSubagentInvocationOptions = {},
): ParsedSubagentInvocation {
  const params =
    raw !== null && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : {};
  const action = params.action;
  if (!action)
    return {
      error:
        'Provide an action: "agents", "list", "run", "results", or "remove".',
      missingAction: true,
    };
  if (!isSubagentAction(action))
    return {
      error: `Unknown action: ${String(action)}. Use "agents", "list", "run", "results", or "remove".`,
    };
  if (params.background !== undefined)
    return {
      error: "Legacy field background is not supported; use dispatch.",
      action,
    };

  switch (action) {
    case "agents":
      return { action };
    case "list": {
      const status = params.status;
      if (status !== undefined && !Array.isArray(status))
        return {
          error: "list status must be an array of status strings.",
          action,
        };
      if (Array.isArray(status)) {
        if (status.length === 0)
          return {
            error: "list status must contain at least one status.",
            action,
          };
        const invalid = status.find((value) => !isSessionStatus(value));
        if (invalid !== undefined)
          return {
            error: `Unknown status '${String(invalid)}'. Valid: ${SESSION_STATUSES.join(", ")}.`,
            action,
          };
      }
      return {
        action,
        ...(status !== undefined ? { status: status as SessionStatus[] } : {}),
      };
    }
    case "run": {
      const dispatch = params.dispatch;
      if (
        dispatch !== undefined &&
        dispatch !== "foreground" &&
        dispatch !== "background"
      )
        return {
          error: "run dispatch must be foreground or background.",
          action,
        };
      const countError = validateTaskCount(params.tasks, options.maxTasks);
      if (countError)
        return { error: countError, action, taskCountError: true };
      const tasks: TaskRequest[] = [];
      const errors: string[] = [];
      (params.tasks as unknown[]).forEach((task, index) => {
        const parsed = parseTask(task);
        if ("error" in parsed) errors.push(`task[${index}]: ${parsed.error}`);
        else tasks.push(parsed);
      });
      if (errors.length) return { error: errors.join("\n"), errors, action };
      return {
        action,
        tasks,
        ...(dispatch !== undefined
          ? { dispatch: dispatch as AgentDispatch }
          : {}),
      };
    }
    case "results": {
      if (params.remove !== undefined && typeof params.remove !== "boolean")
        return { error: "results remove must be a boolean.", action };
      const ids = parseSessionIds(params.sessionIds, "results");
      if ("error" in ids) return { ...ids, action };
      return {
        action,
        sessionIds: ids,
        ...(params.remove !== undefined
          ? { remove: params.remove as boolean }
          : {}),
      };
    }
    case "remove": {
      if (params.sessionIds === undefined)
        return { error: "remove requires sessionIds.", action };
      const ids = parseSessionIds(params.sessionIds, "remove");
      return "error" in ids ? { ...ids, action } : { action, sessionIds: ids };
    }
  }
}

function isSubagentAction(value: unknown): value is SubagentAction {
  return (
    typeof value === "string" &&
    (SUBAGENT_ACTIONS as readonly string[]).includes(value)
  );
}
function validateTaskCount(tasks: unknown, max?: number): string | undefined {
  if (!Array.isArray(tasks)) return "Provide a tasks array for action=run.";
  if (!tasks.length) return "Provide at least one task.";
  if (max !== undefined && tasks.length > max)
    return `Too many tasks (${tasks.length}). Max is ${max}.`;
}
function parseSessionIds(
  value: unknown,
  action: "results" | "remove",
): string[] | { error: string } {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string"))
    return { error: `${action} sessionIds must be an array of strings.` };
  if (!value.every((v) => v.trim()))
    return {
      error: `${action} sessionIds must be an array of non-empty strings.`,
    };
  if (!value.length)
    return { error: `${action} requires at least one sessionId.` };
  return value;
}

export function parseTask(raw: unknown): ParsedTask {
  if (!raw || typeof raw !== "object")
    return { error: "Task must be an object." };
  const task = raw as Record<string, unknown>;
  if (task.resumable !== undefined)
    return {
      error:
        "Legacy field resumable is not supported; use retainConversation on spawn tasks.",
    };
  const hasAgent = task.agent !== undefined,
    hasSession = task.sessionId !== undefined;
  if (hasAgent === hasSession)
    return {
      error: hasAgent
        ? "Task cannot carry both agent and sessionId. Use agent for a new spawn or sessionId for a resume."
        : "Task must carry exactly one of agent (spawn) or sessionId (resume).",
    };
  if (typeof task.prompt !== "string" || !task.prompt.trim())
    return { error: "Task prompt must be a non-empty string." };
  if (hasAgent) {
    if (typeof task.agent !== "string" || !task.agent.trim())
      return { error: "Task agent must be a non-empty string." };
    if (typeof task.label !== "string" || !task.label.trim())
      return { error: "Spawn task label must be a non-empty string." };
    if (
      task.retainConversation !== undefined &&
      typeof task.retainConversation !== "boolean"
    )
      return {
        error: "Task retainConversation must be a boolean when present.",
      };
    if (
      task.skills !== undefined &&
      (!Array.isArray(task.skills) ||
        !task.skills.every((v) => typeof v === "string" && v.trim()))
    )
      return { error: "Task skills must contain only non-empty strings." };
    if (
      task.model !== undefined &&
      (typeof task.model !== "string" || !task.model.trim())
    )
      return { error: "Task model must be a non-empty string when present." };
    if (task.thinking !== undefined && !isModelThinkingLevel(task.thinking))
      return {
        error: `Task thinking must be one of: ${MODEL_THINKING_LEVELS.join(", ")}.`,
      };
    if (
      task.cwd !== undefined &&
      (typeof task.cwd !== "string" || !task.cwd.trim())
    )
      return { error: "Task cwd must be a non-empty string when present." };
    return {
      kind: "spawn",
      agent: task.agent,
      prompt: task.prompt,
      label: task.label,
      ...(task.retainConversation !== undefined
        ? { retainConversation: task.retainConversation as boolean }
        : {}),
      ...(task.skills !== undefined ? { skills: task.skills as string[] } : {}),
      ...(task.model !== undefined ? { model: task.model as string } : {}),
      ...(task.thinking !== undefined
        ? { thinking: task.thinking as ModelThinkingLevel }
        : {}),
      ...(task.cwd !== undefined ? { cwd: task.cwd as string } : {}),
    };
  }
  if (typeof task.sessionId !== "string" || !task.sessionId.trim())
    return { error: "Task sessionId must be a non-empty string." };
  for (const field of [
    "label",
    "retainConversation",
    "model",
    "thinking",
    "cwd",
    "skills",
  ] as const)
    if (task[field] !== undefined)
      return {
        error: `Task with sessionId rejects ${field}; that field belongs to a spawn task.`,
      };
  return { kind: "resume", sessionId: task.sessionId, prompt: task.prompt };
}
