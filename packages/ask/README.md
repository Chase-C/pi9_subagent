# @pi9/ask

Pi extension that registers an `ask` tool for requesting one focused answer from the user. The tool supports short context, suggested options with descriptions, and an optional freeform response.

## Install

```bash
pi install npm:@pi9/ask
```

For local development, load `packages/ask/src/index.ts` as an extension:

```bash
pi -e packages/ask/src/index.ts
```

## Tool input

```json
{
  "question": "Which deployment target should I use?",
  "context": "Both targets pass the current test suite.",
  "options": [
    { "label": "Staging", "description": "Validate with internal users first" },
    { "label": "Production", "description": "Release immediately" }
  ],
  "allowFreeform": true
}
```

The tool must run in a mode with interactive UI support. Cancelling the prompt is reported to the agent without inventing an answer.

## Development

```bash
npm run typecheck
npm test
```

### Manual verification

1. Start `pi -e packages/ask/src/index.ts`.
2. Ask the agent to use `ask` with two options.
3. Verify option selection, freeform entry, and Escape cancellation are returned correctly.
