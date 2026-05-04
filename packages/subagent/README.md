# @pi9/subagent

A Pi extension that registers a `/subagents` command and a `subagent` tool. The tool delegates work to short-lived SDK `AgentSession`s, so each child run gets isolated message history and context before returning its final assistant response to the parent.

Use it for focused research, planning, review, or implementation handoffs where a separate context window helps keep the parent conversation small.

## Install for local development

```bash
npm install
npm run build
pi install ./packages/subagent
```

For quick testing without installing:

```bash
npm run build
pi -e ./packages/subagent
```

After edits, run `npm run build` and `/reload` in Pi.

## Agent discovery

Agents are markdown files discovered by name. Discovery always checks package agents first, then optionally adds user and project agents depending on scope. Later sources override earlier sources when they define the same `name`.

Discovery order:

1. Packaged `agents/` directory.
2. User `${PI_AGENT_DIR ?? ~/.pi/agent}/agents`, for scope `user` or `both`.
3. Nearest project `.pi/agents`, found by walking up from `cwd`, for scope `project` or `both`.

The default scope is `user`, which includes packaged and user agents. Project agents are not loaded unless you explicitly request `project` or `both`.

## List agents

Use `/subagents` to list discovered agents and the directories searched:

```text
/subagents
/subagents user
/subagents project
/subagents both
```

The optional argument must be `user`, `project`, or `both`. With no argument, `/subagents` uses `user` scope.

## Define agents

Add an agent as a markdown file in a discovered `agents/` directory:

```markdown
---
name: scout
description: Read-only codebase reconnaissance
model: anthropic/claude-sonnet-4
tools: read, bash
---

You are a fast codebase scout. Inspect the repository and return concise, evidence-backed findings with file paths.
```

Supported frontmatter:

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Runtime agent name used in tool calls. |
| `description` | yes | Short summary shown in `/subagents` and error messages. |
| `model` | no | Model for this agent, resolved through Pi's model registry. Use `provider/model` or an unambiguous model id. |
| `tools` | no | Comma-separated tool allowlist for the child session. |

The markdown body after the frontmatter is trimmed and appended to the child session's system prompt.

## Use the tool

The tool accepts a required `tasks` array. Each item names an agent and provides the prompt to send to that agent.

Single delegation:

```ts
subagent({
  tasks: [
    { agent: "scout", prompt: "Find the auth entry points and summarize relevant files." }
  ]
})
```

Bounded read-only multi-task delegation:

```ts
subagent({
  agentScope: "both",
  tasks: [
    { agent: "scout", prompt: "Map frontend auth code and list key files." },
    { agent: "scout", prompt: "Map backend auth code and list key files." },
    { agent: "reviewer", prompt: "Review auth-related tests and summarize coverage gaps." }
  ]
})
```

The parent remains responsible for sequencing. If later work depends on earlier output, make one `subagent` call, inspect the result, then make the next call.

## Limits and current constraints

- Maximum six tasks per tool call.
- Maximum three child sessions run concurrently.
- Default `agentScope` is `user`; project agents require `agentScope: "project"` or `"both"`.
- No per-run timeout is exposed beyond parent abort/cancellation.
- Final outputs are returned in full under per-run headings.
- Live progress updates are summarized and show only a short preview per run.
- Child sessions isolate Pi message history/context, but they still run inside the same extension process.
