import {
  CURSOR_MARKER,
  Editor,
  getKeybindings,
  Key,
  matchesKey,
  parseKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type EditorTheme,
  type Focusable,
  type Keybinding,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import {
  createQuestionnaireState,
  transitionQuestionnaire,
  type QuestionnaireState,
} from "./state.js";
import { CHECKED_BOX, EMPTY_BOX } from "./glyphs.js";
import {
  combinePreviewPanes,
  getPreviewPaneLayout,
  renderPreviewMarkdown,
} from "./preview.js";
import { fitViewport, type FocusRange } from "./viewport.js";
import type { AskAnswer, ValidatedAskParams } from "./types.js";

type AskComponentOptions = ValidatedAskParams & {
  tui: TUI;
  theme: Theme;
  keybindings?: KeybindingsManager;
  onSubmit?: (answer: AskAnswer) => void;
  onCancel?: () => void;
};

export class AskComponent implements Component, Focusable {
  private readonly editor: Editor;
  private readonly keybindings: KeybindingsManager;
  private readonly previewHeightByWidth = new Map<number, number>();
  private questionnaireState: QuestionnaireState;
  private cancelled = false;
  private _focused = false;

  constructor(private readonly config: AskComponentOptions) {
    this.keybindings = config.keybindings && typeof config.keybindings.matches === "function"
      ? config.keybindings
      : getKeybindings();
    this.questionnaireState = createQuestionnaireState({
      options: config.options,
      allowMultiple: config.allowMultiple,
      allowFreeform: config.allowFreeform,
    });

    this.editor = new Editor(config.tui, editorTheme(config.theme));
    this.editor.onChange = (value) => {
      if (this.questionnaireState.mode === "select") return;
      this.applyState(transitionQuestionnaire(this.questionnaireState, { type: "edit", value }));
    };
    this.editor.onSubmit = (value) => {
      if (this.questionnaireState.mode === "select") return;
      const next = transitionQuestionnaire(
        transitionQuestionnaire(this.questionnaireState, { type: "edit", value }),
        { type: "saveEditor" },
      );
      this.applyState(next);
      this.finishIfAnswered(next);
      this.requestRender();
    };
  }

  /** Current questionnaire state, useful to UI integrators. */
  get state(): QuestionnaireState {
    return this.questionnaireState;
  }

  /** The answer after a successful submit, or null while the prompt is open. */
  get answer(): AskAnswer | null {
    return this.questionnaireState.answer;
  }

  /** Whether the component was cancelled. */
  get isCancelled(): boolean {
    return this.cancelled;
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value && this.questionnaireState.mode !== "select";
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  handleInput(data: string): void {
    if (this.questionnaireState.answer || this.cancelled) return;

    if (this.questionnaireState.mode !== "select") {
      // Escape is intentionally an editor operation: it discards the draft,
      // while Ctrl+C remains the conventional way to cancel the whole ask.
      if (matchesKey(data, Key.escape)) {
        this.applyState(transitionQuestionnaire(this.questionnaireState, { type: "cancelEditor" }));
        this.requestRender();
      }
      else if (matchesKey(data, Key.ctrl("c"))) {
        this.cancel();
      }
      else {
        this.editor.handleInput(data);
        this.requestRender();
      }
    }
    // Configured Pi bindings take precedence over fixed shortcuts. The order
    // here also defines precedence if a user assigns one key to two Pi actions.
    else if (this.matchesSelect(data, "tui.select.cancel")) {
      this.cancel();
    }
    else if (this.matchesSelect(data, "tui.select.up")) {
      this.move(-1);
    }
    else if (this.matchesSelect(data, "tui.select.down")) {
      this.move(1);
    }
    else if (this.matchesSelect(data, "tui.select.pageUp")) {
      this.move(-5);
    }
    else if (this.matchesSelect(data, "tui.select.pageDown")) {
      this.move(5);
    }
    else if (this.matchesSelect(data, "tui.select.confirm")) {
      this.confirm();
    }
    else if (matchesKey(data, Key.ctrl("c"))) {
      this.cancel();
    }
    else if (matchesKey(data, Key.home)) {
      this.move(-this.questionnaireState.highlightedRow);
    }
    else if (matchesKey(data, Key.end)) {
      const rowCount = this.rowCount();
      this.move(rowCount - 1 - this.questionnaireState.highlightedRow);
    }
    else if (isLiteral(data, "c")) {
      this.applyState(transitionQuestionnaire(this.questionnaireState, { type: "openComment" }));
    }
    else if (matchesKey(data, Key.space)) {
      if (this.isSubmitRow()) {
        this.submit();
      } else if (this.isFreeformRow() && this.questionnaireState.config.allowMultiple) {
        this.applyState(transitionQuestionnaire(this.questionnaireState, { type: "toggleFreeform" }));
        this.requestRender();
      } else {
        this.toggle();
      }
    }
    else if (isLiteral(data, "k")) {
      this.move(-1);
    }
    else if (isLiteral(data, "j")) {
      this.move(1);
    }
  }

  render(width: number): string[] {
    const renderWidth = safeWidth(width);
    const lines: string[] = [];
    const add = (line: string) => lines.push(fit(line, renderWidth));
    const addPrefixed = (prefix: string, text: string, color?: "text" | "muted" | "dim" | "accent") => {
      const styled = color ? this.config.theme.fg(color, text) : text;
      addWrappedWithPrefix(lines, prefix, styled, renderWidth);
    };

    add(this.config.theme.fg("border", "─".repeat(renderWidth)));

    if (this.config.context) {
      addPrefixed(" ", this.config.context, "muted");
      add("");
    }
    addPrefixed(" ", this.config.theme.bold(this.config.question), "text");
    add("");

    let focus: FocusRange | undefined;
    let footerStart: number;
    let projectWidePreview: ((visibleLines: readonly string[]) => string[]) | undefined;
    const addFooter = (prefix: string, text: string) => {
      // Keep the footer to one physical row. It is fixed chrome, so wrapping
      // it could consume the entire viewport on a narrow terminal.
      add(fit(`${prefix}${text}`, renderWidth));
    };
    if (this.questionnaireState.mode === "select") {
      const preview = this.highlightedPreview();
      const hasPreviews = this.questionnaireState.config.options.some(option => option.preview?.trim());
      const paneLayout = hasPreviews ? getPreviewPaneLayout(renderWidth) : undefined;
      if (paneLayout) {
        const optionLines: string[] = [];
        const optionFocus = this.renderOptions(optionLines, paneLayout.leftWidth);
        const submitFocus = this.renderSubmit(optionLines, paneLayout.leftWidth);
        const sectionStart = lines.length;
        const previewLines = this.renderPreview(preview, paneLayout.rightWidth);
        const separator = this.config.theme.fg("dim", "│");
        projectWidePreview = visibleLines => overlayPreviewPane(
          visibleLines,
          previewLines,
          paneLayout.leftWidth,
          paneLayout.rightWidth,
          separator,
        );
        lines.push(...combinePreviewPanes(
          optionLines,
          previewLines,
          paneLayout,
          separator,
        ));
        const sectionFocus = submitFocus ?? optionFocus;
        if (sectionFocus) {
          focus = {
            start: sectionStart + sectionFocus.start,
            end: sectionStart + sectionFocus.end,
          };
        }
      } else {
        const optionFocus = this.renderOptions(lines, renderWidth);
        focus = optionFocus;
        if (hasPreviews) {
          const previewStart = lines.length;
          const previewLines = this.renderPreview(preview, renderWidth);
          lines.push(...previewLines);
          if (preview && optionFocus) {
            const firstContentRow = previewLines.findIndex(line => line.trim().length > 0);
            if (firstContentRow >= 0) {
              focus = {
                start: optionFocus.start,
                end: previewStart + firstContentRow + 1,
              };
            }
          }
        }
        const submitFocus = this.renderSubmit(lines, renderWidth);
        focus = submitFocus ?? focus;
      }
      add("");
      footerStart = lines.length;
      addFooter(" ", this.config.theme.fg("dim", this.helpText()));
    } else {
      // Keep the options visible while editing so the comment remains tied to
      // the option it belongs to, and so freeform editing does not feel like a
      // separate prompt.
      this.renderOptions(lines, renderWidth);
      const inputPrefix = `    ${this.config.theme.fg("accent", "↳")} `;
      const continuationPrefix = " ".repeat(visibleWidth(inputPrefix));
      const inputWidth = Math.max(1, renderWidth - visibleWidth(inputPrefix));
      const editorLines = this.editor.render(inputWidth).filter(line => visibleWidth(line) > 0);
      const editorStart = lines.length;
      for (const [index, line] of editorLines.entries()) {
        add(`${index === 0 ? inputPrefix : continuationPrefix}${line}`);
      }
      const editorEnd = lines.length;
      if (editorEnd > editorStart) {
        const cursorLine = editorLines.findIndex(line => line.includes(CURSOR_MARKER));
        const focusedRow = cursorLine >= 0 ? editorStart + cursorLine : editorEnd - 1;
        focus = { start: focusedRow, end: focusedRow + 1 };
      }

      // The help line is the footer. Keep it adjacent to the bottom border so
      // fitViewport can keep both rows fixed while the editor is focused.
      this.renderSubmit(lines, renderWidth);
      footerStart = lines.length;
      addFooter(continuationPrefix, this.config.theme.fg("dim", this.editorHelpText()));
    }

    add(this.config.theme.fg("border", "─".repeat(renderWidth)));
    const maxRows = Number.isFinite(this.config.tui.terminal.rows)
      ? this.config.tui.terminal.rows
      : lines.length;
    const viewport = fitViewport(lines, focus, maxRows, 1, lines.length - footerStart);
    // fitViewport prefixes overflow rows with an indicator. Preserve a
    // cursor-bearing editor row over that indicator when projecting narrow
    // viewports, so fitting cannot clip the cursor or the current input.
    const visibleLines = projectWidePreview ? projectWidePreview(viewport.lines) : viewport.lines;
    return visibleLines.map(line => fitCursorLine(line, renderWidth));
  }

  /** Submit the current multi-select answer programmatically. */
  submit(): void {
    if (this.questionnaireState.answer || this.cancelled) return;
    const next = transitionQuestionnaire(this.questionnaireState, { type: "submit" });
    this.applyState(next);
    this.finishIfAnswered(next);
    this.requestRender();
  }

  /** Cancel the ask, invoking onCancel at most once. */
  cancel(): void {
    if (this.questionnaireState.answer || this.cancelled) return;
    this.cancelled = true;
    this.editor.focused = false;
    this.config.onCancel?.();
  }

  private renderOptions(lines: string[], width: number): FocusRange | undefined {
    const addPrefixed = (prefix: string, text: string, color?: "text" | "muted" | "dim" | "accent") => {
      const styled = color ? this.config.theme.fg(color, text) : text;
      addWrappedWithPrefix(lines, prefix, styled, width);
    };

    let focus: FocusRange | undefined;
    const options = this.questionnaireState.config.options;
    for (let index = 0; index < options.length; index += 1) {
      const source = options[index];
      const selected = this.questionnaireState.highlightedRow === index;
      const start = lines.length;
      const checked = this.questionnaireState.checked.has(source.label);
      const marker = selected ? this.config.theme.fg("accent", "› ") : "  ";
      const check = this.questionnaireState.config.allowMultiple
        ? `${this.config.theme.fg(checked ? "success" : "muted", checked ? CHECKED_BOX : EMPTY_BOX)} `
        : "";
      const comment = this.questionnaireState.comments.has(source.label)
        ? this.config.theme.fg("warning", " ✎")
        : "";
      const label = `${marker}${check}${source.label}${comment}`;
      addPrefixed("", label, selected ? "accent" : "text");

      if (source.description) {
        addPrefixed("     ", source.description, "muted");
      }
      if (selected) {
        const commentText = this.questionnaireState.comments.get(source.label);
        if (commentText) addPrefixed("     ", `✎ ${commentText}`, "dim");
        focus = { start, end: lines.length };
      }
    }

    if (this.questionnaireState.config.allowFreeform) {
      const row = options.length;
      const selected = this.questionnaireState.highlightedRow === row;
      const start = lines.length;
      const marker = selected ? this.config.theme.fg("accent", "› ") : "  ";
      const checked = this.questionnaireState.freeformChecked;
      const check = this.questionnaireState.config.allowMultiple
        ? `${this.config.theme.fg(checked ? "success" : "muted", checked ? CHECKED_BOX : EMPTY_BOX)} `
        : "";
      const draft = this.questionnaireState.freeformDraft;
      const suffix = draft ? ` — ${draft}` : "";
      addPrefixed("", `${marker}${check}${this.config.theme.fg(selected ? "accent" : "text", `Type a response…${suffix}`)}`);
      if (selected) focus = { start, end: lines.length };
    }
    return focus;
  }

  private renderSubmit(lines: string[], width: number): FocusRange | undefined {
    if (!this.questionnaireState.config.allowMultiple) return undefined;
    const selected = this.isSubmitRow();
    const marker = selected ? this.config.theme.fg("accent", "› ") : "  ";
    lines.push("");
    const start = lines.length;
    addWrappedWithPrefix(
      lines,
      "",
      `${marker}${this.config.theme.fg(selected ? "accent" : "text", "[ Submit ]")}`,
      width,
    );
    return selected ? { start, end: lines.length } : undefined;
  }

  private helpText(): string {
    const navigate = `${this.keyText("tui.select.up", "↑")}/${this.keyText("tui.select.down", "↓")}/jk navigate`;
    const pages = `${this.keyText("tui.select.pageUp", "PgUp")}/${this.keyText("tui.select.pageDown", "PgDn")} page`;
    const confirm = this.keyText("tui.select.confirm", "Enter");
    const cancel = this.keyText("tui.select.cancel", "Esc");
    const comment = this.matchesAnySelect("c") ? "" : "c comment · ";
    const space = this.matchesAnySelect(" ") ? "" : "/Space";
    if (this.questionnaireState.config.allowMultiple) {
      return `${comment}${navigate} · ${cancel} cancel · ${pages} · ${confirm}${space} toggle · ${confirm} edit response`;
    }
    return `${comment}${navigate} · ${cancel} cancel · ${pages} · ${confirm}${space} select`;
  }

  private matchesAnySelect(data: string): boolean {
    return SELECT_KEYBINDINGS.some(keybinding => this.matchesSelect(data, keybinding));
  }

  private matchesSelect(data: string, keybinding: Keybinding): boolean {
    return this.keybindings.matches(data, keybinding);
  }

  private keyText(keybinding: Keybinding, fallback: string): string {
    const keys = typeof this.keybindings.getKeys === "function"
      ? this.keybindings.getKeys(keybinding)
      : [];
    return keys.length > 0 ? keys.map(formatKey).join("/") : fallback;
  }

  private editorHelpText(): string {
    const submit = this.keyText("tui.input.submit", "Enter");
    return this.questionnaireState.mode === "comment"
      ? `${submit} save comment · Esc discard`
      : `${submit} save response · Esc discard`;
  }

  private highlightedPreview(): string | undefined {
    if (this.questionnaireState.mode !== "select") return undefined;
    const option = this.questionnaireState.config.options[this.questionnaireState.highlightedRow];
    return option?.preview?.trim() ? option.preview : undefined;
  }

  private renderPreview(preview: string | undefined, width: number): string[] {
    const lines = preview ? renderPreviewMarkdown(preview, width) : [];
    let height = this.previewHeightByWidth.get(width);
    if (height === undefined) {
      height = this.questionnaireState.config.options.reduce((max, option) => {
        if (!option.preview?.trim()) return max;
        return Math.max(max, renderPreviewMarkdown(option.preview, width).length);
      }, 0);
      this.previewHeightByWidth.set(width, height);
    }
    return [...lines, ...Array.from({ length: height - lines.length }, () => "")];
  }

  private isFreeformRow(): boolean {
    return this.questionnaireState.config.allowFreeform
      && this.questionnaireState.highlightedRow === this.questionnaireState.config.options.length;
  }

  private isSubmitRow(): boolean {
    return this.questionnaireState.config.allowMultiple
      && this.questionnaireState.highlightedRow === this.rowCount() - 1;
  }

  private rowCount(): number {
    return this.questionnaireState.config.options.length
      + (this.questionnaireState.config.allowFreeform ? 1 : 0)
      + (this.questionnaireState.config.allowMultiple ? 1 : 0);
  }

  private move(delta: number): void {
    this.applyState(transitionQuestionnaire(this.questionnaireState, { type: "move", delta }));
    this.requestRender();
  }

  private confirm(): void {
    if (this.isSubmitRow()) {
      this.submit();
    } else if (this.isFreeformRow()) {
      this.openFreeform();
    } else {
      this.toggle();
    }
  }

  private toggle(): void {
    const next = transitionQuestionnaire(this.questionnaireState, { type: "toggle" });
    this.applyState(next);
    this.finishIfAnswered(next);
    this.requestRender();
  }

  private openFreeform(): void {
    if (!this.isFreeformRow()) return;
    const next = transitionQuestionnaire(this.questionnaireState, { type: "openFreeform" });
    this.applyState(next);
    this.editor.focused = this._focused;
    this.requestRender();
  }

  private applyState(next: QuestionnaireState): void {
    const previousMode = this.questionnaireState.mode;
    const modeChanged = next.mode !== previousMode;
    this.questionnaireState = next;
    if (modeChanged) {
      this.editor.focused = this._focused && next.mode !== "select";
      if (previousMode === "select" && next.mode !== "select") {
        this.editor.setText(next.editorDraft);
      }
    }
  }

  private finishIfAnswered(state: QuestionnaireState): void {
    if (!state.answer) return;
    this.editor.focused = false;
    this.config.onSubmit?.(state.answer);
  }

  private requestRender(): void {
    this.config.tui.requestRender();
  }
}

const SELECT_KEYBINDINGS: readonly Keybinding[] = [
  "tui.select.cancel",
  "tui.select.up",
  "tui.select.down",
  "tui.select.pageUp",
  "tui.select.pageDown",
  "tui.select.confirm",
];

function editorTheme(theme: Theme): EditorTheme {
  return {
    borderColor: () => "",
    selectList: {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    },
  };
}

function isLiteral(data: string, expected: string): boolean {
  return data === expected || parseKey(data) === expected;
}

function formatKey(key: string): string {
  const aliases: Record<string, string> = {
    up: "↑",
    down: "↓",
    pageUp: "PgUp",
    pageDown: "PgDn",
    escape: "Esc",
    enter: "Enter",
    space: "Space",
    home: "Home",
    end: "End",
  };
  return key.split("+").map(part => aliases[part] ?? part).join("+");
}

function overlayPreviewPane(
  lines: readonly string[],
  previewLines: readonly string[],
  leftWidth: number,
  rightWidth: number,
  separator: string,
): string[] {
  let previewRow = 0;
  return lines.map((line) => {
    if (!line.includes("│")) return line;
    const left = padToWidth(truncateToWidth(line, leftWidth, ""), leftWidth);
    const right = padToWidth(previewLines[previewRow] ?? "", rightWidth);
    previewRow += 1;
    return `${left}${separator}${right}`;
  });
}

function padToWidth(line: string, width: number): string {
  return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}

function safeWidth(width: number): number {
  return Math.max(1, Number.isFinite(width) ? Math.floor(width) : 1);
}

function fitCursorLine(line: string, width: number): string {
  if (visibleWidth(line) > width && line.includes(CURSOR_MARKER)) {
    const withoutOverflowMarker = line.replace(/^(?:↑ |↓ |↕ )/, "");
    if (withoutOverflowMarker !== line) return fit(withoutOverflowMarker, width);
  }
  return fit(line, width);
}

function fit(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
}

function addWrappedWithPrefix(lines: string[], prefix: string, text: string, width: number): void {
  const prefixWidth = visibleWidth(prefix);
  if (prefixWidth >= width) {
    for (const line of wrapTextWithAnsi(`${prefix}${text}`, width)) {
      lines.push(fit(line, width));
    }
    return;
  }

  const available = Math.max(1, width - prefixWidth);
  const wrapped = wrapTextWithAnsi(text, available);
  const continuation = " ".repeat(prefixWidth);
  for (let index = 0; index < wrapped.length; index += 1) {
    lines.push(fit(`${index === 0 ? prefix : continuation}${wrapped[index]}`, width));
  }
}
