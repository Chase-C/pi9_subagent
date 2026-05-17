import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { AgentRegistry } from "../domain/agent-registry.js";
import type { AgentView, SubagentBatchUpdate } from "../domain/agent-view.js";
import type { AgentManager } from "../runtime/agent-manager.js";
import { timingMark, timingStart, timingSync } from "../runtime/timing.js";
import { isSessionStatus, parseTask, SESSION_STATUSES, SubagentParams, type SessionStatus, type TaskRequest } from "../schema.js";
import type { SubagentSettings } from "../ui/settings.js";
import { updateSubagentWidget } from "../ui/widget.js";
import {
  agentsDetails,
  backgroundResultsDetails,
  backgroundStartedDetails,
  createSubagentTextComponent,
  formatSubagentToolLines,
  inventoryDetails,
  runDetails,
  runResultsDetails,
  type RunOutcome,
} from "../view/format.js";
import { configureSubagentDisplay, getSubagentDisplaySettings } from "../view/view-helpers.js";
import { listAgentDefinitions, serializeGroup } from "../view/serialize.js";

export interface SubagentToolDeps {
  agentManager: AgentManager;
  agentRegistry: AgentRegistry;
  getCurrentSettings: () => SubagentSettings;
  /**
   * Called at the start of every tool invocation. Root extensions use this to reload settings,
   * reconfigure display, set max-concurrent, and reload the registry. Child factories provide
   * a no-op here because the parent's invocation already performed all of those steps.
   */
  prepareInvocation: (ctx: ExtensionContext) => Promise<SubagentSettings>;
  /** Set on child factories; threaded into manager.startBatch/run so spawned agents are linked. */
  parentSessionId?: string;
}

const TOOL_DESCRIPTION = `Delegate focused work to a specialized subagent in an isolated context window. Your prompt is the subagent's only context (beyond its system prompt), so include everything it needs: objective, files/dirs, constraints, output format.

Delegate when:
- the work would otherwise crowd this conversation (large searches/reads, or long-running work with a clean summary back)
- the work benefits from independent context (e.g. a reviewer)

Skip delegation when:
- you would finish it in a handful of tool calls, given the context you already have
- using the subagent's output would require redoing the work yourself

When the user names a specific agent, immediately call { action: "run" }. Otherwise, call { action: "agents" } and pick one whose tools/skills/prompt fit — if nothing fits, do the work yourself.

Call shapes:

  { action: "agents" } — list known agents
  { action: "list", status?: [SessionStatus, ...] } — list active and retained sessions
  { action: "run", background?: boolean, tasks: [SpawnTask | ResumeTask, ...] } — spawn or resume tasks (in parallel)
  { action: "results", sessionIds: [string, ...], remove?: boolean } — fetch output (set \`remove: true\` to sweep)
  { action: "remove", sessionIds: [string, ...] } — remove specific sessions (running ones abort)
  { action: "remove", scope: Scope } — remove all sessions matching a scope

  SpawnTask     = { agent, prompt, label?, resumable?, model?, thinking?, cwd?, skills? }
  ResumeTask    = { sessionId, prompt, label?, resumable? }
  SessionStatus = "queued" | "running"                                            // active
                | "completed" | "error" | "aborted" | "interrupted" | "skipped"   // terminal
  Scope         = "background"    // background-dispatched sessions
                | "retained"      // resumable foreground sessions kept after completion
                | "non-running"   // everything except currently-running sessions
`;

const CROSS_BATCH_MESSAGE_UPDATE_THROTTLE_MS = 100;

function validateTaskCount(tasks: SubagentParams["tasks"] | undefined, maxTasks: number) {
  if (!Array.isArray(tasks)) return "Provide a tasks array for action=run.";
  if (tasks.length === 0) return "Provide at least one task.";
  if (tasks.length > maxTasks) return `Too many tasks (${tasks.length}). Max is ${maxTasks}.`;
  return undefined;
}

function isRemoveScope(scope: unknown): scope is "background" | "retained" | "non-running" {
  return scope === "background" || scope === "retained" || scope === "non-running";
}

function validateRemoveSessionIds(sessionIds: unknown): sessionIds is string[] {
  return Array.isArray(sessionIds) && sessionIds.every(id => typeof id === "string");
}

function validateNonEmptySessionIds(sessionIds: unknown): sessionIds is string[] {
  return Array.isArray(sessionIds) && sessionIds.every(id => typeof id === "string" && id.trim() !== "");
}

function toolResult(details: object, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
    details,
    isError,
  };
}

function errorResult(message: string, details: Record<string, unknown> = { }) {
  return {
    content: [{ type: "text" as const, text: message }],
    details,
    isError: true,
  };
}

function partialToolResult(update: SubagentBatchUpdate, subtree?: AgentView[]) {
  const details = runDetails(serializeGroup(update.sessions), {
    active: update.active,
    ...(subtree && subtree.length > 0 ? { subtree } : {}),
  });
  return {
    content: [{ type: "text" as const, text: formatSubagentToolLines(details, true).join("\n") }],
    details,
  };
}

export function defineSubagentTool(deps: SubagentToolDeps) {
  const { agentManager, agentRegistry, getCurrentSettings, prepareInvocation, parentSessionId } = deps;
  return defineTool({
    name: "subagent",
    label: "Subagent",
    description: TOOL_DESCRIPTION,
    parameters: SubagentParams,
    renderCall(args: any, theme: any) {
      const action = typeof args?.action === "string" ? args.action : "pending";
      const tasks = Array.isArray(args?.tasks) ? args.tasks : [];
      const labels = tasks
        .map((task: any) => (typeof task?.label === "string" ? task.label : undefined))
        .filter((label: string | undefined): label is string => Boolean(label));
      let suffix = "";
      if (labels.length > 0) {
        const limit = getSubagentDisplaySettings().toolCallLabelMaxLength;
        const joined = labels.join(", ");
        const truncated = joined.length > limit ? `${joined.slice(0, Math.max(0, limit - 3))}...` : joined;
        suffix = ` · ${truncated}`;
      } else if (tasks.length) {
        suffix = ` · ${tasks.length} task${tasks.length === 1 ? "" : "s"}`;
      }
      const line = `subagent ${action}${suffix}`;
      return new Text(theme?.fg ? theme.fg("toolTitle", line) : line, 0, 0);
    },
    renderResult(result: any, options: any, theme: any) {
      try {
        const component = createSubagentTextComponent(result?.details, Boolean(options?.expanded), theme);
        if (component) return component;
      } catch { }
      const text = result?.content?.find((part: any) => part?.type === "text")?.text ?? "";
      return new Text(text, 0, 0);
    },

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      timingMark("tool.execute.start", { action: params.action, taskCount: Array.isArray(params.tasks) ? params.tasks.length : undefined, cwd: ctx.cwd, isChild: parentSessionId !== undefined });
      const settings = await prepareInvocation(ctx);
      configureSubagentDisplay(settings.display);

      if (!params.action) {
        return errorResult(`Provide an action: "agents", "list", "run", "results", or "remove".\n\nAvailable agents:\n${agentRegistry.summarizeAgent()}`);
      }

      switch (params.action) {
        case "agents":
          return toolResult(agentsDetails(listAgentDefinitions(agentRegistry)));

        case "list": {
          if ((params as { type?: unknown }).type !== undefined) {
            return errorResult("The 'type' parameter has been removed. Use action: 'agents' to list definitions, or action: 'list' (optionally with status: [...]) for sessions. Skills listing is no longer exposed through the subagent tool.");
          }
          const statusFilter = params.status;
          if (statusFilter !== undefined && !Array.isArray(statusFilter)) {
            return errorResult("list status must be an array of status strings.");
          }
          const invalidStatus = statusFilter?.find(value => !isSessionStatus(value));
          if (invalidStatus !== undefined) {
            return errorResult(`Unknown status '${String(invalidStatus)}'. Valid: ${SESSION_STATUSES.join(", ")}.`);
          }
          const filter = statusFilter !== undefined ? { status: statusFilter as SessionStatus[] } : undefined;
          return toolResult(inventoryDetails(agentManager.listSessions(filter), filter));
        }

        case "run": {
          const countError = validateTaskCount(params.tasks, settings.runtime.maxTasksPerRun);
          if (countError) {
            return errorResult(`${countError}\n\nAvailable agents:\n${agentRegistry.summarizeAgent()}`);
          }

          const parsed: TaskRequest[] = [];
          const errors: string[] = [];
          timingSync("tool.parseTasks", { taskCount: params.tasks?.length ?? 0 }, () => {
            params.tasks?.forEach((raw, index) => {
              const result = parseTask(raw);
              if ("error" in result) errors.push(`task[${index}]: ${result.error}`);
              else parsed.push(result);
            });
          });

          if (errors.length > 0) {
            return errorResult(errors.join("\n"), { errors });
          }

          const batchOptions = parentSessionId !== undefined
            ? { background: params.background === true, parentSessionId }
            : { background: params.background === true };

          if (params.background === true) {
            const batch = agentManager.startBatch(ctx, signal, parsed, update => {
              updateSubagentWidget(ctx, update.sessions, getCurrentSettings());
            }, batchOptions);
            batch.resultsPromise.catch(() => {});
            updateSubagentWidget(ctx, batch.sessions, getCurrentSettings());
            return toolResult(backgroundStartedDetails(batch.sessions));
          }

          const runEnd = timingStart("tool.agentManager.run", { taskCount: parsed.length, isChild: parentSessionId !== undefined });
          let lastUpdate: SubagentBatchUpdate | undefined;
          let crossBatchMessageTimer: NodeJS.Timeout | undefined;
          const emitPartial = (knownSubtree?: AgentView[]) => {
            if (!lastUpdate) return;
            const update = lastUpdate;
            const rootIds = update.sessions.map(s => s.id);
            const subtree = knownSubtree ?? agentManager.subtreeOf?.(rootIds) ?? [];
            const partial = timingSync("tool.update.partialToolResult", { sessionCount: update.sessions.length, subtreeCount: subtree.length }, () => partialToolResult(update, subtree));
            timingSync("tool.update.onUpdate", { textLength: partial.content[0]?.text.length ?? 0 }, () => { onUpdate?.(partial); });
            timingSync("tool.update.widget", { sessionCount: update.sessions.length }, () => updateSubagentWidget(ctx, update.sessions, getCurrentSettings()));
          };
          const batch = agentManager.startBatch(ctx, signal, parsed, update => {
            timingMark("tool.update.received", { sessionCount: update.sessions.length, active: update.active });
            lastUpdate = update;
            emitPartial();
          }, batchOptions);
          // Cross-batch subscription: a descendant in our subtree (different batch's agent) changes
          // status — re-emit so the parent's tool row reflects the live tree. Seed `lastUpdate`
          // so a descendant firing before our own batch can still render against the initial roots.
          if (!lastUpdate) lastUpdate = { sessions: batch.sessions, active: true };
          const rootIds = batch.sessions.map(s => s.id);
          const rootIdSet = new Set(rootIds);
          const scheduleCrossBatchMessageEmit = () => {
            if (crossBatchMessageTimer) return;
            crossBatchMessageTimer = setTimeout(() => {
              crossBatchMessageTimer = undefined;
              emitPartial(agentManager.subtreeOf?.(rootIds) ?? []);
            }, CROSS_BATCH_MESSAGE_UPDATE_THROTTLE_MS);
            crossBatchMessageTimer.unref?.();
          };
          const unsubscribeCrossBatch = agentManager.onAgentUpdate?.((updatedAgent, kind) => {
            if (rootIdSet.has(updatedAgent.id)) return; // batch listener already handles roots
            if (kind === "message" && crossBatchMessageTimer) return;
            const subtree = agentManager.subtreeOf?.(rootIds) ?? [];
            if (!subtree.some(s => s.id === updatedAgent.id)) return;
            if (kind === "message") {
              scheduleCrossBatchMessageEmit();
              return;
            }
            emitPartial(subtree);
          });
          const cleanupCrossBatch = () => {
            unsubscribeCrossBatch?.();
            if (crossBatchMessageTimer) {
              clearTimeout(crossBatchMessageTimer);
              crossBatchMessageTimer = undefined;
            }
          };
          const results = parentSessionId !== undefined
            ? await agentManager.suspendAgentSlotDuring(parentSessionId, () => batch.resultsPromise).finally(cleanupCrossBatch)
            : await batch.resultsPromise.finally(cleanupCrossBatch);
          runEnd({ ok: true, resultCount: results.length });
          timingSync("tool.finalWidget", { sessionCount: agentManager.listSessions().length }, () => updateSubagentWidget(ctx, agentManager.listSessions(), getCurrentSettings()));
          const isError = results.some(result => result.status !== "completed");
          const outcomes: RunOutcome[] = results.map((result, inputIndex) => ({
            inputIndex,
            agent: result.agent,
            status: result.status,
            ...(result.label !== undefined ? { label: result.label } : {}),
            ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
            ...(result.output !== undefined ? { output: result.output } : {}),
            ...(result.error !== undefined ? { error: result.error } : {}),
            ...(result.resumed ? { resumed: true } : {}),
          }));
          return toolResult(runResultsDetails(outcomes, isError), isError);
        }

        case "results": {
          const { sessionIds } = params;
          if (!validateRemoveSessionIds(sessionIds)) {
            return errorResult("results sessionIds must be an array of strings.");
          }
          if (!validateNonEmptySessionIds(sessionIds)) {
            return errorResult("results sessionIds must be an array of non-empty strings.");
          }
          if (sessionIds.length === 0) {
            return errorResult("results requires at least one sessionId.");
          }
          const results = await agentManager.backgroundResults(sessionIds, { remove: params.remove === true });
          return toolResult(backgroundResultsDetails(results));
        }

        case "remove": {
          const { sessionIds, scope } = params;
          const hasIds = sessionIds !== undefined;
          const hasScope = scope !== undefined;
          if (hasIds && hasScope) return errorResult("remove requires exactly one of sessionIds or scope.");
          if (!hasIds && !hasScope) return errorResult("remove requires either sessionIds or scope.");
          if (hasIds && !validateRemoveSessionIds(sessionIds)) {
            return errorResult("remove sessionIds must be an array of strings.");
          }
          if (hasScope && !isRemoveScope(scope)) {
            return errorResult('remove scope must be "background", "retained", or "non-running".');
          }
          const summary = hasIds
            ? await agentManager.remove({ sessionIds })
            : await agentManager.remove({ scope: scope! });
          return toolResult({ view: "remove-summary", summary });
        }

        default:
          return errorResult(`Unknown action: ${String(params.action)}. Use "agents", "list", "run", "results", or "remove".`);
      }
    },
  });
}
