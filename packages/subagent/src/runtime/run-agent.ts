import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ExtensionContext,
  getAgentDir,
  loadSkills,
  SessionManager,
  stripFrontmatter,
  SettingsManager,
  type AgentSession,
  type ModelRegistry,
  type Skill,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { Agent } from "../domain/agent.js";
import type { Attempt } from "../domain/agent-attempt.js";
import { discoverInheritedExtensionPaths } from "./extension-paths.js";
import { timingAsync } from "./timing.js";
import { completedRun, errorRun, interruptedRun, skippedRun } from "../domain/agent-finalize.js";
import type { AgentRunSnapshot } from "../domain/agent-snapshot.js";

export interface RunAgentDependencies {
  ResourceLoader: typeof DefaultResourceLoader;
  getAgentDir: typeof getAgentDir;
  createAgentSession: typeof createAgentSession;
  sessionManager: typeof SessionManager.inMemory;
  settingsManager: typeof SettingsManager.create;
  loadSkills: typeof loadSkills;
  readSkillFile: typeof readFileSync;
  loadExtensionPaths: (cwd: string, agentDir: string) => Promise<string[]>;
  childToolFor?: (agent: Agent) => ToolDefinition;
}

export const DefaultRunAgentDependencies: RunAgentDependencies = {
  ResourceLoader: DefaultResourceLoader,
  getAgentDir,
  createAgentSession,
  sessionManager: SessionManager.inMemory,
  settingsManager: SettingsManager.create,
  loadSkills,
  readSkillFile: readFileSync,
  loadExtensionPaths: discoverInheritedExtensionPaths,
};

export async function RunAttempt(
  ctx: ExtensionContext,
  agent: Agent,
  attempt: Attempt,
  signal?: AbortSignal,
  dependencies: RunAgentDependencies = DefaultRunAgentDependencies,
): Promise<AgentRunSnapshot> {
  if (attempt.kind === "resume") {
    const session = agent.sessionForResume();
    if (!session) {
      throw new Error(`Cannot resume an agent without a conversation session.`);
    }
    agent.bindSession(session);
    return PromptAgent(session, agent, attempt, signal);
  }

  if (signal?.aborted) return skippedRun(agent, attempt.runId);

  const runData = { agent: agent.agentName, conversationId: agent.conversationId, parentConversationId: agent.parent?.conversationId };
  const requestedConfig = agent.requestedConfig;
  const cwdResolution = ResolveTaskCwd(ctx.cwd, requestedConfig.cwd);
  if (!cwdResolution.ok) return errorRun(agent, attempt.runId, cwdResolution.error);
  const modelResolution = ResolveModel(requestedConfig.model, ctx.model, ctx.modelRegistry);
  if (!modelResolution.ok) return errorRun(agent, attempt.runId, modelResolution.error);

  const cwd = cwdResolution.value;
  const selectedModel = modelResolution.value;
  const agentDir = dependencies.getAgentDir();

  const requestedSkills = requestedConfig.skills ?? [];
  let systemPrompt = agent.config.systemPrompt;
  if (requestedSkills.length > 0) {
    const { skills: available } = dependencies.loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true });
    const matched: Skill[] = [];
    let missingSkill: string | undefined;
    for (const name of requestedSkills) {
      const found = available.find(skill => skill.name === name);
      if (!found) { missingSkill = name; break; }
      matched.push({ ...found, disableModelInvocation: false });
    }
    if (missingSkill) return errorRun(agent, attempt.runId, `Unknown skill: ${missingSkill}`);

    try {
      const skillBlocks = matched.map(skill => {
        const content = dependencies.readSkillFile(skill.filePath, "utf-8");
        const body = stripFrontmatter(content).trim();
        return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
      });
      systemPrompt = `${systemPrompt}\n\n${skillBlocks.join("\n\n")}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorRun(agent, attempt.runId, `Could not load requested skill: ${message}`);
    }
  }

  const inheritedExtensionPaths = await dependencies.loadExtensionPaths(cwd, agentDir);
  const childTool = dependencies.childToolFor?.(agent);

  const resourceLoader = new dependencies.ResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    additionalExtensionPaths: inheritedExtensionPaths,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });

  await timingAsync("runAgent.resourceLoader.reload", { ...runData, cwd }, () => resourceLoader.reload());
  if (signal?.aborted) return skippedRun(agent, attempt.runId);

  const requestedThinking = requestedConfig.thinking;
  const sessionManager = dependencies.sessionManager(cwd);
  const settingsManager = dependencies.settingsManager(cwd, agentDir);
  const { session } = await timingAsync("runAgent.createAgentSession", { ...runData, cwd, model: selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : undefined }, () => dependencies.createAgentSession({
    cwd,
    agentDir,
    resourceLoader,
    model: selectedModel,
    thinkingLevel: requestedThinking,
    tools: requestedConfig.tools ? [...requestedConfig.tools] : undefined,
    customTools: childTool ? [childTool] : [],
    sessionManager,
    settingsManager,
  }));

  const effectiveModel = session.model ?? selectedModel;
  const effectiveThinking = session.thinkingLevel ?? requestedThinking;
  const activeTools = typeof session.getActiveToolNames === "function"
    ? session.getActiveToolNames()
    : requestedConfig.tools ?? [];
  agent.setEffectiveConfig({
    ...(effectiveModel ? { model: `${effectiveModel.provider}/${effectiveModel.id}` } : {}),
    ...(effectiveThinking ? { thinking: effectiveThinking as ModelThinkingLevel } : {}),
    cwd,
    skills: requestedSkills,
    tools: activeTools,
  });

  if (signal?.aborted) {
    await AbortSession(session);
    return skippedRun(agent, attempt.runId);
  }

  agent.bindSession(session);
  return PromptAgent(session, agent, attempt, signal);
}

async function PromptAgent(
  session: AgentSession,
  agent: Agent,
  attempt: Attempt,
  signal?: AbortSignal,
): Promise<AgentRunSnapshot> {
  const prompt = attempt.prompt;
  const onAbort = () => { void AbortSession(session); }

  if (signal?.aborted) {
    await AbortSession(session);
    return interruptedRun(agent, attempt.runId, "Agent interrupted.");
  }

  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await timingAsync("runAgent.session.prompt", { agent: agent.agentName, conversationId: agent.conversationId, promptLength: prompt.length }, () => session.prompt(prompt));
    const finalMessage = GetFinalAssistantMessage(session);
    if (finalMessage.stopReason === "aborted") {
      return interruptedRun(agent, attempt.runId, finalMessage.errorMessage || "Agent interrupted.");
    }
    if (finalMessage.stopReason === "error") {
      return errorRun(agent, attempt.runId, finalMessage.errorMessage || finalMessage.response || "Agent failed.");
    }

    return completedRun(agent, attempt.runId, finalMessage.response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return signal?.aborted
      ? interruptedRun(agent, attempt.runId, message)
      : errorRun(agent, attempt.runId, message);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

async function AbortSession(session: AgentSession) {
  await Promise.resolve(session.abort()).catch(() => undefined);
}

export type RunAgentResolution<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export function ResolveTaskCwd(
  parentCwd: string,
  requestedCwd: string | undefined,
): RunAgentResolution<string> {
  if (requestedCwd === undefined) return { ok: true, value: parentCwd };

  const cwd = path.resolve(parentCwd, requestedCwd);
  try {
    if (!statSync(cwd).isDirectory()) {
      return { ok: false, error: `Working directory is not a directory: ${cwd}` };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, error: `Working directory does not exist: ${cwd}` };
    if (code === "ENOTDIR") return { ok: false, error: `Working directory is not a directory: ${cwd}` };
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Could not access working directory ${cwd}: ${message}` };
  }

  return { ok: true, value: cwd };
}

export function ResolveModel(
  requestedModel: string | undefined,
  parentModel: Model<any> | undefined,
  registry: ModelRegistry,
): RunAgentResolution<Model<any> | undefined> {
  if (requestedModel === undefined) return { ok: true, value: parentModel };

  const parts = requestedModel.split("/");
  if (parts.some(part => part.trim().length === 0)) {
    return {
      ok: false,
      error: `Invalid model "${requestedModel}": model references cannot be blank or contain empty slash-delimited parts.`,
    };
  }

  const models = registry.getAll();
  const canonical = models.find(model => `${model.provider}/${model.id}` === requestedModel);
  if (canonical) return { ok: true, value: canonical };

  const candidates = models.filter(model => model.id === requestedModel);
  const sameProvider = candidates.find(model => model.provider === parentModel?.provider);
  if (sameProvider) return { ok: true, value: sameProvider };
  if (candidates.length === 1) return { ok: true, value: candidates[0] };
  if (candidates.length > 1) {
    const matches = candidates.map(model => `${model.provider}/${model.id}`).join(", ");
    return {
      ok: false,
      error: `Ambiguous model "${requestedModel}": matches ${matches}. Use a provider-qualified model reference.`,
    };
  }

  return { ok: false, error: `Unknown model: ${requestedModel}` };
}

function GetFinalAssistantMessage(
  session: AgentSession,
): { response: string; stopReason?: string; errorMessage?: string } {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role == "assistant") {
      return {
        response: msg.content
          .filter(part => part.type === "text")
          .map(part => part.text)
          .join("\n")
          .trim() ?? "",
        stopReason: msg.stopReason,
        errorMessage: msg.errorMessage,
      };
    }
  }
  return { response: "" };
}
