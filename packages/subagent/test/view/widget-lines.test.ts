import { test } from "vitest";
import assert from "node:assert/strict";

import { abbreviateTokens } from "../../src/view/format-helpers.js";
import { formatWidgetLines } from "../../src/view/session-lines.js";
import { DEFAULT_SUBAGENT_SETTINGS } from "../../src/config/settings.js";
import { fakeAgent } from "../helpers/fake-agent.js";

const DEFAULT_DISPLAY = DEFAULT_SUBAGENT_SETTINGS.display;

test("abbreviateTokens renders sub-1k as-is, 1k-9999 with one decimal, and 10k+ without decimal", () => {
  assert.equal(abbreviateTokens(850), "850");
  assert.equal(abbreviateTokens(3400), "3.4k");
  assert.equal(abbreviateTokens(12000), "12k");
  assert.equal(abbreviateTokens(0), undefined);
});

test("formatWidgetLines renders Background and Resumable sections with header counts and condensed rows", () => {
  const now = 10_000;
  const agents = [
    fakeAgent({
      id: "bg-run",
      dispatch: "background",
      config: { name: "scout" },
      createdAt: 1,
      status: { kind: "running", startedAt: 9_000 },
      usage: { ...fakeAgent().usage!, totalTokens: 3400 },
      activeTools: ["grep"],
    }),
    fakeAgent({
      id: "bg-done",
      dispatch: "background",
      config: { name: "reviewer" },
      createdAt: 2,
      status: { kind: "completed", startedAt: 1, completedAt: 5_000, response: "ok" },
      usage: { ...fakeAgent().usage!, totalTokens: 850 },
    }),
    fakeAgent({
      id: "res",
      config: { name: "helper", resumable: true },
      createdAt: 3,
      status: { kind: "completed", startedAt: 1, completedAt: 5_000, response: "done" },
    }),
    fakeAgent({
      id: "fg",
      retention: "transient",
      config: { name: "inline" },
      createdAt: 4,
      status: { kind: "running", startedAt: 9_500 },
    }),
  ];

  const lines = formatWidgetLines(agents, now);

  assert.equal(lines[0], "Background · 1 running · 1 ready");
  assert.match(lines[1], /^  [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] scout · 1s · 3\.4k · tool:grep$/);
  assert.equal(lines[2], "  ✓ reviewer · 4s · 850");
  assert.equal(lines[3], "Resumable · 1 ready");
  assert.equal(lines[4], "  ✓ helper · 4s");
  assert.equal(lines[5], "+1 foreground running");
});

test("formatWidgetLines returns empty when only foreground-transient agents are active", () => {
  const agents = [
    fakeAgent({ retention: "transient", config: { name: "inline" }, status: { kind: "running", startedAt: 1 } }),
    fakeAgent({ id: "q", retention: "transient", config: { name: "waiting" }, status: { kind: "queued" } }),
  ];

  assert.deepEqual(formatWidgetLines(agents, 5_000), []);
});

test("formatWidgetLines omits transient terminal background agents but keeps active transient background agents", () => {
  const agents = [
    fakeAgent({
      id: "bg-running",
      dispatch: "background",
      retention: "transient",
      config: { name: "runner" },
      createdAt: 1,
      status: { kind: "running", startedAt: 4_000 },
    }),
    fakeAgent({
      id: "bg-queued",
      dispatch: "background",
      retention: "transient",
      config: { name: "waiting" },
      createdAt: 2,
      status: { kind: "queued" },
    }),
    fakeAgent({
      id: "bg-completed",
      dispatch: "background",
      retention: "transient",
      config: { name: "done-transient" },
      createdAt: 3,
      status: { kind: "completed", startedAt: 1, completedAt: 2_000, response: "ok" },
    }),
    fakeAgent({
      id: "bg-error",
      dispatch: "background",
      retention: "transient",
      config: { name: "error-transient" },
      createdAt: 4,
      status: { kind: "error", startedAt: 1, completedAt: 2_000, error: "boom" },
    }),
  ];

  const lines = formatWidgetLines(agents, 5_000);

  assert.equal(lines[0], "Background · 1 running · 1 queued");
  assert.match(lines[1], /^  [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] runner · 1s$/);
  assert.equal(lines[2], "  ○ waiting · 4s");
  assert.equal(lines.length, 3);
  assert.doesNotMatch(lines.join("\n"), /done-transient|error-transient|ready|error/);
});

test("formatWidgetLines omits retained rows but keeps counts when widgetShowRetainedSessions is false", () => {
  const agents = [
    fakeAgent({
      dispatch: "background",
      config: { name: "reviewer" },
      status: { kind: "completed", startedAt: 1, completedAt: 2_000, response: "ok" },
    }),
    fakeAgent({
      id: "err",
      dispatch: "background",
      config: { name: "flaky" },
      createdAt: 2,
      status: { kind: "error", startedAt: 1, completedAt: 2_000, error: "boom" },
    }),
  ];

  const lines = formatWidgetLines(agents, 5_000, { ...DEFAULT_DISPLAY, widgetShowRetainedSessions: false });

  assert.deepEqual(lines, ["Background · 1 ready · 1 error"]);
});

test("formatWidgetLines caps rows per section and keeps in-flight rows preferentially", () => {
  const agents = Array.from({ length: 8 }, (_, i) => fakeAgent({
    id: `bg-${i}`,
    dispatch: "background",
    createdAt: i + 1,
    config: { name: `agent-${i}` },
    status: i < 2
      ? { kind: "running", startedAt: 1 }
      : { kind: "completed", startedAt: 1, completedAt: 2_000, response: "ok" },
  }));

  const lines = formatWidgetLines(agents, 5_000, { ...DEFAULT_DISPLAY, widgetMaxRowsPerSection: 3 });

  assert.equal(lines[0], "Background · 2 running · 6 ready");
  assert.equal(lines.length, 5);
  assert.match(lines[1], /^  [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] agent-0/);
  assert.match(lines[2], /^  [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] agent-1/);
  assert.equal(lines[3], "  ✓ agent-2 · 1s");
  assert.equal(lines[4], "  +5 more");
});

test("formatWidgetLines omits footer when widgetShowForeground is false", () => {
  const agents = [
    fakeAgent({ dispatch: "background", config: { name: "scout" }, status: { kind: "running", startedAt: 1 } }),
    fakeAgent({ id: "fg", retention: "transient", config: { name: "inline" }, status: { kind: "running", startedAt: 1 } }),
  ];

  const lines = formatWidgetLines(agents, 5_000, { ...DEFAULT_DISPLAY, widgetShowForeground: false });

  assert.equal(lines.length, 2);
  assert.doesNotMatch(lines.join("\n"), /foreground running/);
});

test("formatWidgetLines never renders foreground-transient agents as section rows", () => {
  const agents = [
    fakeAgent({ dispatch: "background", config: { name: "scout" }, status: { kind: "running", startedAt: 1 } }),
    fakeAgent({ id: "fg", retention: "transient", config: { name: "inline" }, status: { kind: "running", startedAt: 1 } }),
  ];

  const joined = formatWidgetLines(agents, 5_000).join("\n");

  assert.match(joined, /scout/);
  assert.doesNotMatch(joined, /inline/);
});
