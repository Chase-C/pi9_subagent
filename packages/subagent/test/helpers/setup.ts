import { beforeEach } from "vitest";

import { configureSubagentDisplay } from "../../src/view/view-helpers.js";

// Several source modules carry mutable state (e.g. the subagent display
// settings). Reset to defaults before every test so files exercising the
// extension's tool surface don't pollute later tests in the same file.
beforeEach(() => {
  configureSubagentDisplay(undefined);
});
