/**
 * Reordering tasks inside a note. A task moves as a block — its own line plus
 * every more-indented line directly beneath it — so subtasks and notes attached
 * to it travel along. Lines that are not part of either block stay put.
 */

const INDENT = /^\s*/;

function indentOf(line: string): string {
  return line.match(INDENT)?.[0] ?? "";
}

/** `[start, end)` of the block headed by the line at `start`. */
export function blockRange(lines: string[], start: number): [number, number] {
  const depth = indentOf(lines[start] ?? "").length;
  let end = start + 1;

  while (
    end < lines.length &&
    lines[end].trim() !== "" &&
    indentOf(lines[end]).length > depth
  ) {
    end++;
  }

  return [start, end];
}

/**
 * Moves the block at `from` next to the block at `anchor`, taking on the
 * anchor's indentation so the task lands at its new neighbour's level.
 * Returns the lines unchanged when the move is a no-op or would put a block
 * inside itself.
 */
export function moveBlock(
  lines: string[],
  from: number,
  anchor: number,
  place: "before" | "after",
): string[] {
  const [srcStart, srcEnd] = blockRange(lines, from);
  if (anchor >= srcStart && anchor < srcEnd) return lines;

  const [, anchorEnd] = blockRange(lines, anchor);
  let insertAt = place === "before" ? anchor : anchorEnd;

  const sourceIndent = indentOf(lines[from]);
  const targetIndent = indentOf(lines[anchor]);
  const block = lines
    .slice(srcStart, srcEnd)
    .map((line) =>
      line.startsWith(sourceIndent)
        ? targetIndent + line.slice(sourceIndent.length)
        : line,
    );

  const rest = [...lines.slice(0, srcStart), ...lines.slice(srcEnd)];
  if (insertAt > srcStart) insertAt -= srcEnd - srcStart;

  return [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)];
}

/**
 * Translates a drop in the zen list into a file edit. `taskLines` are the line
 * numbers of the listed tasks in list order; the dragged task ends up at
 * `toIndex`. It is placed before whichever task will follow it, or after the
 * one that will precede it when it becomes last.
 */
export function moveInList(
  lines: string[],
  taskLines: number[],
  fromIndex: number,
  toIndex: number,
): string[] {
  if (fromIndex === toIndex) return lines;

  const order = taskLines.filter((_, index) => index !== fromIndex);
  const from = taskLines[fromIndex];

  if (toIndex < order.length) {
    return moveBlock(lines, from, order[toIndex], "before");
  }

  return moveBlock(lines, from, order[order.length - 1], "after");
}
