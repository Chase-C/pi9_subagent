import { describe, expect, it } from "vitest";
import { rewriteAskContext } from "../src/context.js";

const call = (args: unknown, id = "ask-1", name = "ask") => ({
  role: "assistant",
  content: [{ type: "text", text: "before" }, { type: "toolCall", id, name, arguments: args }],
});

const result = (details: unknown, id = "ask-1") => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "ask",
  content: [{ type: "text", text: "the original verbose result" }],
  details,
});

describe("rewriteAskContext", () => {
  it("keeps only selected option details and summarizes a successful answer", () => {
    const messages = [
      call({
        question: "Choose",
        context: "For the release",
        options: [
          { label: "Alpha", description: "First" },
          { label: "Beta", description: "Second" },
          { label: "Gamma", description: "Third" },
        ],
        allowMultiple: true,
        allowFreeform: true,
      }),
      result({
        cancelled: false,
        selections: [
          { label: "Beta", description: "Second", comment: "Safest" },
          { label: "Gamma", description: "Third" },
        ],
        freeform: "Ship Friday",
      }),
    ];

    expect(rewriteAskContext(messages)).toEqual([
      {
        ...messages[0],
        content: [
          { type: "text", text: "before" },
          {
            type: "toolCall",
            id: "ask-1",
            name: "ask",
            arguments: {
              question: "Choose",
              context: "For the release",
              options: [
                { label: "Beta", description: "Second", comment: "Safest" },
                { label: "Gamma", description: "Third" },
              ],
              allowMultiple: true,
              freeform: "Ship Friday",
            },
          },
        ],
      },
      {
        ...messages[1],
        content: [{ type: "text", text: "Selected: Beta (Safest), Gamma; response: Ship Friday" }],
      },
    ]);
  });

  it("does not retain irrelevant multiplicity for a single selection", () => {
    const messages = [
      call({ question: "Choose", options: [{ label: "A" }, { label: "B" }], allowMultiple: true }),
      result({ cancelled: false, selections: [{ label: "A" }] }),
    ];

    const rewritten = rewriteAskContext(messages) as any[];
    expect(rewritten[0].content[1].arguments).toEqual({ question: "Choose", options: [{ label: "A" }] });
    expect(rewritten[1].content[0].text).toBe("Selected: A");
  });

  it("is pure and leaves cancelled asks, including alternatives, unchanged", () => {
    const messages = [
      call({ question: "Choose", options: [{ label: "A" }, { label: "B" }] }),
      result({ cancelled: true, selections: [] }),
    ];
    const snapshot = structuredClone(messages);

    const rewritten = rewriteAskContext(messages);

    expect(rewritten).toEqual(snapshot);
    expect(messages).toEqual(snapshot);
    expect(rewritten).not.toBe(messages);
  });

  it.each([
    { label: "unrelated calls", messages: [call({ question: "Q" }, "other", "read"), result({ cancelled: false, selections: [{ label: "A" }] }, "other")] },
    { label: "unmatched calls", messages: [call({ question: "Q" }), result({ cancelled: false, selections: [{ label: "A" }] }, "different")] },
    { label: "malformed details", messages: [call({ question: "Q" }), result({ cancelled: false, selections: "A" })] },
    { label: "UI-unavailable errors", messages: [call({ question: "Q" }), { ...result(undefined), isError: true }] },
  ])("leaves $label unchanged", ({ messages }) => {
    expect(rewriteAskContext(messages)).toEqual(messages);
  });
});
