import type { AgentConfig } from "../domain/agent-config.js";
import type { AgentSnapshot } from "../domain/agent-snapshot.js";

export type ConversationLayoutMode = "flat" | "tree";

export interface ConversationRow {
  readonly conversation: AgentSnapshot;
  readonly depth: number;
  readonly contextOnly?: boolean;
}

export function projectConversations(
  conversations: readonly AgentSnapshot[],
  options: { mode?: ConversationLayoutMode; query?: string } = {},
): ConversationRow[] {
  const mode = options.mode ?? "tree";
  const directMatches = conversations.filter(conversation => conversationMatches(conversation, options.query ?? ""));
  if (mode === "flat") return directMatches.map(conversation => ({ conversation, depth: 0 }));

  const allById = new Map(conversations.map(conversation => [conversation.conversationId, conversation]));
  const includedIds = new Set(directMatches.map(conversation => conversation.conversationId));
  for (const match of directMatches) {
    let parentId = match.parent?.conversationId;
    while (parentId) {
      const parent = allById.get(parentId);
      if (!parent || includedIds.has(parent.conversationId)) break;
      includedIds.add(parent.conversationId);
      parentId = parent.parent?.conversationId;
    }
  }

  const included = conversations.filter(conversation => includedIds.has(conversation.conversationId));
  const directIds = new Set(directMatches.map(conversation => conversation.conversationId));
  const byId = new Map(included.map(conversation => [conversation.conversationId, conversation]));
  const children = new Map<string, AgentSnapshot[]>();
  for (const conversation of included) {
    const parentId = conversation.parent?.conversationId;
    if (!parentId || !byId.has(parentId)) continue;
    const siblings = children.get(parentId) ?? [];
    siblings.push(conversation);
    children.set(parentId, siblings);
  }

  const nested = new Set([...children.values()].flat().map(conversation => conversation.conversationId));
  const rows: ConversationRow[] = [];
  const seen = new Set<string>();
  const visit = (conversation: AgentSnapshot, depth: number) => {
    if (seen.has(conversation.conversationId)) return;
    seen.add(conversation.conversationId);
    rows.push({ conversation, depth, ...(!directIds.has(conversation.conversationId) ? { contextOnly: true } : {}) });
    for (const child of children.get(conversation.conversationId) ?? []) visit(child, depth + 1);
  };
  for (const conversation of included) if (!nested.has(conversation.conversationId)) visit(conversation, 0);
  for (const conversation of included) if (!seen.has(conversation.conversationId)) visit(conversation, 0);
  return rows;
}

export function filterAgents(agents: readonly AgentConfig[], query: string): AgentConfig[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...agents];
  return agents.filter(agent => [
    agent.name,
    agent.description,
    agent.source,
    agent.model,
    agent.thinking,
    agent.sourcePath,
    ...(agent.tools ?? []),
    ...(agent.skills ?? []),
  ].some(value => value?.toLowerCase().includes(normalized)));
}

function conversationMatches(conversation: AgentSnapshot, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const values = [
    conversation.conversationId,
    conversation.label,
    conversation.config.name,
    conversation.config.description,
    conversation.config.source,
    conversation.config.model,
    conversation.config.thinking,
    conversation.parent?.conversationId,
    conversation.parent?.runId,
    conversation.effectiveConfig?.model,
    conversation.effectiveConfig?.thinking,
    conversation.effectiveConfig?.cwd,
    ...(conversation.config.tools ?? []),
    ...(conversation.config.skills ?? []),
    ...(conversation.effectiveConfig?.tools ?? []),
    ...(conversation.effectiveConfig?.skills ?? []),
  ];
  for (const run of conversation.runs) {
    values.push(
      run.runId,
      run.kind,
      run.prompt,
      run.status.kind === "done" ? run.status.outcome : run.status.kind,
      run.activity.messageSnippet,
      ...run.activity.toolHistory.flatMap(tool => [tool.name, tool.inputSummary]),
    );
  }
  return values.some(value => value?.toLowerCase().includes(normalized));
}
