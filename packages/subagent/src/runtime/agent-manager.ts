import { Agent } from "../domain/agent.js";
import type { AgentRunResult } from "../domain/agent-result.js";
import type { AgentUpdateKind, AgentView } from "../domain/agent-view.js";
import { AgentRegistry } from "../domain/agent-registry.js";
import type { SessionStatus } from "../schema.js";
import { activeOrRetainedAgents, effectiveStatus } from "../view/view-helpers.js";
import { AttemptRunner, type AgentRunner } from "./attempt-runner.js";
import { BatchSet } from "./batch-set.js";
import { ParentFinalizePolicy } from "./parent-finalize-policy.js";
import { timingMark } from "./timing.js";

export type AgentUpdateListener = (agent: Agent, kind: AgentUpdateKind) => void;
export type { AgentRunner } from "./attempt-runner.js";

export type BackgroundResult =
  | { sessionId: string; ready: true; result: AgentRunResult }
  | { sessionId: string; ready: false; status: "queued" | "running"; elapsedMs: number; agent: string; label?: string }
  | { sessionId: string; error: string };

export class AgentManager {

  private _agents = new Array<Agent>();
  private readonly _batches = new BatchSet();
  private _updateListeners = new Set<AgentUpdateListener>();
  private readonly _runner: AttemptRunner;

  constructor(
    readonly registry: AgentRegistry,
    maxRunning: number = 4,
    runner?: AgentRunner,
  ) {
    this._runner = new AttemptRunner({
      maxRunning,
      ...(runner ? { runner } : {}),
      isTracked: id => this._agents.some(a => a.id === id),
    });
  }

  listSessions(filter?: { status?: SessionStatus[] }): AgentView[] {
    const views = activeOrRetainedAgents(this._agents).map(agent => agent.toView());
    if (!filter || filter.status === undefined) return views;
    const allowed = new Set(filter.status);
    return views.filter(view => allowed.has(effectiveStatus(view.status) as SessionStatus));
  }

  /**
   * Returns the union of the named roots and every descendant reachable through `parentSessionId`,
   * as `AgentView`s. Roots appear in input order; descendants under each parent are sorted by
   * `createdAt` ascending. Missing root ids are skipped silently. Live-view helper for the `run`
   * tool's partial updates; callers must not assume completeness across recursive `_agents` sweeps.
   */
  subtreeOf(rootIds: string[]): AgentView[] {
    const byId = new Map<string, Agent>();
    for (const agent of this._agents) byId.set(agent.id, agent);

    const out: AgentView[] = [];
    const seen = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      const agent = byId.get(id);
      if (!agent) return;
      seen.add(id);
      out.push(agent.toView());
      const children = this._agents.filter(a => a.parentSessionId === id);
      children.sort((a, b) => a.createdAt - b.createdAt);
      for (const child of children) visit(child.id);
    };
    for (const id of rootIds) visit(id);
    return out;
  }

  configure(options: { maxRunning?: number }) {
    this._runner.configure(options);
  }

  get runner(): AttemptRunner { return this._runner; }
  get batches(): BatchSet { return this._batches; }

  /** Adds a freshly-spawned agent to the catalog and subscribes the catalog's broadcast pipeline. */
  adopt(agent: Agent): void {
    this._agents.push(agent);
    agent.on(this._agentUpdate.bind(this));
  }

  /** Looks up an existing agent eligible for resume by sessionId. */
  findResumable(id: string): Agent | undefined {
    return this._agents.find(a => a.id === id && a.resumable);
  }

  /**
   * Post-batch pruning. Drops agents in `touched` that are done, non-background, and non-resumable.
   * Detaches each dropped agent from its batch mapping. Survivors stay in the catalog.
   */
  pruneTouched(touched: ReadonlySet<string>): void {
    this._agents = this._agents.filter(agent => {
      if (!touched.has(agent.id)) return true;
      if (agent.background) return true;
      if (agent.status.kind !== "done") return true;
      if (agent.resumable) return true;
      this._batches.detach(agent.id);
      return false;
    });
  }

  /**
   * Walks the descendant subtree of `parentSessionId` post-order (grandchildren before children)
   * and awaits `abort()` on each. `Array.filter` snapshots the descendants before iterating so
   * concurrent `remove()` / `startBatch()` mutations of `_agents` don't disturb the walk.
   * `Agent.abort()` is a no-op for already-terminal agents, so re-calling it is safe.
   */
  async abortDescendantsOf(parentSessionId: string): Promise<void> {
    const directChildren = this._agents.filter(a => a.parentSessionId === parentSessionId);
    timingMark("manager.abortDescendants.walk", { parentSessionId, directChildCount: directChildren.length });
    for (const child of directChildren) {
      timingMark("manager.abortDescendants.child", { parentSessionId, childId: child.id, agent: child.agentName, statusKind: child.status.kind, background: child.background });
      await this.abortDescendantsOf(child.id);
      await child.abort();
    }
  }

  /**
   * Same post-order walk as `abortDescendantsOf` but skips agents currently flagged
   * `background === true`. The check uses the live flag, so an agent promoted via
   * `promoteToBackground` between spawn and finalize is treated as background.
   */
  async cancelNonBackgroundDescendantsOf(parentSessionId: string, reason: string): Promise<void> {
    const directChildren = this._agents.filter(a => a.parentSessionId === parentSessionId);
    timingMark("manager.cancelNonBackgroundDescendants.walk", { parentSessionId, directChildCount: directChildren.length, reason });
    for (const child of directChildren) {
      if (child.background) {
        timingMark("manager.cancelNonBackgroundDescendants.skipBackground", { parentSessionId, childId: child.id, agent: child.agentName });
        continue;
      }
      timingMark("manager.cancelNonBackgroundDescendants.child", { parentSessionId, childId: child.id, agent: child.agentName, statusKind: child.status.kind });
      await this.cancelNonBackgroundDescendantsOf(child.id, reason);
      await child.abort(reason);
    }
  }

  onAgentUpdate(listener: AgentUpdateListener): () => void {
    this._updateListeners.add(listener);
    return () => this._updateListeners.delete(listener);
  }

  /**
   * Releases the named agent's queue slot while `fn` runs, then re-acquires it before returning.
   * Used by the child subagent tool so a parent awaiting `batch.resultsPromise` doesn't pin the
   * only queue slot a recursive descendant needs to start — without this, a tree deeper than
   * maxRunning deadlocks. No-op when the session has no active lease.
   */
  async suspendAgentSlotDuring<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this._runner.suspendAgentSlotDuring(sessionId, fn);
  }

  async backgroundResults(
    sessionIds: string[],
    options: { remove?: boolean } = {},
  ): Promise<BackgroundResult[]> {
    const remove = options.remove === true;
    const results: BackgroundResult[] = [];
    const terminalIds = new Set<string>();
    for (const id of sessionIds) {
      const agent = this._agents.find(a => a.id === id);
      if (!agent) {
        results.push({ sessionId: id, error: `Unknown subagent session: ${id}` });
        continue;
      }
      const status = agent.status;
      if (status.kind === "done") {
        results.push({ sessionId: id, ready: true, result: status.result });
        if (remove) terminalIds.add(id);
        continue;
      }
      const now = Date.now();
      const elapsedMs = status.kind === "running"
        ? now - status.startedAt
        : now - status.queuedAt;
      const entry: Extract<BackgroundResult, { ready: false }> = {
        sessionId: id,
        ready: false,
        status: status.kind === "running" ? "running" : "queued",
        elapsedMs,
        agent: agent.agentName,
      };
      if (agent.label !== undefined) entry.label = agent.label;
      results.push(entry);
    }
    if (terminalIds.size > 0) await this.remove({ sessionIds: Array.from(terminalIds) });
    return results;
  }

  async remove(
    args: { sessionIds: string[] } | { scope: "background" | "retained" | "non-running" },
  ): Promise<{ removed: number; aborted: number; sessionIds: string[]; errors: Array<{ sessionId: string; error: string }> }> {
    const errors: Array<{ sessionId: string; error: string }> = [];
    const targets: Agent[] = [];

    if ("sessionIds" in args) {
      for (const id of args.sessionIds) {
        const agent = this._agents.find(a => a.id === id);
        if (!agent) errors.push({ sessionId: id, error: `Unknown subagent session: ${id}` });
        else targets.push(agent);
      }
    } else {
      targets.push(...this._matchScope(args.scope));
    }

    let aborted = 0;
    const fanouts: Promise<void>[] = [];
    for (const agent of targets) {
      const status = agent.status.kind;
      if (status === "running" || status === "queued") {
        await agent.abort();
        if (status === "running") aborted += 1;
        const pending = ParentFinalizePolicy.pendingFor(agent.id);
        if (pending) fanouts.push(pending);
      }
    }
    if (fanouts.length > 0) await Promise.all(fanouts);

    const removedIds = new Set(targets.map(a => a.id));
    if (removedIds.size > 0) {
      this._agents = this._agents.filter(a => !removedIds.has(a.id));
      this._batches.forgetAgents(removedIds);
    }

    return {
      removed: removedIds.size,
      aborted,
      sessionIds: Array.from(removedIds),
      errors,
    };
  }

  private _matchScope(scope: "background" | "retained" | "non-running"): Agent[] {
    if (scope === "background") return this._agents.filter(a => a.background);
    if (scope === "retained") return this._agents.filter(a => !a.background && a.status.kind !== "running" && a.resumable);
    if (scope === "non-running") return this._agents.filter(a => a.status.kind !== "running");
    throw new Error(`Unknown remove scope: ${String(scope)}`);
  }

  private _agentUpdate(agent: Agent, kind: AgentUpdateKind) {
    const status = agent.status;
    const groupId = this._batches.groupOf(agent.id);
    timingMark("manager.agentUpdate", {
      sessionId: agent.id,
      agent: agent.agentName,
      parentSessionId: agent.parentSessionId,
      kind,
      statusKind: status.kind,
      ...(status.kind === "done" ? { outcome: status.result.status } : {}),
      background: agent.background,
      ...(groupId !== undefined ? { groupId } : {}),
    });
    for (const listener of this._updateListeners) listener(agent, kind);
    this._batches.dispatch(agent.id, kind);
  }
}
