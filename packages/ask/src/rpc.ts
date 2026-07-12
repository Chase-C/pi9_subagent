import type { AskAnswer, AskOption, AskParams } from "./types.js";

/**
 * The part of the extension UI used by the RPC fallback.
 *
 * Keeping this interface small makes the fallback usable by RPC clients and by
 * tests without pulling in the full extension context type.
 */
export interface AskDialogUI {
  select(title: string, options: string[], dialogOptions?: { signal?: AbortSignal }): Promise<string | undefined>;
  input(title: string, placeholder?: string, dialogOptions?: { signal?: AbortSignal }): Promise<string | undefined>;
}

type RpcAskParams = AskParams & {
  /** Supported by the normalized params used by the questionnaire flow. */
  allowComments?: boolean;
  /** Kept as an alias for callers that use the public wording. */
  multiSelect?: boolean;
};

type AskSelection = AskAnswer["selections"][number];

const FREEFORM_CHOICE = "Type a response…";

/**
 * Run an ask prompt using only the select and input dialogs available over
 * RPC.  The canonical argument order is `(ui, params)`; the reverse order is
 * accepted as well so callers can pass the params first like a tool handler.
 */
export function askWithRpc(ui: AskDialogUI, params: RpcAskParams, signal?: AbortSignal): Promise<AskAnswer | null>;
export function askWithRpc(params: RpcAskParams, ui: AskDialogUI, signal?: AbortSignal): Promise<AskAnswer | null>;
export async function askWithRpc(
  first: AskDialogUI | RpcAskParams,
  second: RpcAskParams | AskDialogUI,
  signal?: AbortSignal,
): Promise<AskAnswer | null> {
  const [ui, params] = isDialogUI(first)
    ? [first, second as RpcAskParams]
    : [second as AskDialogUI, first as RpcAskParams];

  const options = params.options ? [...params.options] : [];
  const allowFreeform = params.allowFreeform !== false;
  const multiSelect = params.allowMultiple === true || params.multiSelect === true;
  // Comments are optional at each step, but the sequence itself is enabled
  // by default because normalized ask params do not need another flag for it.
  const allowComments = params.allowComments !== false;
  const prompt = params.context ? `${params.context}\n\n${params.question}` : params.question;

  if (options.length === 0 && !allowFreeform) {
    throw new Error("The ask dialog needs at least one option when freeform responses are disabled.");
  }

  if (signal?.aborted) return null;
  if (multiSelect) {
    return runMultiSelect(ui, prompt, options, allowFreeform, allowComments, signal);
  }

  return runSingleSelect(ui, prompt, options, allowFreeform, allowComments, signal);
}

/** Alias useful to callers that describe this as a fallback rather than an RPC ask. */
export const runRpcFallback = askWithRpc;
export const runAskDialog = askWithRpc;
export const askViaRpc = askWithRpc;
export default askWithRpc;

async function runSingleSelect(
  ui: AskDialogUI,
  prompt: string,
  options: AskOption[],
  allowFreeform: boolean,
  allowComments: boolean,
  signal?: AbortSignal,
): Promise<AskAnswer | null> {
  const choices = options.map((option, index) => `${index + 1}. ${formatOption(option)}`);
  if (allowFreeform) choices.push(`${options.length + 1}. ${FREEFORM_CHOICE}`);

  const selected = await selectDialog(ui, prompt, choices, signal);
  if (selected == null || signal?.aborted) return null;

  const selectedIndex = choices.indexOf(selected);
  if (selectedIndex === -1) return null;

  if (selectedIndex === options.length) {
    const freeform = await inputDialog(ui, prompt, signal);
    if (freeform == null || signal?.aborted) return null;
    return makeAnswer([], freeform);
  }

  const selectedOption = options[selectedIndex];
  if (!selectedOption) return null;

  const selections = await collectComments(ui, prompt, [selectedOption], allowComments, signal);
  if (selections === null) return null;
  return makeAnswer(selections);
}

async function runMultiSelect(
  ui: AskDialogUI,
  prompt: string,
  options: AskOption[],
  allowFreeform: boolean,
  allowComments: boolean,
  signal?: AbortSignal,
): Promise<AskAnswer | null> {
  // A multi-select with no options is just the freeform branch.  This also
  // avoids presenting an input containing an empty numbered list.
  if (options.length === 0) {
    const freeform = await inputDialog(ui, prompt, signal);
    if (freeform == null || signal?.aborted) return null;
    return makeAnswer([], freeform);
  }

  const numberedOptions = options
    .map((option, index) => `${index + 1}. ${formatOption(option)}`)
    .join("\n");
  const selectionPrompt = `${prompt}\n\n${numberedOptions}\n\nEnter option numbers separated by commas:`;
  const rawSelection = await inputDialog(ui, selectionPrompt, signal);
  if (rawSelection == null || signal?.aborted) return null;

  const selectedOptions = parseSelections(rawSelection, options);

  // Freeform is deliberately a separate dialog.  That lets a response such
  // as "1, 3" remain unambiguous while still allowing a freeform response in
  // addition to any selected options.
  let freeform: string | undefined;
  if (allowFreeform) {
    freeform = await inputDialog(ui, `${prompt}\n\nAdditional response (optional):`, signal);
    if (freeform == null || signal?.aborted) return null;
  }

  const selections = await collectComments(ui, prompt, selectedOptions, allowComments, signal);
  if (selections === null) return null;
  return makeAnswer(selections, freeform);
}

function parseSelections(raw: string, options: AskOption[]): AskOption[] {
  const indices = new Set<number>();

  for (const token of raw.split(",")) {
    const value = token.trim();
    if (!/^\d+$/.test(value)) continue;

    const index = Number(value) - 1;
    if (Number.isSafeInteger(index) && index >= 0 && index < options.length) {
      indices.add(index);
    }
  }

  // Iterating the source options, rather than the user's token order, gives
  // comment prompts a stable order and makes duplicate numbers harmless.
  return options.filter((_option, index) => indices.has(index));
}

async function collectComments(
  ui: AskDialogUI,
  prompt: string,
  options: AskOption[],
  allowComments: boolean,
  signal?: AbortSignal,
): Promise<AskSelection[] | null> {
  const selections: AskSelection[] = options.map(toSelection);
  if (!allowComments) return selections;

  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    const selection = selections[index];
    if (!option || !selection) continue;

    if (signal?.aborted) return null;
    const comment = await inputDialog(ui, `${prompt}\n\nComment for \"${option.label}\" (optional):`, signal);
    if (comment == null || signal?.aborted) return null;

    // An empty comment is the explicit, non-cancelling way to skip this
    // optional step.  Undefined remains cancellation for every dialog.
    if (comment.trim().length > 0) selection.comment = comment;
  }

  return selections;
}

function toSelection(option: AskOption): AskSelection {
  const selection: AskSelection = { label: option.label };
  if (option.description !== undefined) selection.description = option.description;
  return selection;
}

function makeAnswer(selections: AskSelection[], freeform?: string): AskAnswer {
  const answer: AskAnswer = { selections };
  if (freeform !== undefined) answer.freeform = freeform;
  return answer;
}

function formatOption(option: AskOption): string {
  return option.description ? `${option.label} — ${option.description}` : option.label;
}

function isDialogUI(value: AskDialogUI | RpcAskParams): value is AskDialogUI {
  return typeof (value as AskDialogUI).select === "function" && typeof (value as AskDialogUI).input === "function";
}

function selectDialog(ui: AskDialogUI, title: string, options: string[], signal?: AbortSignal) {
  return signal ? ui.select(title, options, { signal }) : ui.select(title, options);
}

function inputDialog(ui: AskDialogUI, title: string, signal?: AbortSignal) {
  return signal ? ui.input(title, undefined, { signal }) : ui.input(title);
}
