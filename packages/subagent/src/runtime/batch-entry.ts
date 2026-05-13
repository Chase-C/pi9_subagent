import type { Agent } from "../domain/agent.js";
import type { AgentView } from "../domain/agent-view.js";

export interface BatchEntry {
  readonly inputIndex: number;
  toView(): AgentView;
}

export class AgentBatchEntry implements BatchEntry {
  constructor(
    private readonly agent: Agent,
    readonly inputIndex: number,
    private readonly resumed: boolean,
  ) {}

  toView(): AgentView {
    return { ...this.agent.toView(this.inputIndex), resumed: this.resumed };
  }
}

export class StaticBatchEntry implements BatchEntry {
  constructor(
    private readonly view: AgentView,
    readonly inputIndex: number,
    private readonly resumed: boolean,
  ) {}

  toView(): AgentView {
    return { ...this.view, resumed: this.resumed };
  }
}
