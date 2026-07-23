import { describe, expect, it } from "vitest";
import { filterAgents, projectConversations } from "../../src/command/overlay-model.js";
import { fakeAgent } from "../helpers/fake-agent.js";

describe("conversation projection", () => {
  it("keeps descendants whose parent was removed", () => {
    const child = fakeAgent({ conversationId: "child", parent: { conversationId: "removed", runId: "removed-run" } });
    expect(projectConversations([child])).toEqual([{ conversation: child, depth: 0 }]);
  });

  it("includes ancestors as context when a descendant matches", () => {
    const parent = fakeAgent({ conversationId: "parent", prompt: "parent task" });
    const child = fakeAgent({ conversationId: "child", parent: { conversationId: "parent", runId: "parent-run" }, prompt: "needle task" });

    const rows = projectConversations([parent, child], { mode: "tree", query: "needle" });

    expect(rows.map(row => [row.conversation.conversationId, row.depth, row.contextOnly])).toEqual([
      ["parent", 0, true],
      ["child", 1, undefined],
    ]);
  });

  it("filters conversations using run identities and activity", () => {
    const first = fakeAgent({ conversationId: "first", runId: "run-alpha" });
    const second = fakeAgent({ conversationId: "second", messageSnippet: "reviewing authentication" });

    expect(projectConversations([first, second], { mode: "flat", query: "run-alpha" }).map(row => row.conversation)).toEqual([first]);
    expect(projectConversations([first, second], { mode: "flat", query: "authentication" }).map(row => row.conversation)).toEqual([second]);
  });
});

describe("agent filtering", () => {
  it("matches configuration fields", () => {
    const agents = [
      { name: "reviewer", description: "Reviews code", source: "project", skills: ["security"] },
      { name: "writer", description: "Writes docs", source: "user", skills: [] },
    ] as any;

    expect(filterAgents(agents, "security").map(agent => agent.name)).toEqual(["reviewer"]);
    expect(filterAgents(agents, "user").map(agent => agent.name)).toEqual(["writer"]);
  });
});
