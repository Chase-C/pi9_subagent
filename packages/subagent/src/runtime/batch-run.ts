import type { AgentUpdateKind, AgentView, SubagentBatchUpdate } from "../domain/agent-view.js";
import { timingStart, timingSync } from "./timing.js";
import type { BatchEntry } from "./batch-entry.js";

const MESSAGE_UPDATE_THROTTLE_MS = 100;
const ANIMATION_UPDATE_INTERVAL_MS = 120;

export type BatchUpdateListener = (update: SubagentBatchUpdate) => void;

export class BatchRun {
  readonly entries: BatchEntry[] = [];
  private pendingMessageTimer?: NodeJS.Timeout;
  private animationTimer?: NodeJS.Timeout;

  constructor(
    readonly groupId: string,
    private readonly listener?: BatchUpdateListener,
  ) {}

  sessions(): AgentView[] {
    return this.entries
      .slice()
      .sort((a, b) => a.inputIndex - b.inputIndex)
      .map(entry => entry.toView());
  }

  handleAgentUpdate(kind: AgentUpdateKind): void {
    if (kind === "message") {
      this.clearAnimationUpdate();
      if (!this.pendingMessageTimer) {
        this.pendingMessageTimer = setTimeout(() => {
          this.pendingMessageTimer = undefined;
          this.emit();
        }, MESSAGE_UPDATE_THROTTLE_MS);
      }
      return;
    }
    this.clearPendingMessageUpdate();
    this.emit();
  }

  flush(): void {
    if (!this.clearPendingMessageUpdate()) return;
    this.emit();
  }

  emit(): void {
    if (!this.listener) return;

    const end = timingStart("manager.emitBatchUpdate", { groupId: this.groupId, entries: this.entries.length });
    const sessions = this.sessions();
    const active = sessions.some(s => s.status.kind === "queued" || s.status.kind === "running");
    timingSync("manager.listener", { groupId: this.groupId, sessionCount: sessions.length, active }, () => this.listener?.({ sessions, active }));
    this.scheduleAnimationUpdate(active);
    end({ active, sessionCount: sessions.length });
  }

  dispose(): void {
    this.clearPendingMessageUpdate();
    this.clearAnimationUpdate();
  }

  private clearPendingMessageUpdate(): boolean {
    if (!this.pendingMessageTimer) return false;
    clearTimeout(this.pendingMessageTimer);
    this.pendingMessageTimer = undefined;
    return true;
  }

  private scheduleAnimationUpdate(active: boolean): void {
    if (!active) {
      this.clearAnimationUpdate();
      return;
    }
    if (this.animationTimer) return;
    this.animationTimer = setTimeout(() => {
      this.animationTimer = undefined;
      this.emit();
    }, ANIMATION_UPDATE_INTERVAL_MS);
    this.animationTimer.unref?.();
  }

  private clearAnimationUpdate(): void {
    if (!this.animationTimer) return;
    clearTimeout(this.animationTimer);
    this.animationTimer = undefined;
  }
}
