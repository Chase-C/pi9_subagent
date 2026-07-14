import { Type } from "typebox";

import { MAX_TIMEOUT_MS } from "./config.js";

export const AskOptionSchema = Type.Object({
  label: Type.String({ minLength: 1, description: "Short option title." }),
  description: Type.Optional(Type.String({ description: "Optional explanation of this option." })),
  preview: Type.Optional(Type.String({ description: "Optional presentation-only preview content." })),
}, { additionalProperties: false });

export const AskParamsSchema = Type.Object({
  question: Type.String({ minLength: 1, description: "One focused question to ask the user." }),
  context: Type.Optional(Type.String({ description: "Brief context shown before the question." })),
  options: Type.Array(AskOptionSchema, { description: "Suggested answers." }),
  allowMultiple: Type.Optional(Type.Boolean({ default: false, description: "Allow selecting multiple options. Defaults to false." })),
  allowFreeform: Type.Optional(Type.Boolean({ default: true, description: "Allow a typed response. Defaults to true." })),
  timeout: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_TIMEOUT_MS, description: "Timeout in milliseconds. Zero disables the timeout." })),
}, { additionalProperties: false });
