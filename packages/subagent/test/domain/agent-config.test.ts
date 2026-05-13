import { test } from "vitest";
import assert from "node:assert/strict";

import { BuildAgentConfig } from "../../src/domain/agent-config.js";

test("BuildAgentConfig parses CSV skills frontmatter and leaves skills undefined when absent", () => {
  const withSkills = BuildAgentConfig(
    `---\nname: helper\ndescription: d\nskills: foo, bar\n---\nbody`,
    "project",
  );
  assert.ok(!("error" in withSkills));
  assert.deepEqual(withSkills.skills, ["foo", "bar"]);

  const withoutSkills = BuildAgentConfig(
    `---\nname: helper\ndescription: d\n---\nbody`,
    "project",
  );
  assert.ok(!("error" in withoutSkills));
  assert.equal(withoutSkills.skills, undefined);
});
