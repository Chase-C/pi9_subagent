import type { Agent, AgentStatus } from "../domain/agent.js";
import type { AgentRunResult } from "../domain/agent-result.js";
import type { AgentView } from "../domain/agent-view.js";

export class ResumeReservation {
  readonly originalStatus: AgentStatus;

  constructor(
    readonly target: Agent,
    readonly prompt: string,
    readonly inputIndex: number,
    private readonly _undo: () => void,
    private readonly _onSyntheticView: (view: AgentView) => void,
    private readonly _release: () => void,
  ) {
    this.originalStatus = target.status;
  }

  /** True until the runner calls agent.attach. Used to detect pre-attach failures. */
  isPreAttach(): boolean {
    return this.target.status === this.originalStatus;
  }

  failPreAttach(error: string): AgentRunResult {
    return this._closePreAttach({ status: "error", error });
  }

  skipPreAttach(): AgentRunResult {
    return this._closePreAttach({ status: "skipped", error: "Agent skipped." });
  }

  release() { this._release(); }

  private _closePreAttach(args: { status: "error" | "skipped"; error: string }): AgentRunResult {
    this._undo();
    const result = this.target.buildResult(this.prompt, { ...args, resumed: true });
    this._onSyntheticView(this._syntheticView(result));
    return result;
  }

  private _syntheticView(result: AgentRunResult): AgentView {
    const baseView = this.target.toView(this.inputIndex);
    return {
      ...baseView,
      config: { ...baseView.config, resumable: result.resumable },
      status: {
        kind: "done",
        outcome: result.status,
        completedAt: Date.now(),
        ...(result.error ? { snippet: result.error } : {}),
        ...(result.output ? { snippet: result.output } : {}),
      },
    };
  }
}
