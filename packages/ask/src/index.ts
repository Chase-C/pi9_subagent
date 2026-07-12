import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { createAskComponent } from "./component.js";
import { rewriteAskContext } from "./context.js";
import { buildAnsweredResponse, buildCancelledResponse, buildUiUnavailableResponse } from "./response.js";
import { askWithRpc } from "./rpc.js";
import { AskParamsSchema } from "./schema.js";
import type { AskAnswer, AskParams, AskToolDetails } from "./types.js";
import { validateAskParams } from "./validation.js";

export default function askExtension(pi: ExtensionAPI) {
  pi.on("context", (event) => ({ messages: rewriteIntegratedContext(event.messages) }));

  pi.registerTool<typeof AskParamsSchema, AskToolDetails>({
    name: "ask",
    label: "Ask",
    description: "Ask one focused question with optional choices, comments, multiple selection, and freeform input.",
    promptSnippet: "Ask the user a focused question when a decision is required",
    promptGuidelines: [
      "Use ask only when user input is required; ask one focused question per call.",
      "Offer concise, distinct options and enable freeform when choices may be incomplete.",
    ],
    parameters: AskParamsSchema,
    executionMode: "sequential",

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = validateAskParams(rawParams as AskParams);
      if (!ctx.hasUI) return buildUiUnavailableResponse(params.question);

      let answer: AskAnswer | null | undefined;
      if (ctx.mode === "tui") {
        let abortListener: (() => void) | undefined;
        try {
          answer = await ctx.ui.custom<AskAnswer | null>((tui, theme, _keybindings, done) => {
            const component = createAskComponent({
              tui,
              theme,
              ...params,
              onSubmit: done,
              onCancel: () => done(null),
            });
            const abort = () => component.cancel();
            if (signal?.aborted) abort();
            else if (signal) {
              abortListener = abort;
              signal.addEventListener("abort", abort, { once: true });
            }
            return component;
          }, {
            overlay: true,
            overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "100%" },
          });
        } finally {
          if (abortListener) signal?.removeEventListener("abort", abortListener);
        }
      }

      if (answer === undefined) answer = await askWithRpc(ctx.ui, params, signal);
      if (answer === null) {
        const result = buildCancelledResponse(params.question);
        pi.events.emit("ask:cancelled", result.details);
        return result;
      }

      const result = buildAnsweredResponse(params.question, answer);
      pi.events.emit("ask:answered", result.details);
      return result;
    },

    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", `Ask: ${args.question}`), 0, 0);
    },
    renderResult(result, _options, theme) {
      const text = result.content.find((item) => item.type === "text")?.text ?? "Ask completed.";
      return new Text(theme.fg(result.details?.status === "cancelled" ? "muted" : "text", text), 0, 0);
    },
  });
}

/** Adapt canonical tool details for the pruning module, then retain canonical details in the returned context. */
function rewriteIntegratedContext<T>(messages: readonly T[]): T[] {
  const compatible = structuredClone(messages) as any[];
  for (const message of compatible) {
    const details = message?.details as AskToolDetails | undefined;
    if (message?.toolName === "ask" && details?.status === "answered") {
      message.details = { cancelled: false, ...details.answer };
    }
  }
  const rewritten = rewriteAskContext(compatible);
  for (let index = 0; index < rewritten.length; index += 1) {
    const original = messages[index] as any;
    if (original?.toolName === "ask" && original.details !== undefined) (rewritten[index] as any).details = structuredClone(original.details);
  }
  return rewritten;
}
