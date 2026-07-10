# Changelog

## [Unreleased]

### Fixed

- Show unknown context capacity accurately after compaction.
- Build reports from the current session and prompt configuration.
- Avoid opening terminal-only UI in non-TUI modes.
- Report active tool tokens consistently across summaries and details.

### Changed

- Align development dependencies with Pi 0.80 and remove the unused `typebox` peer.

## [0.1.0] - 2026-07-09

### Added

- Add the `/context` command with an inline, scrollable context-usage report.
- Show prompt composition and token sizing for the active session.

[Unreleased]: https://github.com/Chase-C/pi9_subagent/compare/context-v0.1.0...HEAD
[0.1.0]: https://github.com/Chase-C/pi9_subagent/releases/tag/context-v0.1.0
