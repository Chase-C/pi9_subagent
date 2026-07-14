# Changelog

All notable changes to `@pi9/ask` will be documented in this file.

## [0.1.0]

### Added

- Add a sequential `ask` tool for focused single-select and multi-select questions across TUI and RPC modes.
- Add a keyboard-driven questionnaire with option descriptions, comments, freeform responses, cancellation, checkbox selection, and a dedicated multi-select submit action.
- Add compact pending and answered tool-call rendering with Nerd Font selection glyphs, visible unselected options, and inline comment and freeform details.
- Add branch-aware re-answering from the session tree with durable hidden revisions that update the original Ask result.
- Add compact hidden context summaries for completed standalone Ask exchanges while preserving stored conversation entries.
- Add strict input validation, structured answer details, model guidance, and graceful handling when interactive UI is unavailable.
- Add presentation-only Markdown previews for highlighted options, with stable top-aligned preview regions, wide splits at 88 columns, narrow stacking, previewless-row height retention, and terminal-height overflow indicators for single- and multi-select TUI questionnaires.
- Add integer-millisecond timeouts from `timeout` or `PI9_ASK_TIMEOUT_MS`, with explicit precedence, zero disabling, cancellation-path handling, and one deadline across the full interaction.
- Honor Pi selection keybindings while retaining `j/k`, comment, Space, and editor controls; keep RPC dialogs supported.
- Deactivate `ask` when no UI is available and guard direct execution with a structured `ui_unavailable` result.
- Reuse original previews and timeout behavior during replay without placing previews in `AskAnswer` or compact `ask_response`/`answer` summaries.

[0.1.0]: https://github.com/Chase-C/pi9/releases/tag/ask-v0.1.0
