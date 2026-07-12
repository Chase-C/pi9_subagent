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
    { "label": "Staging", "description": "Validate internally first" },
    { "label": "Production", "description": "Release immediately" }
  ],
  "allowMultiple": false,
  "allowFreeform": true
}
```

Input is trimmed and validated. The original questionnaire remains in session history, so selecting its tool call in `/tree` can rerun the complete question and all original alternatives.

## TUI controls

The TUI uses a full-screen overlay:

- **↑/↓** or **j/k**: move between options
- **Space**: toggle an option in multiple-selection mode
- **Enter**: choose a single option, submit multiple selections, or edit freeform
- **c**: add or edit a comment for the highlighted option
- **Escape**: discard the current editor draft; from the option list, cancel
- **Ctrl+C**: cancel from an editor

## RPC and unavailable UI

RPC mode falls back to Pi's `select` and `input` dialogs. Multiple selection uses comma-separated option numbers and comments are collected in separate dialogs; it cannot provide the rich overlay's live checkbox and comment preview. Cancelling any dialog cancels the question. Modes without dialog-capable UI return a structured `ui_unavailable` result rather than throwing.

## Context behavior

Before each model request, completed ask calls are copied and pruned to the selected options, comments, and freeform answer. This reduces context use without mutating stored session entries. Cancelled and unavailable questionnaires are left intact.

## Development

```bash
npm run typecheck
npm test
```
