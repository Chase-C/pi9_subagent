import type { AgentUpdateKind } from "../domain/agent-view.js";
import { BatchRun } from "./batch-run.js";

/**
 * Holds the live BatchRun instances and the agent→batch routing table that
 * the catalog uses to forward agent updates into the correct batch listener.
 *
 * The catalog tells BatchSet about agent removals via `detach` (silent, used
 * by post-batch pruning where the batch is about to be disposed anyway) or
 * `forgetAgents` (emits the affected batches, used by `AgentManager.remove`).
 */
export class BatchSet {

  private readonly _batches = new Map<string, BatchRun>();
  private readonly _agentBatch = new Map<string, string>();

  register(groupId: string, batch: BatchRun): void {
    this._batches.set(groupId, batch);
  }

  attach(agentId: string, groupId: string): void {
    this._agentBatch.set(agentId, groupId);
  }

  /** Returns the groupId currently mapped to this agent, or undefined. */
  groupOf(agentId: string): string | undefined {
    return this._agentBatch.get(agentId);
  }

  dispatch(agentId: string, kind: AgentUpdateKind): void {
    const groupId = this._agentBatch.get(agentId);
    if (groupId !== undefined) {
      this._batches.get(groupId)?.handleAgentUpdate(kind);
    }
  }

  /** Drop the mapping silently. Used during post-batch pruning where the owning batch is about to be disposed. */
  detach(agentId: string): void {
    this._agentBatch.delete(agentId);
  }

  /** Drop the mappings and emit on each affected batch. Used by `AgentManager.remove`. */
  forgetAgents(ids: ReadonlySet<string>): void {
    const touchedGroups = new Set<string>();
    for (const id of ids) {
      const groupId = this._agentBatch.get(id);
      if (groupId) touchedGroups.add(groupId);
      this._agentBatch.delete(id);
    }
    for (const groupId of touchedGroups) this._batches.get(groupId)?.emit();
  }

  dispose(groupId: string): void {
    const batch = this._batches.get(groupId);
    if (!batch) return;
    batch.flush();
    batch.dispose();
    this._batches.delete(groupId);
  }
}
