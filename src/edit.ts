import { App, MarkdownView, TFile } from "obsidian";
import { Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import { findLineByTid } from "./task-line";

interface Change {
  from: number;
  to: number;
  insert: string;
}

/** The span where two strings differ, so an edit touches as little as possible. */
export function diffRange(before: string, after: string): Change | null {
  if (before === after) return null;

  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  ) {
    start++;
  }

  let endBefore = before.length;
  let endAfter = after.length;
  while (
    endBefore > start &&
    endAfter > start &&
    before[endBefore - 1] === after[endAfter - 1]
  ) {
    endBefore--;
    endAfter--;
  }

  return { from: start, to: endBefore, insert: after.slice(start, endAfter) };
}

function editorFor(app: App, path: string): MarkdownView | null {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const view = leaf.view;
    if (view instanceof MarkdownView && view.file?.path === path) return view;
  }
  return null;
}

function cmOf(view: MarkdownView): EditorView | undefined {
  // `cm` is the underlying EditorView; not in the public typings.
  return (view.editor as unknown as { cm?: EditorView }).cm;
}

/**
 * Rewrites a single task line, preferring the open editor so the cursor
 * survives, and falling back to a vault write otherwise.
 *
 * Edits go in as the smallest possible change and stay out of the undo stack:
 * the timer refreshes the line every minute, and those writes are bookkeeping
 * the user should never have to undo their way past.
 */
export async function updateTaskLine(
  app: App,
  path: string,
  tid: string,
  transform: (line: string) => string,
): Promise<boolean> {
  const file = app.vault.getFileByPath(path);
  if (!file) return false;

  const view = editorFor(app, path);
  if (view) {
    const editor = view.editor;
    const index = findLineByTid(editor.getValue(), tid);

    if (index !== -1) {
      const before = editor.getLine(index);
      const after = transform(before);
      const diff = diffRange(before, after);
      if (!diff) return true;

      const cm = cmOf(view);
      if (cm) {
        const line = cm.state.doc.line(index + 1);
        cm.dispatch({
          changes: {
            from: line.from + diff.from,
            to: line.from + diff.to,
            insert: diff.insert,
          },
          annotations: Transaction.addToHistory.of(false),
        });
      } else {
        editor.setLine(index, after);
      }

      return true;
    }
  }

  let changed = false;
  await app.vault.process(file, (content) => {
    const index = findLineByTid(content, tid);
    if (index === -1) return content;

    const lines = content.split("\n");
    lines[index] = transform(lines[index]);
    changed = true;
    return lines.join("\n");
  });

  return changed;
}

/**
 * Applies a whole-note transform the user asked for — reordering, say — as a
 * single undoable edit when the note is open, so Ctrl+Z puts things back.
 */
export async function rewriteNote(
  app: App,
  file: TFile,
  transform: (content: string) => string,
): Promise<void> {
  const view = editorFor(app, file.path);
  const cm = view ? cmOf(view) : undefined;

  if (view && cm) {
    const before = cm.state.doc.toString();
    const diff = diffRange(before, transform(before));
    if (!diff) return;

    cm.dispatch({ changes: diff });
    // Flush now rather than on the next autosave, so a timer started straight
    // after the move reads the same lines from disk that the editor shows.
    await view.save();
    return;
  }

  await app.vault.process(file, transform);
}

/**
 * The note as the user currently sees it: the open editor's buffer when there
 * is one, since edits reach disk only on the next autosave.
 */
export async function readNote(app: App, file: TFile): Promise<string> {
  const view = editorFor(app, file.path);
  return view ? view.editor.getValue() : app.vault.cachedRead(file);
}
