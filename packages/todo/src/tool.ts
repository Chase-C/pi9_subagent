import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, type Component } from "@earendil-works/pi-tui";
import { formatTodoCompactionContext, formatTodoSummary } from "./format.js";
import { restoreTodoState } from "./persistence.js";
import {
  beginReminderAgentRun,
  consumeDueReminder,
  createReminderCadenceState,
  noteReminderTurn,
  noteTodoInteraction,
  resetReminderCadence,
  type ReminderCadenceConfig,
} from "./reminder-cadence.js";
import { formatTodoReminder } from "./reminder.js";
import { renderResult as renderTodoResult } from "./renderer.js";
import { TodoToolFrame, type TodoToolFrameContent, type TodoToolFrameTheme } from "./tool-frame.js";
import { TodoParamsSchema } from "./schema.js";
import { DEFAULT_TODO_UI_SETTINGS, loadTodoUiSettings, type TodoUiSettings } from "./settings.js";
import { createTodoState, todoAddressKey, transitionTodoState } from "./state.js";
import type { TodoAction, TodoAddress, TodoState, TodoToolDetails } from "./types.js";
import { shouldRenderTodoAction } from "./visibility.js";
import { updateTodoWidget } from "./widget.js";

function taskStatuses(state: TodoState): Map<string, string> {
  return new Map(state.phases.flatMap((phase) => phase.tasks.map((task) => [todoAddressKey(phase.name, task.name), task.status])));
}

function taskAddresses(state: TodoState): Map<string, TodoAddress> {
  return new Map(state.phases.flatMap((phase) => phase.tasks.map((task) => {
    const address = { phase: phase.name, task: task.name };
    return [todoAddressKey(address.phase, address.task), address];
  })));
}

function changedTasks(previous: TodoState, next: TodoState): TodoAddress[] {
  const before = taskStatuses(previous);
  const after = taskStatuses(next);
  const addresses = taskAddresses(next);
  return [...after.keys()].filter((key) => before.get(key) !== after.get(key)).map((key) => addresses.get(key)!);
}

function completedTasks(previous: TodoState, next: TodoState): TodoAddress[] {
  const before = taskStatuses(previous);
  return next.phases.flatMap((phase) => phase.tasks
    .filter((task) => task.status === "completed" && before.has(todoAddressKey(phase.name, task.name)) && before.get(todoAddressKey(phase.name, task.name)) !== "completed")
    .map((task) => ({ phase: phase.name, task: task.name })));
}

function createTodoFrame(
  state: "pending" | "success" | "error",
  action: string | undefined,
  content: TodoToolFrameContent,
  theme: TodoToolFrameTheme,
): TodoToolFrame {
  return new TodoToolFrame({
    title: "todo",
    action,
    state,
    content,
    empty: "frame",
  }, theme);
}

type TodoRenderInput = {
  details?: TodoToolDetails;
  content?: readonly { type?: string; text?: string }[];
};
type TodoRenderTheme = Parameters<typeof renderTodoResult>[2];
type TrackedSetRenderer = { toolCallId: string; invalidate?: () => void };

function reminderConfig(settings: TodoUiSettings): ReminderCadenceConfig {
  return {
    minTurns: settings.reminderMinTurns,
    maxTurns: settings.reminderMaxTurns,
    outputTokens: settings.reminderOutputTokens,
    maxPerRun: settings.reminderMaxPerRun,
  };
}

function outputTokens(message: unknown): number {
  if (!message || typeof message !== "object") return 0;
  const usage = (message as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return 0;
  const output = (usage as { output?: unknown }).output;
  return typeof output === "number" && Number.isFinite(output) && output >= 0 ? output : 0;
}

/** Expanded content for the one set result that is allowed to follow in-memory state. */
class LiveSetResult implements Component {
  constructor(
    private readonly result: TodoRenderInput,
    private readonly getState: () => TodoState,
    private readonly isCurrent: () => boolean,
    private readonly theme: TodoRenderTheme,
    private readonly fallbackGlyphs: boolean,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const details = this.result.details;
    const liveResult: TodoRenderInput = !this.isCurrent() || !details
      ? this.result
      : { ...this.result, details: { ...details, state: this.getState(), changedTasks: [] } };
    return renderTodoResult(liveResult, { expanded: true }, this.theme, { fallbackGlyphs: this.fallbackGlyphs }).render(width);
  }
}

export function registerTodoTool(pi: ExtensionAPI): void {
  let state = createTodoState();
  let settings: TodoUiSettings = { ...DEFAULT_TODO_UI_SETTINGS };
  let reminderCadence = createReminderCadenceState();
  let pendingCompactionContext: string | undefined;
  let interactedWithTodoThisTurn = false;
  let queue: Promise<void> = Promise.resolve();
  let latestSetRenderer: TrackedSetRenderer | undefined;

  const invalidateLatestSetRenderer = (): void => {
    latestSetRenderer?.invalidate?.();
  };

  const restore = (ctx: ExtensionContext): void => {
    state = restoreTodoState(ctx);
    invalidateLatestSetRenderer();
    updateTodoWidget(ctx, state, settings);
  };

  const resetReminderTracking = (): void => {
    reminderCadence = resetReminderCadence();
    interactedWithTodoThisTurn = false;
  };

  pi.on("session_start", async (_event, ctx) => {
    const loaded = await loadTodoUiSettings(ctx);
    settings = loaded.settings;
    if (loaded.warning) ctx.ui.notify(loaded.warning, "warning");
    restore(ctx);
    pendingCompactionContext = undefined;
    resetReminderTracking();
  });
  pi.on("session_tree", (_event, ctx) => {
    restore(ctx);
    pendingCompactionContext = undefined;
    resetReminderTracking();
  });
  pi.on("session_compact", () => {
    pendingCompactionContext = formatTodoCompactionContext(state);
    if (pendingCompactionContext) reminderCadence = noteTodoInteraction(reminderCadence);
  });
  pi.on("before_agent_start", () => {
    reminderCadence = beginReminderAgentRun(reminderCadence);
  });
  pi.on("turn_end", (event) => {
    reminderCadence = interactedWithTodoThisTurn
      ? noteTodoInteraction(reminderCadence)
      : noteReminderTurn(reminderCadence, outputTokens(event.message));
    interactedWithTodoThisTurn = false;
  });
  pi.on("context", (event) => {
    if (pendingCompactionContext) {
      const content = pendingCompactionContext;
      pendingCompactionContext = undefined;
      return {
        messages: [...event.messages, { role: "user", content, timestamp: Date.now() }],
      };
    }

    if (!settings.dynamicReminders) return;

    const reminder = formatTodoReminder(state);
    if (!reminder) return;

    const consumed = consumeDueReminder(reminderCadence, reminderConfig(settings));
    if (!consumed.due) return;

    reminderCadence = consumed.state;
    return {
      messages: [...event.messages, { role: "user", content: reminder, timestamp: Date.now() }],
    };
  });

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: [
      "Maintain a phased task plan.",
      "Actions:",
      "  set(phases): Replace the plan; supplied tasks start pending.",
      "  add(phases): Add phases or tasks; preserve existing tasks and statuses.",
      "  transition(transitions): Set statuses by exact phase and task names.",
      "  view(phase?): Return the full plan or one exact phase.",
    ].join("\n"),
    promptSnippet: "Track multi-step work in a phased task plan",
    promptGuidelines: [
      "Use todo for work with 3+ distinct steps; skip it for 1–2 steps.",
      "Transition todo tasks immediately when work starts or ends; do not defer updates until the end.",
      "Complete todo tasks only after the work is done and verified; cancel abandoned or obsolete tasks.",
      "Add material new work to todo as new tasks rather than expanding existing task scope.",
      "Keep `in_progress` todo tasks in one phase; complete or cancel them before starting another phase.",
    ],
    parameters: TodoParamsSchema,
    renderShell: "self",

    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const run = queue.then(() => {
        const previous = state;
        const next = transitionTodoState(previous, params as TodoAction);
        const details: TodoToolDetails = {
          action: params.action,
          state: next,
          changedTasks: params.action === "view"
            ? []
            : params.action === "set"
              ? [...taskAddresses(next).values()]
              : changedTasks(previous, next),
          completedTasks: params.action === "transition" ? completedTasks(previous, next) : [],
        };
        if (params.action !== "view") {
          state = next;
          invalidateLatestSetRenderer();
        }
        updateTodoWidget(ctx, state, settings);
        interactedWithTodoThisTurn = true;
        return {
          content: [{ type: "text" as const, text: formatTodoSummary(next) }],
          details,
        };
      });
      queue = run.then(() => undefined, () => undefined);
      return run;
    },

    renderCall(args, theme, context) {
      // The self shell replaces the call with the final result once execution settles. Keeping
      // this slot empty after completion also prevents a visible call and result frame at once.
      if (!context.isPartial || context.isError || !shouldRenderTodoAction(args.action, settings.toolVisibility)) {
        return new Container();
      }
      return createTodoFrame("pending", args.action, undefined, theme);
    },

    renderResult(result, options, theme, context) {
      const details = result.details as TodoToolDetails | undefined;
      const action = details?.action ?? context.args.action;
      if (!context.isError && !shouldRenderTodoAction(action, settings.toolVisibility)) return new Container();

      const isSetResult = !context.isError && details?.action === "set";
      if (isSetResult) {
        if (!latestSetRenderer || latestSetRenderer.toolCallId !== context.toolCallId) {
          latestSetRenderer = { toolCallId: context.toolCallId, invalidate: context.invalidate };
        } else {
          latestSetRenderer.invalidate = context.invalidate;
        }
      }

      // Partial updates are represented by the pending call frame. This keeps streaming updates
      // from briefly rendering two self-owned frames in one tool row.
      if ((options.isPartial || context.isPartial) && !context.isError) return new Container();

      const renderInput = result as TodoRenderInput;
      const content = isSetResult && options.expanded
        ? new LiveSetResult(
          renderInput,
          () => state,
          () => latestSetRenderer?.toolCallId === context.toolCallId,
          theme,
          settings.fallbackGlyphs,
        )
        : renderTodoResult(renderInput, options, theme, { fallbackGlyphs: settings.fallbackGlyphs });
      return createTodoFrame(context.isError ? "error" : "success", action, content, theme);
    },
  });
}
