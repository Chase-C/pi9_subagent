import { test } from "vitest";
import assert from "node:assert/strict";

import subagentExtension from "../../src/index.js";
import { fakeAgent } from "../helpers/fake-agent.js";

function registerExtension() {
  let registeredTool: any;
  subagentExtension({ registerTool: (tool: any) => { registeredTool = tool; } } as any);
  return registeredTool;
}

test("results renderer uses structured details instead of raw tool content", () => {
  const tool = registerExtension();
  const details = {
    view: "results",
    results: [
      { snapshot: fakeAgent({ id: "s1", config: { name: "alpha" }, status: { kind: "completed", startedAt: 1, completedAt: 2, response: "ok" } }) },
    ],
  };

  const component = tool.renderResult(
    { content: [{ type: "text", text: "RAW_RESULT_FALLBACK" }], details },
    { expanded: false },
    { fg: (_color: string, text: string) => text },
  );
  const rendered = component.render(120).join("\n");

  assert.match(rendered, /alpha/);
  assert.doesNotMatch(rendered, /RAW_RESULT_FALLBACK/);
});
