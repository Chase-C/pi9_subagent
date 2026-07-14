# @pi9/ask

Pi extension that registers a sequential `ask` tool for one focused question. It supports described options, single or multiple selection, per-option comments, and freeform responses.

## Install

```bash
pi install npm:@pi9/ask
```

For local development:

```bash
pi -e packages/ask/src/index.ts
```

## Tool input

```json
{
  "question": "Which deployment target should I use?",
  "context": "Both targets pass the current test suite.",
  "options": [
    {
      "label": "Staging",
      "description": "Validate internally first",
      "preview": "### Staging\n\nDeploy here first and review before production."
    },
    { "label": "Production", "description": "Release immediately" }
  ],
  "allowMultiple": false,
  "allowFreeform": true,
  "timeout": 30000
}
```

Input is trimmed and validated. `options[].preview` is presentation-only Markdown for the highlighted authored option. At 88 or more columns it renders in a wide split beside the options; on narrower terminals it is stacked below them. Previews work in single- and multi-select and are hidden while editing comments or freeform responses. They are not included in the submitted `AskAnswer` or the compact hidden `ask_response`/`answer` summary.

`timeout` is an integer number of milliseconds; `0` disables it. The effective timeout is selected in this order: explicit `timeout` (including `0`), `PI9_ASK_TIMEOUT_MS`, then no timeout. A timeout follows the normal cancellation path, and one deadline covers the whole interaction, including all TUI or RPC dialogs.

## TUI controls

The TUI temporarily replaces the editor with a custom questionnaire. Selection navigation, confirmation, and cancellation honor Pi's `tui.select.*` keybindings (default ↑/↓, Enter, and Escape); **j/k** remain aliases for up/down. Configured Pi bindings take precedence if they collide with fixed shortcuts such as **c** or **Space**, and conflicting fixed actions are omitted from the help text.

- **Space**: select or toggle an option; in multi-select, toggle the freeform response or activate Submit when highlighted; on a single-select freeform row, open its editor
- **Enter**: choose a single option, toggle a multiple-selection option, edit freeform, or activate Submit when highlighted; while editing, save the comment or response
- **c**: add or edit a comment for the highlighted option
- **Escape**: discard the current editor draft; from the option list, cancel
- **Ctrl+C**: cancel, including from an editor

The questionnaire uses a terminal-height viewport. When rows overflow, `↑`, `↓`, or `↕` indicators mark content hidden above, below, or on both sides while the focused area remains visible where possible.

## RPC and unavailable UI

RPC mode remains supported through Pi's `select` and `input` dialogs. Multiple selection uses comma-separated option numbers and comments are collected in separate dialogs; it cannot provide the custom TUI's live checkbox and comment preview. Cancelling any dialog cancels the question.

When Pi reports no UI, `ask` is removed from the active tool list before the agent starts. The tool also guards execution in case a call was already selected, returning a structured `ui_unavailable` result instead of throwing.

## Replay

In TUI mode, selecting a standalone `ask` row in `/tree` reopens a blank copy of the original questionnaire. Replay reuses the original options, including previews, and applies the same timeout precedence: the stored `timeout` (including `0`), then the current `PI9_ASK_TIMEOUT_MS`, then no timeout. A submitted revision is stored as a hidden, durable `ask:reanswer` marker, updates the original tool row, and immediately continues the agent; Escape from the option list cancels without adding a marker or triggering a turn. Branch-summary selections resolve their immediate original parent. Mixed-tool, multiple-ask, and invalid Ask entries cannot be replayed; unrelated entries are ignored.

## Context behavior

Before each model request, completed standalone Ask exchanges are projected non-destructively as hidden `ask:summary` custom messages. Each summary contains compact JSON with `type: "ask_response"`, `question`, optional `context`, `selectionMode`, and an `answer` array of selected objects followed by an optional freeform response. Authored previews never enter this compact `answer`. Stored entries and the visible tool row remain unchanged; revisions use the latest answer.

Mixed-tool or multiple-Ask messages, invalid calls, and cancelled or unavailable results remain intact rather than being projected. Malformed, ambiguous, or unmatched entries are left unchanged.

## Development

```bash
npm run typecheck
npm test
```
