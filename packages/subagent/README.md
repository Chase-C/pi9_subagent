# @pi9/subagent

A Pi package that registers a non-UI `subagent` tool. The tool delegates work to SDK `AgentSession`s, so each child run gets isolated message history and context before returning structured results to the parent. Agents can opt into process-lifetime resumable sessions for follow-up prompts.

Use it for focused research, planning, review, or implementation handoffs where a separate context window helps keep the parent conversation small.

## Install for local development

```bash
npm install
npm run build --workspace=@pi9/subagent
pi install ./packages/subagent
```

For quick testing without installing:

```bash
npm run build --workspace=@pi9/subagent
pi -e ./packages/subagent
```

After edits, run the package build and reload Pi if needed.

## Agent discovery

Agents are markdown files discovered from:

1. User `${PI_AGENT_DIR ?? ~/.pi/agent}/agents`.
2. The nearest project `.pi/agents`, found by walking up from the tool execution `cwd`.

Each file is parsed as an agent definition and registered by its frontmatter `name` field, not by filename. Later-loaded project agents override user agents with the same runtime name.

## Define agents

Add an agent as a markdown file in a discovered `agents/` directory:

```markdown
---
name: scout
description: Read-only codebase reconnaissance
model: anthropic/claude-sonnet-4
tools: read, bash
resumable: true
---

You are a fast codebase scout. Inspect the repository and return concise, evidence-backed findings with file paths.
```

Supported frontmatter:

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Runtime agent name used in tool calls. |
| `description` | yes | Short summary shown in error messages and available-agent summaries. |
| `model` | no | Model for this agent, resolved through Pi's model registry. Use `provider/model` or an unambiguous model id. |
| `thinking` | no | Thinking level for the child session. |
| `tools` | no | Comma-separated tool allowlist passed to the child SDK session. |
| `resumable` | no | Boolean. Defaults to `false`. When `true`, completed runs are retained for process-lifetime `resume` calls until cleared. |

The markdown body after the frontmatter is trimmed and used as the child session's system prompt.

## Use the tool

The tool accepts a required `action`.

List available agent definitions:

```ts
subagent({ action: "list" })
```

List retained resumable sessions instead:

```ts
subagent({ action: "list", type: "sessions" })
```

Start one or more delegations with `action: "start"`. Each task names an agent and provides the prompt to send to that agent.

Single delegation:

```ts
subagent({
  action: "start",
  tasks: [
    { agent: "scout", prompt: "Find the auth entry points and summarize relevant files." }
  ]
})
```

Bounded multi-task delegation:

```ts
subagent({
  action: "start",
  tasks: [
    { agent: "scout", prompt: "Map frontend auth code and list key files." },
    { agent: "scout", prompt: "Map backend auth code and list key files." },
    { agent: "reviewer", prompt: "Review auth-related tests and summarize coverage gaps." }
  ]
})
```

Resume a completed run from an agent with `resumable: true`:

```ts
subagent({
  action: "resume",
  sessionId: "...",
  prompt: "Use your previous findings to propose the smallest implementation plan."
})
```

Clear retained resumable sessions:

```ts
subagent({ action: "clear", sessionId: "..." }) // clear one
subagent({ action: "clear" })                   // clear all
```

The parent remains responsible for sequencing. If later work depends on earlier output, make one `subagent` call, inspect the result, then make the next call.

## Results

Tool results preserve input order and are returned in both text content (JSON) and `details.results`:

```ts
{
  results: [
    {
      agent: "scout",
      prompt: "Map frontend auth code and list key files.",
      status: "completed",
      output: "...",
      model: "anthropic/claude-sonnet-4",
      sessionId: "..."
    },
    {
      agent: "missing",
      prompt: "...",
      status: "error",
      error: "Unknown agent: missing. Available agents: ..."
    }
  ]
}
```

`isError` is set when any run has a non-`completed` status. Unknown agents and child-session failures are reported as failed per-run results without discarding other scheduled results.

## Limits and current constraints

- `action` is required; legacy `{ tasks: [...] }` calls are rejected.
- Maximum eight tasks per `start` tool call.
- Maximum four child sessions run concurrently.
- Agent discovery always checks user agents and the nearest project agents for the execution `cwd`; there is no `agentScope` parameter.
- No slash command or extension UI is currently provided.
- No per-run timeout is exposed beyond parent abort/cancellation.
- Child sessions isolate Pi message history/context, but they still run inside the same extension process.
- Resumable sessions are retained only for the current Pi process lifetime and only for agents with `resumable: true`.
