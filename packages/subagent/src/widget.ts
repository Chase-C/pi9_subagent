import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import { effectiveStatus } from "./conversation.js";
import type { RunSnapshot, ConversationSnapshot } from "./conversation.js";
import { DEFAULT_SUBAGENT_UI_SETTINGS, type SubagentDisplaySettings, type SubagentSettings, type SubagentUiSettings, type WidgetLayout } from "./settings.js";

export const WIDGET_COLUMN_GUTTER = "  │ ";

export function maxLineWidth(lines: readonly string[]): number {
  let max = 0;
  for (const line of lines) {
    max = Math.max(max, visibleWidth(line));
  }
  return max;
}

export function hasBothColumnSections(sections: readonly { title: string }[]): boolean {
  let hasActive = false;
  let hasCompleted = false;
  for (const section of sections) {
    if (section.title === "Active Runs") hasActive = true;
    else if (section.title === "Completed Runs") hasCompleted = true;
    if (hasActive && hasCompleted) return true;
  }
  return false;
}

export function resolveWidgetLayout(
  layout: WidgetLayout,
  width: number,
  bothColumnSectionsPresent = true,
  leftNaturalWidth = 0,
): "columns" | "stacked" {
  if (layout === "columns") return "columns";
  if (layout === "stacked") return "stacked";
  if (!bothColumnSectionsPresent) return "stacked";
  return width > leftNaturalWidth + visibleWidth(WIDGET_COLUMN_GUTTER) ? "columns" : "stacked";
}

export function zipWidgetColumns(
  leftLines: string[],
  rightLines: string[],
  totalWidth: number,
  gutter: string = WIDGET_COLUMN_GUTTER,
): string[] {
  const gutterWidth = visibleWidth(gutter);
  const leftWidth = Math.min(maxLineWidth(leftLines), Math.max(0, totalWidth - gutterWidth));
  const rightWidth = Math.max(0, totalWidth - leftWidth - gutterWidth);
  const maxLen = Math.max(leftLines.length, rightLines.length);
  const lines: string[] = [];
  for (let i = 0; i < maxLen; i++) {
    const left = truncateToWidth(leftLines[i] ?? "", leftWidth, "", true);
    const right = truncateToWidth(rightLines[i] ?? "", rightWidth, "", false);
    lines.push(`${left}${gutter}${right}`);
  }
  return lines;
}

export type WidgetSectionTitle = "Active Runs" | "Completed Runs" | "Conversations";
export interface WidgetRow { conversation: ConversationSnapshot; run?: RunSnapshot; text: string; status: string }
export interface WidgetSection { title: WidgetSectionTitle; rows: WidgetRow[]; overflow?: number }
export interface WidgetModel { sections: WidgetSection[] }

export function formatConversationIdentityLine(conversation: ConversationSnapshot): string {
  return `${conversation.config.name}${conversation.label ? ` · ${conversation.label}` : ""} · ${conversation.conversationId}`;
}
export function formatRunConversationLine(conversation: ConversationSnapshot, run: RunSnapshot = conversation.currentRun ?? conversation.runs.at(-1)!): string {
  return `${formatConversationIdentityLine(conversation)} · ${run.runId} · ${effectiveStatus(run.status)}`;
}
export const formatConversationLine = formatRunConversationLine;

export function buildWidgetModel(conversations: ConversationSnapshot[], _now = Date.now(), display?: SubagentDisplaySettings): WidgetModel {
  const active: WidgetRow[] = []; const completed: WidgetRow[] = []; const empty: WidgetRow[] = [];
  for (const conversation of conversations) {
    const run = conversation.currentRun ?? conversation.runs.at(-1);
    if (!run) { empty.push({ conversation, text: formatConversationIdentityLine(conversation), status: "conversation" }); continue; }
    const row = { conversation, run, text: formatRunConversationLine(conversation, run), status: effectiveStatus(run.status) };
    (run.status.kind === "done" ? completed : active).push(row);
  }
  const limit = display?.widgetMaxRowsPerSection ?? Infinity;
  const section = (title: WidgetSectionTitle, rows: WidgetRow[]): WidgetSection | undefined => rows.length ? { title, rows: rows.slice(0, limit), ...(rows.length > limit ? { overflow: rows.length - limit } : {}) } : undefined;
  return { sections: [section("Active Runs", active), section("Completed Runs", completed), section("Conversations", empty)].filter((x): x is WidgetSection => !!x) };
}

export function formatThemedWidgetRow(row: WidgetRow, theme?: Pick<Theme, "fg">): string {
  const color: ThemeColor = row.status === "running" ? "accent" : row.status === "queued" ? "warning" : row.status === "completed" ? "success" : row.status === "conversation" ? "muted" : "error";
  return theme?.fg ? theme.fg(color, row.text) : row.text;
}
export function renderWidgetModelLines(model: WidgetModel, _now = Date.now(), format = (row: WidgetRow) => row.text, options: { layout?: "auto" | "columns" | "stacked"; width?: number } = {}): string[] {
  const render = (s: WidgetSection) => [`${s.title}`, ...s.rows.map(format), ...(s.overflow ? [`+${s.overflow} more`] : [])];
  const lines = model.sections.map(render);
  if (lines.length === 2 && resolveWidgetLayout(options.layout ?? "stacked", options.width ?? 80, hasBothColumnSections(model.sections), maxLineWidth(lines[0])) === "columns") return zipWidgetColumns(lines[0], lines[1], options.width ?? 80);
  return lines.flatMap((value, index) => index ? ["", ...value] : value);
}
export function formatWidgetLines(conversations: ConversationSnapshot[], now = Date.now(), display?: SubagentDisplaySettings): string[] { return renderWidgetModelLines(buildWidgetModel(conversations, now, display), now); }
export function stringifyWidgetModel(model: WidgetModel): string { return renderWidgetModelLines(model).join("\n"); }

export class SubagentWidgetComponent implements Component {
  constructor(
    private readonly model: WidgetModel,
    private readonly theme: Theme | undefined,
    private readonly widgetLayout: WidgetLayout = "auto",
  ) { }

  invalidate(): void { }

  render(width: number): string[] {
    const lines = renderWidgetModelLines(this.model, Date.now(), row => formatThemedWidgetRow(row, this.theme), {
      layout: this.widgetLayout,
      width,
    });
    return lines.flatMap(line => wrapTextWithAnsi(line, Math.max(1, width)));
  }
}

type WidgetComponentFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };

type SubagentWidgetContext = {
  hasUI?: boolean;
  ui?: {
    notify?: (message: string, level?: "info" | "warning" | "error") => void;
    setWidget?: {
      (id: string, content: string[] | undefined, options?: { placement?: "belowEditor" | "aboveEditor" }): void;
      (id: string, content: WidgetComponentFactory | undefined, options?: { placement?: "belowEditor" | "aboveEditor" }): void;
    };
  };
};

type SubagentWidgetLifecyclePi = {
  on?(event: "session_start" | "session_shutdown", handler: (event: unknown, ctx: SubagentWidgetContext) => void): void;
};

type SubagentWidgetConversationSource = {
  listConversations(): ConversationSnapshot[];
};

export function registerSubagentWidgetLifecycle(
  pi: SubagentWidgetLifecyclePi,
  source: SubagentWidgetConversationSource,
  getSettings: () => SubagentSettings | SubagentUiSettings,
): void {
  if (typeof pi.on !== "function") return;
  let activeContext: SubagentWidgetContext | undefined;
  const refresh = () => { if (activeContext) updateSubagentWidget(activeContext, source.listConversations(), getSettings()); };
  const unsubscribe = typeof (source as SubagentWidgetConversationSource & { onConversationUpdate?: (listener: () => void) => () => void }).onConversationUpdate === "function"
    ? (source as SubagentWidgetConversationSource & { onConversationUpdate(listener: () => void): () => void }).onConversationUpdate(refresh)
    : undefined;
  pi.on("session_shutdown", (_event, ctx) => { activeContext = undefined; updateSubagentWidget(ctx, [], getSettings()); });
  pi.on("session_start", (_event, ctx) => { activeContext = ctx; refresh(); });
  void unsubscribe;
}

export function updateSubagentWidget(
  ctx: SubagentWidgetContext,
  agents: ConversationSnapshot[],
  settings: SubagentSettings | SubagentUiSettings,
) {
  if (!ctx.hasUI || !ctx.ui?.setWidget) return;
  try {
    if (settings.widgetPlacement === "off") {
      ctx.ui.setWidget("subagent", undefined);
      return;
    }
    const display = (settings as SubagentSettings).display;
    const model = buildWidgetModel(agents, Date.now(), display);
    const widgetLayout = settings.widgetLayout ?? DEFAULT_SUBAGENT_UI_SETTINGS.widgetLayout;
    const factory: WidgetComponentFactory | undefined = model.sections.length > 0
      ? (_tui, theme) => new SubagentWidgetComponent(model, theme, widgetLayout)
      : undefined;
    ctx.ui.setWidget("subagent", factory, { placement: settings.widgetPlacement });
  } catch (error) {
    try {
      ctx.ui.notify?.(`Subagent UI update failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    } catch { }
  }
}
