import { randomUUID } from "node:crypto";

import { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { Agent, type AgentUpdateKind, type AgentView } from "./agent.js";
import type { AgentOptions } from "./agent-options.js";
import { AgentRegistry } from "./agent-registry.js";
import { activeOrRetainedAgents } from "./serialize.js";
import {
  ResumeAgent,
  RunAgent,
  errorRun,
  finalizeRun,
  interruptedRun,
  type AgentRunResult,
} from "./run-agent.js";
import { TaskQueue } from "./task-queue.js";

export { type AgentRunResult } from "./run-agent.js";

export interface AgentManagerGroupUpdate {
  groupId: string;
  createdAt: number;
  sessions: AgentView[];
  entries: Array<{ entry: AgentView; inputIndex: number }>;
  active: boolean;
  updatedAt: number;
}

const MESSAGE_UPDATE_THROTTLE_MS = 100;

export type { AgentOptions } from "./agent-options.js";

export type AgentManagerUpdateListener = (update: AgentManagerGroupUpdate) => void;
export type AgentRunner = (ctx: ExtensionContext, agent: Agent, prompt: string, signal?: AbortSignal) => Promise<AgentRunResult>;
export type AgentResumeRunner = (ctx: ExtensionContext, agent: Agent, prompt: string, signal?: AbortSignal) => Promise<AgentRunResult>;

interface SubagentGroupEntry {
  agent?: Agent;
  view?: AgentView;
  inputIndex: number;
}

interface SubagentGroupState {
  id: string;
  createdAt: number;
  entries: SubagentGroupEntry[];
}

function unknownEntry(
  opts: AgentOptions,
  error: string,
  groupId: string,
  inputIndex: number,
  createdAt: number,
): { view: AgentView; result: AgentRunResult } {
  const result: AgentRunResult = {
    agent: opts.agent,
    prompt: opts.prompt,
    status: "error",
    error,
    model: opts.model,
    resumable: false,
  };
  return {
    result,
    view: {
      id: `${groupId}:task-${inputIndex}`,
      groupId,
      inputIndex,
      createdAt,
      config: {
        name: opts.agent,
        model: opts.model,
        thinking: opts.thinking,
        source: undefined,
        tools: undefined,
        resumable: false,
      },
      status: {
        kind: "done",
        outcome: "error",
        completedAt: createdAt,
        snippet: error,
      },
      activity: {
        turns: 0,
        compactions: 0,
        toolHistory: [],
      },
      usage: undefined,
    },
  };
}

export class AgentManager {

  private _agents = new Array<Agent>();
  private _queue: TaskQueue;
  private _listeners = new Map<string, Set<AgentManagerUpdateListener>>();
  private _messageTimers = new Map<string, NodeJS.Timeout>();
  private _groups = new Map<string, SubagentGroupState>();

  constructor(
    readonly registry: AgentRegistry,
    maxRunning: number = 4,
    private readonly _runAgent: AgentRunner = RunAgent,
    private readonly _resumeAgent: AgentResumeRunner = ResumeAgent,
  ) {
    this._queue = new TaskQueue(maxRunning);
  }

  get sessions(): AgentView[] {
    return activeOrRetainedAgents(this._agents).map(agent => agent.toView());
  }

  subscribe(groupId: string, listener: AgentManagerUpdateListener): () => void {
    let listeners = this._listeners.get(groupId);
    if (!listeners) {
      listeners = new Set();
      this._listeners.set(groupId, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this._listeners.get(groupId);
      current?.delete(listener);
      if (current?.size === 0) this._listeners.delete(groupId);
    };
  }

  clear(sessionId?: string): { cleared: number; sessionId?: string } {
    if (sessionId) {
      const agent = this._agents.find(a => a.id === sessionId);
      let cleared = 0;
      if (agent) {
        cleared = 1;
        this._agents = this._agents.filter(a => a.id !== sessionId);
        if (agent.status.kind === "running") {
          finalizeRun(agent, "", { status: "aborted", error: "Agent aborted." });
        } else {
          this._emitGroupUpdate(agent.groupId);
        }
      }

      return { cleared, sessionId };
    }

    const retained = this._agents.filter(agent => {
      return agent.status.kind == "queued" || agent.status.kind == "running";
    });

    const cleared = this._agents.length - retained.length;
    this._agents = retained;
    for (const agent of retained) this._emitGroupUpdate(agent.groupId);

    return { cleared };
  }

  async spawn(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    options: Array<AgentOptions>,
    onUpdate?: AgentManagerUpdateListener,
  ): Promise<Array<AgentRunResult>> {
    const groupId = randomUUID();
    const groupCreatedAt = Date.now();
    const unsubscribe = onUpdate ? this.subscribe(groupId, onUpdate) : undefined;
    const available = () => Array
      .from(this.registry.agents.values())
      .map((agent) => `${agent.name} (${agent.source})`)
      .join("\n");

    const entries: SubagentGroupEntry[] = [];
    const resultPromises = options.map((opts, inputIndex) => {
      const config = this.registry.agents.get(opts.agent);
      if (!config) {
        const error = `Unknown agent: ${opts.agent}. Available agents:\n${available()}`;
        const { view, result } = unknownEntry(opts, error, groupId, inputIndex, groupCreatedAt);
        entries.push({ view, inputIndex });
        return Promise.resolve(result);
      }

      const agent = new Agent(randomUUID(), groupId, config, opts, this._agentUpdate.bind(this));
      entries.push({ agent, inputIndex });
      this._agents.push(agent);
      return this._enqueue(ctx, signal, agent, opts.prompt);
    });

    this._groups.set(groupId, { id: groupId, createdAt: groupCreatedAt, entries });
    this._emitGroupUpdate(groupId);
    try {
      const results = await Promise.all(resultPromises);
      this._releaseNonResumableCompleted(groupId);
      return results;
    } finally {
      this._flushPendingMessageUpdate(groupId);
      unsubscribe?.();
      this._groups.delete(groupId);
    }
  }

  async resume(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    sessionId: string,
    prompt: string,
    onUpdate?: AgentManagerUpdateListener,
  ): Promise<AgentRunResult> {
    const agent = this._agents.find(a => a.id === sessionId && a.config.resumable);
    if (!agent) {
      throw new Error(`Unknown resumable subagent session: ${sessionId}`);
    }
    if (agent.status.kind !== "done" || agent.status.result.status !== "completed") {
      const detail = agent.status.kind === "done" ? agent.status.result.status : agent.status.kind;
      throw new Error(`Cannot resume subagent session ${sessionId} while it is ${detail}.`);
    }

    const unsubscribe = onUpdate ? this.subscribe(agent.groupId, onUpdate) : undefined;
    const originalStatus = agent.status;
    try {
      return await this._resumeAgent(ctx, agent, prompt, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (agent.status === originalStatus) {
        return {
          agent: agent.agentName,
          prompt,
          status: "error",
          error: message,
          model: agent.modelOverride ?? agent.config.model,
          resumable: agent.resumable,
          sessionId: agent.id,
        };
      }
      return errorRun(agent, prompt, message);
    } finally {
      this._flushPendingMessageUpdate(agent.groupId);
      unsubscribe?.();
    }
  }

  private _agentUpdate(agent: Agent, kind: AgentUpdateKind) {
    if (kind === "message") {
      this._scheduleMessageUpdate(agent.groupId);
      return;
    }
    this._clearPendingMessageUpdate(agent.groupId);
    this._emitGroupUpdate(agent.groupId);
  }

  private _enqueue(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    agent: Agent,
    prompt: string,
  ): Promise<AgentRunResult> {
    const skipped = () => finalizeRun(agent, prompt, { status: "skipped", error: "Agent skipped." });
    return this._queue.enqueue(async () => {
      if (signal?.aborted) return skipped();
      try {
        return await this._runAgent(ctx, agent, prompt, signal);
      } catch (error) {
        if (agent.status.kind === "done") return agent.status.result;
        const message = error instanceof Error ? error.message : String(error);
        if (signal?.aborted) {
          return agent.status.kind === "queued" ? skipped() : interruptedRun(agent, prompt, message);
        }
        return errorRun(agent, prompt, message);
      }
    });
  }

  private _releaseNonResumableCompleted(groupId: string) {
    this._agents = this._agents.filter(agent => {
      if (agent.groupId !== groupId) return true;
      if (agent.status.kind !== "done") return true;
      return Boolean(agent.config.resumable && agent.status.kind === "done" && agent.status.ran);
    });
  }

  private _scheduleMessageUpdate(groupId: string) {
    if (this._messageTimers.has(groupId)) return;
    const timer = setTimeout(() => {
      this._messageTimers.delete(groupId);
      this._emitGroupUpdate(groupId);
    }, MESSAGE_UPDATE_THROTTLE_MS);
    this._messageTimers.set(groupId, timer);
  }

  private _flushPendingMessageUpdate(groupId: string) {
    if (!this._clearPendingMessageUpdate(groupId)) return;
    this._emitGroupUpdate(groupId);
  }

  private _clearPendingMessageUpdate(groupId: string) {
    const timer = this._messageTimers.get(groupId);
    if (!timer) return false;
    clearTimeout(timer);
    this._messageTimers.delete(groupId);
    return true;
  }

  private _emitGroupUpdate(groupId: string) {
    const listeners = this._listeners.get(groupId);
    if (!listeners || listeners.size === 0) return;

    const update = this._buildUpdate(groupId);
    for (const listener of listeners) listener(update);
  }

  private _buildUpdate(groupId: string): AgentManagerGroupUpdate {
    const group = this._groups.get(groupId);
    let sessions: AgentView[];
    let createdAt: number;

    if (group) {
      createdAt = group.createdAt;
      sessions = group.entries.map(({ agent, view, inputIndex }) => agent ? agent.toView(inputIndex) : view!);
    } else {
      createdAt = Date.now();
      sessions = this._agents
        .filter(agent => agent.groupId === groupId)
        .map((agent, i) => agent.toView(i));
    }

    const entries = sessions.map((entry, i) => ({ entry, inputIndex: entry.inputIndex ?? i }));
    const active = sessions.some(session => session.status.kind === "queued" || session.status.kind === "running");
    return { groupId, createdAt, sessions, entries, active, updatedAt: Date.now() };
  }
}
