type RecordValue = Record<string, unknown>;

/**
 * Projects completed ask interactions into a smaller, model-facing form.
 *
 * The input is never mutated. A pair is rewritten only when both its call and
 * successful structured result can be identified unambiguously.
 */
export function rewriteAskContext<T>(messages: readonly T[]): T[] {
  const copied = structuredClone(messages) as T[];
  const calls = new Map<string, { block: RecordValue; args: RecordValue }>();

  for (const message of copied) {
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "toolCall" || block.name !== "ask") continue;
      if (typeof block.id !== "string" || !isAskArguments(block.arguments)) continue;
      calls.set(block.id, { block, args: block.arguments });
    }
  }

  for (const message of copied) {
    if (!isRecord(message)) continue;
    const result = message as RecordValue;
    if (result.role !== "toolResult"
      || result.toolName !== "ask"
      || result.isError === true
      || typeof result.toolCallId !== "string") continue;

    const call = calls.get(result.toolCallId);
    const details = successfulDetails(result.details);
    if (!call || !details) continue;

    const options = details.selections.map(selection => selectedOption(selection, call.args));
    const arguments_: RecordValue = { question: call.args.question };
    if (typeof call.args.context === "string") arguments_.context = call.args.context;
    if (options.length > 0) arguments_.options = options;
    if (details.selections.length > 1 && call.args.allowMultiple === true) arguments_.allowMultiple = true;
    if (details.freeform !== undefined) arguments_.freeform = details.freeform;
    call.block.arguments = arguments_;

    result.content = [{ type: "text", text: summarize(details) }];
  }

  return copied;
}

type Selection = { label: string; description?: string; comment?: string };
type SuccessfulDetails = { selections: Selection[]; freeform?: string };

function successfulDetails(value: unknown): SuccessfulDetails | undefined {
  if (!isRecord(value) || value.cancelled !== false) return undefined;
  const rawSelections = value.selections ?? value.selectedOptions;
  if (!Array.isArray(rawSelections)) return undefined;

  const selections: Selection[] = [];
  for (const raw of rawSelections) {
    if (!isRecord(raw) || typeof raw.label !== "string") return undefined;
    if (raw.description !== undefined && typeof raw.description !== "string") return undefined;
    if (raw.comment !== undefined && typeof raw.comment !== "string") return undefined;
    selections.push({
      label: raw.label,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      ...(typeof raw.comment === "string" ? { comment: raw.comment } : {}),
    });
  }

  const rawFreeform = value.freeform ?? value.freeformAnswer;
  if (rawFreeform !== undefined && typeof rawFreeform !== "string") return undefined;
  if (selections.length === 0 && rawFreeform === undefined) return undefined;
  return { selections, ...(rawFreeform !== undefined ? { freeform: rawFreeform } : {}) };
}

function selectedOption(selection: Selection, args: RecordValue): Selection {
  const original = Array.isArray(args.options)
    ? args.options.find(option => isRecord(option) && option.label === selection.label)
    : undefined;
  const description = selection.description
    ?? (isRecord(original) && typeof original.description === "string" ? original.description : undefined);
  return {
    label: selection.label,
    ...(description !== undefined ? { description } : {}),
    ...(selection.comment !== undefined ? { comment: selection.comment } : {}),
  };
}

function summarize(details: SuccessfulDetails): string {
  const selected = details.selections.map(({ label, comment }) => comment ? `${label} (${comment})` : label);
  const parts: string[] = [];
  if (selected.length > 0) parts.push(`Selected: ${selected.join(", ")}`);
  if (details.freeform !== undefined) parts.push(`response: ${details.freeform}`);
  return parts.join("; ");
}

function isAskArguments(value: unknown): value is RecordValue & { question: string } {
  return isRecord(value) && typeof value.question === "string";
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
