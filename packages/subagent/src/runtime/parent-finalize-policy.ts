import type { Agent } from "../domain/agent.js";
import type { AgentRunStatus, AgentUpdateKind } from "../domain/agent-view.js";
import type { AgentManager } from "./agent-manager.js";
import { timingStart } from "./timing.js";

/**
 * Subscribes to agent updates and, when an agent finalizes as `aborted` or `error`,
 * cancels its still-running non-background descendants. `completed` (and any other
 * outcome) leaves descendants alone — a completed parent has already consumed
 * children's results, and any survivors must be background ones that the parent
 * dispatched to outlive itself.
 *
 * Pending fanouts are tracked in a static map so `AgentManager.remove` can await
 * them without structurally depending on this class.
 */
export class ParentFinalizePolicy {

  private static readonly _pending = new Map<string, Promise<void>>();

  /** In-flight cancellation promise for the given parent, if any. */
  static pendingFor(agentId: string): Promise<void> | undefined {
    return ParentFinalizePolicy._pending.get(agentId);
  }

  constructor(private readonly deps: { manager: AgentManager }) {
    deps.manager.onAgentUpdate((agent, kind) => this._onUpdate(agent, kind));
  }

  private _onUpdate(agent: Agent, kind: AgentUpdateKind): void {
    if (kind !== "status") return;
    if (ParentFinalizePolicy._pending.has(agent.id)) return;
    const outcome = this._terminalOutcome(agent);
    if (outcome !== "aborted" && outcome !== "error") return;

    const reason = `Parent ${agent.id} finalized as ${outcome}`;
    const fanoutEnd = timingStart("manager.parentFinalize.fanout", { sessionId: agent.id, agent: agent.agentName, outcome });
    const promise = this.deps.manager
      .cancelNonBackgroundDescendantsOf(agent.id, reason)
      .finally(() => {
        ParentFinalizePolicy._pending.delete(agent.id);
        fanoutEnd({});
      });
    ParentFinalizePolicy._pending.set(agent.id, promise);
  }

  private _terminalOutcome(agent: Agent): AgentRunStatus | undefined {
    const status = agent.status;
    return status.kind === "done" ? status.result.status : undefined;
  }
}
