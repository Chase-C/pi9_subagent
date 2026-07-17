# Breaking Lifecycle Redesign Plan

## Goal

Make subagent lifecycle state attempt-centric and give retention/attachment one authoritative model. This release intentionally rejects and omits the old contract; it will not provide aliases, migration code, or compatibility projections.

## Canonical model

### Agent and Attempt

- `Agent` is one logical child conversation.
- `Attempt` is one spawn or resume invocation and owns immutable `kind`, `dispatch`, and `prompt`.
- Attempt dispatch is `"foreground" | "background"`; `Agent` no longer stores mutable dispatch.
- Conversation policy is fixed when the Agent is spawned. Resume tasks cannot change policy or label.
- Child ancestry remains session-based; attempt-scoped ancestry is outside this redesign.

### Input/config breaking changes

- Rename task/frontmatter `resumable` to `retainConversation`.
- Rename runtime setting `defaultResumable` to `defaultRetainConversation`.
- Replace run-level `background?: boolean` with `dispatch?: "foreground" | "background"`.
- Remove resume-side retention and label overrides.
- Reject legacy `resumable` and `background` fields rather than ignoring them.
- Internally resolve the external boolean once to `ConversationRetentionPolicy = "retain" | "release"`.

### Attachment ownership

- Remove `AgentManager._attachedSessionIds` and `Agent._attachmentPinned`.
- Store `attachmentOrder?: number` on `Agent`; this is both attachment membership and retention source.
- `AgentManager` owns only a monotonic attachment-order allocator.
- Duplicate attach preserves order; detach clears it; reattach gets a new order.
- Attached sessions are derived by filtering and sorting Agents by `attachmentOrder`.
- Preserve current queued/running/terminal attachment and steering behavior.

### Central retention decision

One domain-owned decision is the only source for catalog cleanup, conversation retention, resume/remove capabilities, snapshot retention, and widget grouping:

```ts
type AgentRetentionReason =
  | "active"
  | "background-result"
  | "conversation-policy"
  | "attachment";

interface AgentRetentionDecision {
  readonly cataloged: boolean;
  readonly catalog: "transient" | "persistent";
  readonly keepConversation: boolean;
  readonly conversationAvailable: boolean;
  readonly canResume: boolean;
  readonly canRemove: boolean;
  readonly reasons: readonly AgentRetentionReason[];
}
```

Required semantics:

- Active attempts are cataloged.
- A background latest attempt retains its result until remove or a later attempt supersedes it.
- Retain policy and attachment retain an available conversation; attachment also pins queued/sessionless rows.
- Background result retention never implies resume capability.
- Only successful completed attempts can resume after binding.
- A resume failure before binding leaves the prior session and resume capability intact.
- Post-bind error/abort/interruption cannot resume.
- Detach falls back to conversation policy/background retention and prunes only when no source remains.

### Snapshot/result breaking changes

- Remove all `resumable`, `defaultResumable`, `resumed`, and `canClear` fields.
- Remove `resumable` from effective SDK configuration.
- Replace top-level snapshot dispatch/resume interpretation with:

```ts
attempt: { kind: "spawn" | "resume"; dispatch: "foreground" | "background" }
conversation: {
  policy: "retain" | "release";
  available: boolean;
  attached: boolean;
}
retention: {
  catalog: "transient" | "persistent";
  reasons: AgentRetentionReason[];
}
capabilities: { canResume: boolean; canRemove: boolean }
```

- Previous-run sections carry their own attempt kind and dispatch.
- Agent results replace `resumable`/`resumed` with `kind`, `dispatch`, `canResume`, and retention reasons.
- A result exposes `sessionId` only while the Agent remains cataloged.
- Keep existing action/view envelopes and preflight-failure representation; they are not part of this redesign.
- Rename the UI/widget `Resumable` section to `Retained` and derive membership from retention reasons/capabilities.

## Implementation waves

1. **Domain foundation**
   - Attempt dispatch and conversation policy types.
   - Agent attachment order and centralized retention decision.
   - New snapshot/result contracts; delete old getters and aliases.
2. **Parallel migration**
   - Runtime orchestration, cancellation, cleanup, attachment operations, and runtime/domain tests.
   - Schema, settings, serialization, tool/view/command/widget consumers, fixtures, and tests.
3. **Release documentation**
   - README, CHANGELOG, package descriptions, and examples use only the new API.
4. **Independent review and integration**
   - Search for forbidden legacy fields, review lifecycle invariants, fix integration issues.
5. **Validation**
   - `npm test --workspace @pi9/subagent`
   - `npm run typecheck --workspace @pi9/subagent`
   - `git diff --check`

## Acceptance criteria

- No production or test code accepts/emits `resumable`, `defaultResumable`, run-level `background`, `resumed`, or `canClear` as lifecycle API fields.
- No compatibility aliases or settings migration paths exist.
- Attempt dispatch remains historically correct across foreground/background resumes.
- Attachment membership and ordering have one source of truth.
- Every catalog/retention/capability consumer uses the canonical retention decision or its snapshot projection.
- Existing lifecycle behavior not explicitly changed above remains covered.
- Full subagent tests and typecheck pass.
