import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import type { Agent } from "../domain/agent.js";
import type { AgentRegistry } from "../domain/agent-registry.js";
import { defineSubagentTool } from "../tool/define-subagent-tool.js";
import type { SubagentSettings } from "../ui/settings.js";
import type { AgentManager } from "./agent-manager.js";
import type { BatchOrchestrator } from "./batch-orchestrator.js";

export interface ChildFactoryDeps {
  manager: AgentManager;
  orchestrator: BatchOrchestrator;
  registry: AgentRegistry;
  parent: Agent;
  getCurrentSettings: () => SubagentSettings;
}

/**
 * Returns an ExtensionFactory that registers a `subagent` tool inside a child Pi session,
 * delegating into the shared manager/orchestrator so the entire tree lives in one process.
 * The child tool skips settings and registry reloads — they are already populated by the
 * parent invocation that triggered the child — and threads `parent.id` as the new agents'
 * `parentSessionId`.
 */
export function makeChildSubagentFactory(deps: ChildFactoryDeps): ExtensionFactory {
  const { manager, orchestrator, registry, parent, getCurrentSettings } = deps;
  return (pi) => {
    pi.registerTool(defineSubagentTool({
      agentManager: manager,
      orchestrator,
      agentRegistry: registry,
      getCurrentSettings,
      prepareInvocation: async () => getCurrentSettings(),
      parentSessionId: parent.id,
    }));
  };
}
