import { defineTool, type AgentToolUpdateCallback, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Conversation } from "./conversation.js";
import { listAgentDefinitions, type AgentRegistry } from "./agents.js";
import type { ConversationId, RunId } from "./identifiers.js";
import type { OrderedStartOutcome, SubagentRuntime } from "./runtime.js";
import { parseSubagentInvocation, SubagentParams, type RunStatus, type SubagentAction, type SubagentInvocation, type SubagentInvocationParseError, type TaskRequest } from "./schema.js";
import type { SubagentSettings } from "./settings.js";

export interface ActionDeps {
  runtime: SubagentRuntime;
  agentRegistry: AgentRegistry;
  parent?: { conversationId: ConversationId; runId: () => RunId };
}

export interface ActionResult {
  content: Array<{ type: "text"; text: string }>;
  details: undefined;
  isError?: boolean;
}

type InvocationFor<A extends SubagentAction> = Extract<SubagentInvocation, { action: A }>;

function jsonResult(json: unknown): ActionResult {
  return {
    content: [{ type: "text", text: JSON.stringify(json, null, 2) }],
    details: undefined,
    isError: false,
  };
}

export function errorResult(message: string): ActionResult {
  return {
    content: [{ type: "text", text: message }],
    details: undefined,
    isError: true,
  };
}

export function invocationErrorResult(
  deps: ActionDeps,
  parsed: SubagentInvocationParseError,
): ActionResult {
  const message = parsed.missingAction || parsed.taskCountError
    ? `${parsed.error}\n\nAvailable agents:\n${deps.agentRegistry.summarizeAgent()}`
    : parsed.error;
  return errorResult(message);
}

export function agentsAction(
  deps: ActionDeps,
  _invocation: InvocationFor<"agents">,
): ActionResult {
  return jsonResult({ agents: listAgentDefinitions(deps.agentRegistry) });
}

export function listAction(
  deps: ActionDeps,
  invocation: InvocationFor<"list">,
): ActionResult {
  const runs = deps.runtime.listConversations().flatMap(conversation =>
    conversation.runs.map(run => ({
      conversationId: conversation.conversationId,
      runId: run.runId,
      agent: conversation.config.name,
      ...(conversation.label ? { label: conversation.label } : {}),
      kind: run.kind,
      status: (run.status.kind === "done" ? run.status.outcome : run.status.kind) as RunStatus,
      createdAt: run.createdAt,
    })),
  );
  const filtered = invocation.status
    ? runs.filter(run => invocation.status!.includes(run.status))
    : runs;
  return jsonResult(filtered);
}

export function runAction(
  deps: ActionDeps,
  invocation: InvocationFor<"run">,
  ctx: ExtensionContext,
): ActionResult {
  const options = deps.parent
    ? { parent: { conversationId: deps.parent.conversationId, runId: deps.parent.runId() } }
    : {};
  const tasks: TaskRequest[] = [];
  const inputIndexes: number[] = [];
  const starts: OrderedStartOutcome[] = [];
  invocation.tasks.forEach((task, inputIndex) => {
    if ("error" in task) starts.push({ ok: false, inputIndex, error: task.error });
    else {
      tasks.push(task);
      inputIndexes.push(inputIndex);
    }
  });
  const handle = deps.runtime.startRun(ctx, tasks, options);
  starts.push(...handle.starts.map(start => ({
    ...start,
    inputIndex: inputIndexes[start.inputIndex],
  })));
  starts.sort((a, b) => a.inputIndex - b.inputIndex);
  return jsonResult(starts);
}

export async function joinAction(
  deps: ActionDeps,
  invocation: InvocationFor<"join">,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<undefined> | undefined,
): Promise<ActionResult> {
  let binding;
  try {
    binding = deps.runtime.bindJoin(invocation.runIds);
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }

  const output = () => binding.project().map(entry => entry.status.kind === "done"
    ? {
        conversationId: entry.conversationId,
        runId: entry.runId,
        status: entry.status.outcome,
        ...(entry.status.output !== undefined ? { output: entry.status.output } : {}),
        ...(entry.status.error !== undefined ? { error: entry.status.error } : {}),
      }
    : {
        conversationId: entry.conversationId,
        runId: entry.runId,
        status: entry.status.kind,
      });
  const emit = () => onUpdate?.({
    content: [{ type: "text", text: JSON.stringify(output()) }],
    details: undefined,
  });
  const unsubscribe = deps.runtime.onConversationUpdate(emit);
  emit();

  let abort: (() => void) | undefined;
  const cancelled = signal
    ? new Promise<never>((_, reject) => {
        abort = () => reject(new Error("Join cancelled by caller."));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      })
    : undefined;

  try {
    const wait = () => cancelled
      ? Promise.race([binding.completion, cancelled])
      : binding.completion;
    await (deps.parent
      ? deps.runtime.scheduler.suspendAgentSlotDuring(deps.parent.conversationId, wait)
      : wait());
    binding.acknowledge();
    return jsonResult(output());
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  } finally {
    unsubscribe();
    binding.release();
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

export function removeAction(
  deps: ActionDeps,
  invocation: InvocationFor<"remove">,
): ActionResult {
  return jsonResult(deps.runtime.removeConversations(invocation.conversationIds));
}

/** Adds the ordered task count to run call titles. */
function callSuffix(args: any): string {
  const tasks = Array.isArray(args?.tasks) ? args.tasks : [];
  return tasks.length ? `  ${tasks.length} task${tasks.length === 1 ? "" : "s"}` : "";
}

export interface SubagentToolDeps {
  runtime: SubagentRuntime;
  agentRegistry: AgentRegistry;
  /**
   * Called at the start of every tool invocation. Root extensions use this to reload settings,
   * reconfigure display, set max-concurrent, and reload the registry. Child factories provide
   * a no-op here because the parent's invocation already performed all of those steps.
   */
  prepareInvocation: (ctx: ExtensionContext) => Promise<SubagentSettings>;
  /** Releases notifier claims made by tool_execution_start after every join exit path. */
  releaseJoinClaims?: (runIds: readonly string[]) => void;
  /** Set on child factories; links spawned conversations and suspends its queue slot while joining. */
  parent?: { conversationId: ConversationId; runId: () => RunId };
}


export function defineSubagentTool(deps: SubagentToolDeps) {
  const { runtime, agentRegistry, prepareInvocation, parent } = deps;
  const actionDeps: ActionDeps = { runtime, agentRegistry, ...(parent ? { parent } : {}) };

  return defineTool<typeof SubagentParams, undefined>({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate work through context-isolated subagent conversations and runs. Subagents share the working filesystem.",
      "Actions:",
      "  agents(): List available agent definitions.",
      "  list(status?): List runs, optionally filtered by status.",
      "  run(tasks): Start asynchronous parallel tasks and immediately return their run IDs.",
      "  join(runIds): Wait for the given runs and return their outcomes in the same order.",
      "  remove(conversationIds): Remove retained conversations.",
      "Tasks:",
      "  Spawn: { agent, prompt, label?, skills?, model?, thinking?, cwd? }",
      "  Resume: { conversationId, prompt }",
    ].join("\n"),
    promptSnippet: "Delegate bounded work to context-isolated subagents",
    promptGuidelines: [
      "Delegate bounded, self-contained units of work to subagent — work that parallelizes cleanly, deserves a specialist, or benefits from a fresh context.",
      "Skip subagent when delegating costs more than doing, or when you couldn't verify or use the result without repeating the work.",
      "Write each subagent prompt as if to a stranger sharing only your filesystem: every input, path, and constraint, plus what to report back or produce.",
      "Run subagent tasks in parallel only when they're independent and won't interact with the same files; join once you depend on their results or have nothing else to do.",
      "Resume a retained subagent when its context helps the follow-up, spawn fresh when it wouldn't help or would mislead, and remove any you won't need again.",
      //"Call subagent action=agents before choosing an agent unless the user named one explicitly or definitions were already listed.",
    ],
    parameters: SubagentParams,
    renderCall(args, theme) {
      const action = typeof args?.action === "string" ? args.action : "pending";
      const title = theme?.bold ? theme.bold("subagent") : "subagent";
      const label = `${title} ${action}`;
      const suffix = callSuffix(args);
      const styledLabel = theme?.fg ? theme.fg("toolTitle", label) : label;
      const styledSuffix = theme?.fg ? theme.fg("dim", suffix) : suffix;
      return new Text(`${styledLabel}${styledSuffix}`, 0, 0);
    },
    renderResult(result) {
      const part = result.content.find(entry => entry.type === "text");
      const text = part && "text" in part ? part.text : "";
      return new Text(text, 0, 0);
    },

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const requestedJoinIds = params?.action === "join" && Array.isArray(params.runIds)
        ? params.runIds.filter((id): id is string => typeof id === "string")
        : [];
      try {
        const settings = await prepareInvocation(ctx);

        const invocation = parseSubagentInvocation(params, { maxTasks: settings.runtime.maxTasksPerRun });
        if ("error" in invocation) return invocationErrorResult(actionDeps, invocation);

        switch (invocation.action) {
          case "agents": return agentsAction(actionDeps, invocation);
          case "list": return listAction(actionDeps, invocation);
          case "join": return joinAction(actionDeps, invocation, signal, onUpdate);
          case "remove": return removeAction(actionDeps, invocation);
          case "run": return runAction(actionDeps, invocation, ctx);
        }
      } finally {
        if (requestedJoinIds.length) deps.releaseJoinClaims?.(requestedJoinIds);
      }
    },
  });
}

export interface ChildToolDeps {
  manager: SubagentRuntime;
  registry: AgentRegistry;
  parent: Conversation;
  getCurrentSettings: () => SubagentSettings;
}

export function makeChildSubagentTool(deps: ChildToolDeps): ToolDefinition {
  const { manager, registry, parent, getCurrentSettings } = deps;
  return defineSubagentTool({
    runtime: manager,
    agentRegistry: registry,
    prepareInvocation: async () => getCurrentSettings(),
    parent: {
      conversationId: parent.conversationId,
      runId: () => parent.requireCurrentRun().runId,
    },
  });
}
