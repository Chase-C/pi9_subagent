export interface FocusRange {
  /** Inclusive absolute row index in the full logical line list. */
  start: number;
  /** Exclusive absolute row index in the full logical line list. */
  end: number;
}

export interface ViewportResult {
  lines: string[];
  hiddenAbove: boolean;
  hiddenBelow: boolean;
}

/**
 * Fit logical lines into a terminal-height viewport.
 *
 * Fixed rows are taken from the beginning and end of `lines`. The rows between
 * them form the scrollable region. Overflow markers prefix boundary rows in
 * that region, so they never consume an additional terminal row.
 *
 * If the viewport is smaller than the fixed chrome, the first top row wins a
 * one-row viewport. With two or more rows, at least one row from each fixed
 * edge is retained, then remaining space is assigned to the top edge first.
 */
export function fitViewport(
  lines: readonly string[],
  focus: FocusRange | undefined,
  maxRows: number,
  fixedTopRows: number,
  fixedBottomRows: number,
): ViewportResult {
  const limit = rowLimit(maxRows, lines.length);
  if (limit === 0 || lines.length === 0) {
    return { lines: [], hiddenAbove: false, hiddenBelow: lines.length > 0 };
  }

  if (lines.length <= limit) {
    return { lines: [...lines], hiddenAbove: false, hiddenBelow: false };
  }

  const topSize = fixedSize(fixedTopRows, lines.length);
  const bottomSize = fixedSize(fixedBottomRows, lines.length - topSize);
  const middleStart = topSize;
  const middleEnd = lines.length - bottomSize;
  const chromeSize = topSize + bottomSize;

  if (limit < chromeSize) {
    const { topVisible, bottomVisible } = degradedChrome(limit, topSize, bottomSize);
    return {
      lines: [
        ...lines.slice(0, topVisible),
        ...lines.slice(lines.length - bottomVisible),
      ],
      hiddenAbove: false,
      hiddenBelow: middleEnd > middleStart,
    };
  }

  const middleCapacity = limit - chromeSize;
  const middleSize = middleEnd - middleStart;
  const visibleCount = Math.min(middleCapacity, middleSize);
  const windowStart = chooseWindowStart(
    focus,
    lines.length,
    middleStart,
    middleEnd,
    visibleCount,
  );
  const hiddenAbove = windowStart > middleStart;
  const hiddenBelow = windowStart + visibleCount < middleEnd;
  const middle = lines.slice(windowStart, windowStart + visibleCount);

  markOverflow(middle, hiddenAbove, hiddenBelow);

  return {
    lines: [
      ...lines.slice(0, topSize),
      ...middle,
      ...lines.slice(middleEnd),
    ],
    hiddenAbove,
    hiddenBelow,
  };
}

function rowLimit(value: number, contentLength: number): number {
  if (Number.isNaN(value) || value <= 0) return 0;
  if (!Number.isFinite(value)) return contentLength;
  return Math.floor(value);
}

function fixedSize(value: number, available: number): number {
  if (Number.isNaN(value) || value <= 0) return 0;
  if (!Number.isFinite(value)) return available;
  return Math.min(Math.floor(value), available);
}

function degradedChrome(
  limit: number,
  topSize: number,
  bottomSize: number,
): { topVisible: number; bottomVisible: number } {
  if (topSize === 0) return { topVisible: 0, bottomVisible: Math.min(limit, bottomSize) };
  if (bottomSize === 0 || limit === 1) {
    return { topVisible: Math.min(limit, topSize), bottomVisible: 0 };
  }

  const topVisible = Math.min(topSize, limit - 1);
  const bottomVisible = Math.min(bottomSize, limit - topVisible);
  return { topVisible, bottomVisible };
}

function chooseWindowStart(
  focus: FocusRange | undefined,
  lineCount: number,
  middleStart: number,
  middleEnd: number,
  visibleCount: number,
): number {
  const latestStart = middleEnd - visibleCount;
  const range = normalizeFocus(focus, lineCount);
  if (!range) return middleStart;

  if (range.end <= middleStart) return middleStart;
  if (range.start >= middleEnd) return latestStart;

  const focusStart = Math.max(range.start, middleStart);
  const focusEnd = Math.min(range.end, middleEnd);
  const focusSize = focusEnd - focusStart;
  if (focusSize <= 0) return middleStart;
  if (focusSize >= visibleCount) return Math.min(focusStart, latestStart);

  const contextBefore = Math.floor((visibleCount - focusSize) / 2);
  return Math.max(middleStart, Math.min(focusStart - contextBefore, latestStart));
}

function normalizeFocus(focus: FocusRange | undefined, lineCount: number): FocusRange | undefined {
  if (!focus || !Number.isFinite(focus.start) || !Number.isFinite(focus.end)) return undefined;
  const start = Math.max(0, Math.min(Math.floor(focus.start), lineCount));
  const end = Math.max(0, Math.min(Math.floor(focus.end), lineCount));
  if (end <= start) return undefined;
  return { start, end };
}

function markOverflow(middle: string[], hiddenAbove: boolean, hiddenBelow: boolean): void {
  if (middle.length === 0) return;
  if (middle.length === 1 && hiddenAbove && hiddenBelow) {
    middle[0] = `↕ ${middle[0]}`;
    return;
  }
  if (hiddenAbove) middle[0] = `↑ ${middle[0]}`;
  if (hiddenBelow) middle[middle.length - 1] = `↓ ${middle[middle.length - 1]}`;
}
