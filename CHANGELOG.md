# Changelog

This changelog starts with version `v0.2.1`.

## [Unreleased]

### Added

- Add a concise `promptSnippet` so the custom tool appears in Pi's `Available tools` section.
- Add tool-specific delegation guidelines covering when to delegate, when to work directly, and when agent discovery is necessary.
- Add model-facing serializers for agent discovery and session inventory while preserving richer internal details for rendering.
- Expose resolved `effectiveConfig` metadata in successful task results and session inventory, including the canonical model, thinking level, resolved working directory, effective skills, active tools, and resumability.
- Add runtime tracking for acknowledged background results so delayed completion notifications can be deduplicated.

### Changed

- Update the release script to roll `[Unreleased]` into a dated version section and prepend those entries to generated GitHub Release notes.
- Replace the long, duplicated subagent tool description with a compact capability summary.
- Move action semantics and call mechanics into concise, action-specific schema field descriptions.
- Keep the public tool schema flat and provider-compatible while tightening enum, string, and array validation.
- Report agent discovery's overridable resumability setting as `defaultResumable` while retaining the internal `resumable` field used by renderers.
- Normalize model-facing inventory statuses to `queued`, `running`, `completed`, `error`, `aborted`, `interrupted`, or `skipped`, including previous runs.
- Translate the command UI's internal `canClear` capability to the model-facing `canRemove` capability.
- Document when results omit non-actionable session IDs and how `resumable: false` affects resumed session retention.
- Hide sessions from listing and lookup as soon as removal begins, including while a running session is being aborted.
- Treat retrieval of a completed background result as notification acknowledgement and clear that acknowledgement when the session is resumed.
- Distinguish background result retention from conversation resumability in the schema, settings UI, and README.
- Document the default blocking behavior of `run`, immediate background handles, and the exact selection behavior of every removal scope.

### Fixed

- Suppress stale background completion notifications when their sessions were removed before notification dispatch.
- Suppress delayed completion notifications after `results` has already returned the completed session or while a matching `results` call is starting.
- Report a precise `resumable: false` error when a completed non-resumable session receives a follow-up.
- Reject empty task arrays, empty session ID arrays, and empty removal session lists before execution.
- Reject empty task identifiers, prompts, model and working-directory overrides, and skill names in the public schema.
- Reject unsupported thinking levels consistently in schema and runtime validation.

### Tests

- Add exact coverage for the compact description, prompt snippet, and delegation guidelines.
- Add schema coverage for non-empty values, thinking-level enums, background semantics, resumability, and removal scopes.
- Add projection coverage for `defaultResumable`, normalized inventory statuses, model-facing removal capability, and resolved `effectiveConfig` values.
- Add lifecycle coverage for removal visibility and stale notifications after removal, result retrieval, or a matching results-tool start.
- Add regression coverage for precise non-resumable follow-up errors and notification acknowledgement reset after resume.

## [0.2.1] - 2026-07-09

### Added

- Render background subagent completion notifications with compact and expanded views, themed statuses, elapsed times, and session IDs when expanded.
- Emit subagent lifecycle events for generic updates plus queued, started, and completed milestones.
- Persist terminal subagent session metadata to a `subagent-session-index` custom entry, including status, timing, prompt previews, and output/error snippets.
- Warn before switching or forking sessions while subagents are still queued or running.
- Add `/subagents` argument completions and direct `agents` / `sessions` views.

### Changed

- Load inherited child-session extensions through Pi's native resource loader and module cache.
- Supply recursive child-session subagent context through SDK custom tools instead of inline extension factories.
- Improve subagent resume messages with themed statuses and an expanded labeled-detail layout.
- Update README installation guidance to use `pi install npm:@pi9/subagent`.

### Fixed

- Exclude the root `@pi9/subagent` extension from inherited child extension paths, preventing duplicate managers and lifecycle setup.
- Preserve Pi compatibility aliases when inherited extensions import legacy `@earendil-works/pi-ai` exports.
- Ensure resumed subagent attempts emit fresh queued, started, and completed lifecycle events instead of being deduplicated as prior attempts.

### Tests

- Add coverage for native inherited extension loading, canonical self-exclusion, SDK child tools, and recursive shared-manager behavior.
- Add coverage for lifecycle events, session metadata persistence, session guards, command completions, background completion rendering, and resume message rendering.

[Unreleased]: https://github.com/Chase-C/pi9_subagent/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/Chase-C/pi9_subagent/compare/v0.1.1...v0.2.1
