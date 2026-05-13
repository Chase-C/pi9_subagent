import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import subagentExtension from "../../src/index.js";

function registerExtension(dependencies: any = {}) {
  let registeredTool: any;
  subagentExtension({ registerTool: (tool: any) => { registeredTool = tool; } } as any, dependencies);
  return registeredTool;
}

test("tool agents action returns the flat definition list with tools and source path", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-agents-"));
  const projectAgents = join(root, ".pi", "agents");
  await mkdir(projectAgents, { recursive: true });
  await writeFile(
    join(projectAgents, "helper.md"),
    `---\nname: helper\ndescription: Helps\nresumable: true\nmodel: test/model\ntools: read, bash\n---\nHelp prompt`,
  );

  const tool = registerExtension();
  const result = await tool.execute("tool-call", { action: "agents" }, undefined, undefined, { cwd: root });

  assert.equal(result.isError, false);
  assert.equal(result.details.view, "agents");
  const helper = result.details.agents.find((a: any) => a.name === "helper");
  assert.ok(helper);
  assert.equal(helper.resumable, true);
  assert.deepEqual(helper.tools, ["read", "bash"]);
  assert.equal(helper.sourcePath, join(projectAgents, "helper.md"));
  assert.equal(Object.prototype.hasOwnProperty.call(helper, "systemPrompt"), false);
});

test("tool agents action returns each agent default skills alongside tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-agents-skills-default-"));
  const projectAgents = join(root, ".pi", "agents");
  await mkdir(projectAgents, { recursive: true });
  await writeFile(
    join(projectAgents, "helper.md"),
    `---\nname: helper\ndescription: Helps\ntools: read\nskills: foo, bar\n---\nHelp prompt`,
  );

  const tool = registerExtension();
  const result = await tool.execute("tool-call", { action: "agents" }, undefined, undefined, { cwd: root });

  assert.equal(result.isError, false);
  const helper = result.details.agents.find((a: any) => a.name === "helper");
  assert.ok(helper);
  assert.deepEqual(helper.skills, ["foo", "bar"]);
  assert.deepEqual(helper.tools, ["read"]);
});
