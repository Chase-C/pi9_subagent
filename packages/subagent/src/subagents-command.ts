import { type ExtensionAPI, type ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { type Component, type TUI } from "@mariozechner/pi-tui";

import { AgentManager } from "./agent-manager.js";
import {
  canClearSubagentSession,
  formatSubagentSessionInspect,
  formatSubagentSessionSummary,
  formatSubagentToolLines,
  type SubagentSessionDto,
} from "./subagent-ui.js";

function listManagedSessions(agentManager: AgentManager): SubagentSessionDto[] {
  const maybeManager = agentManager as AgentManager & { sessions?: SubagentSessionDto[]; listSessions?: () => SubagentSessionDto[] };
  return maybeManager.listSessions?.() ?? maybeManager.sessions ?? [];
}

type SubagentSessionsTheme = {
  fg?: (color: "accent" | "dim", text: string) => string;
  bold?: (text: string) => string;
};

class SubagentSessionsComponent implements Component {
  private selected = 0;
  private mode: "list" | "inspect" = "list";

  constructor(
    private readonly agentManager: AgentManager,
    private readonly tui: Pick<TUI, "requestRender">,
    private readonly theme: SubagentSessionsTheme,
    private readonly notify: (message: string, level?: string) => void,
    private readonly done: () => void,
  ) { }

  invalidate(): void { }

  render(_width: number): string[] {
    const sessions = this.sessions;
    if (sessions.length === 0) return [this.accent("Subagent Sessions"), "No active or retained subagent sessions."];

    this.selected = clamp(this.selected, 0, sessions.length - 1);
    if (this.mode === "inspect") {
      const session = sessions[this.selected];
      return [
        this.accent("Subagent Session"),
        ...formatSubagentSessionInspect(session).map(line => `  ${line}`),
        this.dim(canClearSubagentSession(session)
          ? "c clear · b back · esc close"
          : "b back · esc close"),
      ];
    }

    return [
      this.accent("Subagent Sessions"),
      ...sessions.map((session, index) => {
        const prefix = index === this.selected ? "> " : "  ";
        const line = `${prefix}${formatSubagentSessionSummary(session)}`;
        return index === this.selected ? this.accent(line) : line;
      }),
      this.dim("↑↓ select · enter inspect · c clear retained · esc close"),
    ];
  }

  handleInput(data: string): void {
    const sessions = this.sessions;
    if (isCancelKey(data)) {
      this.done();
      return;
    }
    if (this.mode === "inspect" && (data === "b" || data === "B")) {
      this.mode = "list";
      this.tui.requestRender();
      return;
    }
    if (data === "c" || data === "C") {
      this.clearSelected();
      return;
    }
    if (isEnterKey(data) && sessions.length > 0) {
      this.mode = "inspect";
      this.tui.requestRender();
      return;
    }
    if (this.mode === "list" && isUpKey(data)) {
      this.selected = clamp(this.selected - 1, 0, Math.max(0, sessions.length - 1));
      this.tui.requestRender();
      return;
    }
    if (this.mode === "list" && isDownKey(data)) {
      this.selected = clamp(this.selected + 1, 0, Math.max(0, sessions.length - 1));
      this.tui.requestRender();
    }
  }

  private clearSelected() {
    const session = this.sessions[this.selected];
    if (!session) return;
    if (!canClearSubagentSession(session)) {
      this.notify(`Subagent session ${session.sessionId} is ${session.status} and cannot be cleared.`, "warning");
      return;
    }

    const result = this.agentManager.clear(session.sessionId);
    if (result.cleared > 0) this.notify(`Cleared subagent session ${session.sessionId}.`, "success");
    else this.notify(`Subagent session ${session.sessionId} was already gone.`, "warning");

    const sessions = this.sessions;
    if (sessions.length === 0) {
      this.done();
      return;
    }
    this.selected = clamp(this.selected, 0, sessions.length - 1);
    this.mode = "list";
    this.tui.requestRender();
  }

  private get sessions() {
    return listManagedSessions(this.agentManager);
  }

  private accent(text: string) {
    return this.theme.fg?.("accent", this.theme.bold?.(text) ?? text) ?? text;
  }

  private dim(text: string) {
    return this.theme.fg?.("dim", text) ?? text;
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isEnterKey(data: string) {
  return data === "\r" || data === "\n";
}

function isCancelKey(data: string) {
  return data === "\x1b" || data === "\u0003";
}

function isUpKey(data: string) {
  return data === "\x1b[A" || data === "k" || data === "K";
}

function isDownKey(data: string) {
  return data === "\x1b[B" || data === "j" || data === "J";
}

export function registerSubagentsCommand(pi: ExtensionAPI, agentManager: AgentManager) {
  (pi as ExtensionAPI & { registerCommand?: ExtensionAPI["registerCommand"] }).registerCommand?.("subagents", {
    description: "Manage active and retained subagent sessions",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const sessions = listManagedSessions(agentManager);
      if (sessions.length === 0) {
        ctx.ui.notify("No active or retained subagent sessions.", "info");
        return;
      }

      if (!ctx.hasUI || !ctx.ui?.custom) {
        ctx.ui.notify(formatSubagentToolLines({ sessions }, true).join("\n"), "info");
        return;
      }

      await ctx.ui.custom((tui, theme, _keybindings, done) => {
        return new SubagentSessionsComponent(
          agentManager,
          tui,
          theme,
          (message, level) => ctx.ui.notify(message, level as any),
          () => done(undefined),
        );
      });
    },
  });
}
