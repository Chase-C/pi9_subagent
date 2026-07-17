import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { AgentActivity, type AgentActivityListener } from "./agent-activity.js";
import type {
  AgentDispatch,
  AgentRunOutcome,
  AttemptKind,
} from "./agent-lifecycle.js";

export type AttemptState =
  | { kind: "queued" }
  | { kind: "running"; session: AgentSession; startedAt: number }
  | {
      kind: "done";
      result: AgentRunOutcome;
      startedAt?: number;
      completedAt: number;
    };

/** One invocation, with immutable request inputs and isolated activity. */
export class Attempt {
  readonly createdAt = Date.now();
  readonly activity: AgentActivity;
  state: AttemptState = { kind: "queued" };

  constructor(
    readonly kind: AttemptKind,
    readonly dispatch: AgentDispatch,
    readonly prompt: string,
    onActivityChange: AgentActivityListener,
  ) {
    this.activity = new AgentActivity(onActivityChange);
  }

  attach(session: AgentSession): void {
    if (this.state.kind !== "queued") {
      throw new Error(
        `Cannot attach a session to an attempt that is ${this.state.kind}.`,
      );
    }
    this.state = { kind: "running", session, startedAt: Date.now() };
  }

  settle(result: AgentRunOutcome): void {
    if (this.state.kind === "done") return;
    const startedAt =
      this.state.kind === "running" ? this.state.startedAt : undefined;
    this.state = { kind: "done", result, startedAt, completedAt: Date.now() };
  }
}
