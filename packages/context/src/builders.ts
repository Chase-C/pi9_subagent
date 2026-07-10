import { readFileSync } from "node:fs";
import {
  buildSessionContext,
  estimateTokens as estimateMessageTokens,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { PromptSnapshot } from "./prompt-snapshot.js";
import type {
  ContextReport,
  ConversationDetails,
  ConversationStats,
  ConversationTurn,
  MemoryDetails,
  ModelDetails,
  SkillDetails,
  ToolDetails,
  ToolSource,
} from "./types.js";

type AgentMessage = Parameters<typeof estimateMessageTokens>[0];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

export function buildContextReport(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  snapshot?: PromptSnapshot,
): ContextReport | undefined {
  const usage = ctx.getContextUsage();
  if (!usage) {
    return undefined;
  }

  const systemPrompt = snapshot?.systemPrompt ?? ctx.getSystemPrompt() ?? "";
  const model: ModelDetails = {
    provider: ctx.model?.provider ?? "Unknown Provider",
    id: ctx.model?.id ?? "unknown-model",
    name: ctx.model?.name ?? ctx.model?.id ?? "unknown-model",
    thinking: pi.getThinkingLevel(),
    contextWindow: usage.contextWindow ?? ctx.model?.contextWindow,
  };

  if (!snapshot) {
    return {
      kind: "static",
      model,
      usage,
      promptTokens: estimateTokens(systemPrompt),
      tools: collectToolDetails(pi),
      skills: collectSkillDetails(pi),
    };
  }

  return {
    kind: "conversation",
    model,
    usage,
    promptTokens: estimateTokens(systemPrompt),
    tools: collectToolDetails(pi),
    skills: collectSkillDetails(pi, snapshot),
    memory: collectMemoryDetails(snapshot),
    snapshot: { capturedAt: snapshot.capturedAt },
    conversation: collectConversationDetails(ctx),
  };
}

export function estimateTokens(text: unknown): number {
  if (typeof text === "string") {
    return Math.ceil(text.length / 4);
  }
  return Math.ceil(JSON.stringify(text ?? "").length / 4);
}

export function collectSkillDetails(
  pi: ExtensionAPI,
  snapshot?: PromptSnapshot,
): SkillDetails[] {
  const details: SkillDetails[] = [];
  const skills = snapshot
    ? (snapshot.options.skills ?? []).filter((skill) => !skill.disableModelInvocation)
    : pi.getCommands().filter((cmd) => cmd.source === "skill");

  const visited = new Set<string>();
  skills.forEach((skill) => {
    const key = `${skill.name}-${skill.sourceInfo.scope}`;
    if (visited.has(key)) {
      return;
    }
    visited.add(key);

    let content = "";
    const path = "filePath" in skill && typeof skill.filePath === "string"
      ? skill.filePath
      : skill.sourceInfo.path;
    try {
      content = readFileSync(path, "utf-8");
    } catch {
      // Missing skill files should not make /context fail.
    }

    details.push({
      name: skill.name,
      descTokens: estimateTokens(`${skill.name} ${skill.description}`),
      bodyTokens: estimateTokens(content),
      scope: skill.sourceInfo.scope === "project" ? "project" : "user",
    });
  });

  details.sort((a, b) => b.descTokens - a.descTokens || a.name.localeCompare(b.name));
  return details;
}

export function collectToolDetails(pi: ExtensionAPI): ToolDetails[] {
  const details: ToolDetails[] = [];
  const active = pi.getActiveTools();
  const tools = pi.getAllTools();

  const visited = new Set<string>();
  tools.forEach((tool) => {
    const key = `${tool.name}-${tool.sourceInfo.scope}`;
    if (visited.has(key)) {
      return;
    }
    visited.add(key);

    const source = tool.sourceInfo.source;
    let detailSource: ToolSource;
    if (/^mcp_/i.test(tool.name) || /mcp/i.test(source)) {
      detailSource = { kind: "mcp", name: source };
    } else if (source === "builtin" || source === "sdk") {
      detailSource = { kind: "builtin" };
    } else {
      detailSource = { kind: "extension", name: source };
    }

    details.push({
      name: tool.name,
      tokens: estimateTokens([tool.name, tool.description, JSON.stringify(tool.parameters)].join("\n")),
      source: detailSource,
      active: active.includes(tool.name),
    });
  });

  details.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
  return details;
}

export function collectMemoryDetails(snapshot?: PromptSnapshot): MemoryDetails[] {
  const files = snapshot?.options.contextFiles ?? [];
  const details = files.map((file): MemoryDetails => ({
    path: file.path,
    tokens: estimateTokens(file.content),
  }));

  details.sort((a, b) => b.tokens - a.tokens || a.path.localeCompare(b.path));
  return details;
}

export function collectConversationDetails(ctx: ExtensionCommandContext): ConversationDetails {
  const messages = buildSessionContext(ctx.sessionManager.getBranch()).messages;
  const stats: ConversationStats = {
    userMessages: 0,
    assistantMessages: 0,
    toolResults: 0,
    toolCalls: 0,
    thinkingBlocks: 0,
    imageBlocks: 0,
  };
  const history: ConversationTurn[] = [];
  let tokens = 0;

  for (const message of messages) {
    const messageTokens = estimateMessageTokens(message);
    tokens += messageTokens;

    switch (message.role) {
      case "user":
        stats.userMessages += 1;
        stats.imageBlocks += countImageBlocks(message.content);
        history.push({ kind: "user", tokens: messageTokens });
        break;
      case "assistant":
        stats.assistantMessages += 1;
        addAssistantTurns(message, history, stats, messageTokens);
        break;
      case "toolResult":
        stats.toolResults += 1;
        stats.imageBlocks += countImageBlocks(message.content);
        history.push({
          kind: "tool-result",
          tool: message.toolName ?? "unknown",
          tokens: messageTokens,
          callId: message.toolCallId,
          isError: message.isError,
        });
        break;
      case "custom":
        stats.imageBlocks += countImageBlocks(message.content);
        history.push({ kind: "custom", tokens: messageTokens });
        break;
      default:
        history.push({ kind: "custom", tokens: messageTokens });
        break;
    }
  }

  return { stats, history, tokens };
}

function addAssistantTurns(
  message: AssistantMessage,
  history: ConversationTurn[],
  stats: ConversationStats,
  fallbackTokens: number,
): void {
  if (!Array.isArray(message.content)) {
    history.push({ kind: "assistant", tokens: fallbackTokens });
    return;
  }

  let emitted = false;
  for (const block of message.content) {
    if (!block || typeof block !== "object" || !("type" in block)) {
      continue;
    }

    if (block.type === "text") {
      history.push({ kind: "assistant", tokens: estimateTokens("text" in block ? block.text : "") });
      emitted = true;
    } else if (block.type === "thinking") {
      stats.thinkingBlocks += 1;
      history.push({ kind: "thinking", tokens: estimateTokens("thinking" in block ? block.thinking : "") });
      emitted = true;
    } else if (block.type === "toolCall") {
      stats.toolCalls += 1;
      history.push({
        kind: "tool-call",
        tool: "name" in block && typeof block.name === "string" ? block.name : "unknown",
        tokens: estimateTokens(block),
        callId: "id" in block && typeof block.id === "string" ? block.id : undefined,
      });
      emitted = true;
    }
  }

  if (!emitted) {
    history.push({ kind: "assistant", tokens: fallbackTokens });
  }
}

function countImageBlocks(content: unknown): number {
  if (!Array.isArray(content)) {
    return 0;
  }

  let count = 0;
  for (const block of content) {
    if (block && typeof block === "object" && "type" in block && block.type === "image") {
      count += 1;
    }
  }
  return count;
}
