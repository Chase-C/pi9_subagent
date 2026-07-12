import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const optionSchema = Type.Object({
  label: Type.String({ description: "Short option title" }),
  description: Type.Optional(Type.String({ description: "Optional explanation of this option" })),
});

const askParameters = Type.Object({
  question: Type.String({ description: "One focused question to ask the user" }),
  context: Type.Optional(Type.String({ description: "Brief context shown before the question" })),
  options: Type.Optional(Type.Array(optionSchema, { description: "Suggested answers" })),
  allowFreeform: Type.Optional(Type.Boolean({ description: "Allow a typed response. Defaults to true." })),
});

export default function askExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask",
    label: "Ask",
    description: "Ask the user one focused question, optionally with suggested answers.",
    promptSnippet: "Ask the user one focused question with optional choices",
    promptGuidelines: [
      "Use ask when user input is required to resolve ambiguity or choose between valid options.",
      "Ask exactly one focused question per ask call.",
    ],
    parameters: askParameters,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        throw new Error("The ask tool requires an interactive UI.");
      }

      const options = params.options ?? [];
      const allowFreeform = params.allowFreeform !== false;
      if (options.length === 0 && !allowFreeform) {
        throw new Error("The ask tool needs at least one option when freeform responses are disabled.");
      }

      const prompt = params.context ? `${params.context}\n\n${params.question}` : params.question;
      const customLabel = "Type a response…";
      const choices = options.map(formatOption);
      if (allowFreeform) choices.push(customLabel);

      const selection = await ctx.ui.select(prompt, choices);
      if (selection === undefined) {
        return response(params.question, null, true);
      }

      const selectedIndex = choices.indexOf(selection);
      if (selectedIndex < options.length) {
        return response(params.question, options[selectedIndex]?.label ?? selection, false);
      }

      const answer = await ctx.ui.input(params.question);
      if (answer === undefined) return response(params.question, null, true);
      return response(params.question, answer, false);
    },
  });
}

function formatOption(option: { label: string; description?: string }) {
  return option.description ? `${option.label} — ${option.description}` : option.label;
}

function response(question: string, answer: string | null, cancelled: boolean) {
  return {
    content: [{
      type: "text" as const,
      text: cancelled ? "User cancelled the question." : `User answered: ${answer}`,
    }],
    details: { question, answer, cancelled },
  };
}
