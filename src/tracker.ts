import { App, MarkdownView, Notice, TFile } from "obsidian";
import { Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import { formatDuration } from "./duration";
import { SessionStore } from "./store";
import {
  findLineByTid,
  generateTid,
  isTrackable,
  parseTaskLine,
  withSpent,
  withTid,
} from "./task-line";
import type { TaskTimerSettings } from "./settings";

export interface ActiveTimer {
  tid: string;
  title: string;
  /** Epoch millis. */
  startedAt: number;
  /** Where the task line lived when the timer started. */
  sourcePath: string;
  /** Log file the open session was written to. */
  logKey: string;
  /**
   * The task's `spent` before this session began. Every write is `baseSpent`
   * plus the session so far, so refreshing the line while the timer runs can
   * never compound into double counting.
   */
  baseSpent: number;
}

type Listener = () => void;

/** How many recently modified notes the tid recovery scan looks through. */
const RECOVERY_SCAN_LIMIT = 200;

/** The span where two strings differ, so an edit touches as little as possible. */
function diffRange(
  before: string,
  after: string,
): { from: number; to: number; insert: string } | null {
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

/**
 * Rewrites a single task line, preferring the open editor so the cursor and
 * undo history survive, and falling back to a vault write otherwise.
 *
 * Edits go in through CodeMirror as the smallest possible change, kept out of
 * the undo stack: the timer refreshes the line every minute, and those writes
 * are bookkeeping the user should never have to undo their way past.
 */
async function updateTaskLine(
  app: App,
  path: string,
  tid: string,
  transform: (line: string) => string,
): Promise<boolean> {
  const file = app.vault.getFileByPath(path);
  if (!file) return false;

  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const view = leaf.view;
    if (!(view instanceof MarkdownView) || view.file?.path !== path) continue;

    const editor = view.editor;
    const index = findLineByTid(editor.getValue(), tid);
    if (index === -1) break;

    const before = editor.getLine(index);
    const after = transform(before);
    const diff = diffRange(before, after);
    if (!diff) return true;

    const cm = (editor as unknown as { cm?: EditorView }).cm;
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

export class Tracker {
  private active: ActiveTimer | null = null;
  /** Last `spent` value written to the line, to skip redundant writes. */
  private lastWritten: string | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly app: App,
    private readonly store: SessionStore,
    private readonly settings: TaskTimerSettings,
    private readonly persist: (active: ActiveTimer | null) => Promise<void>,
  ) {}

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  getActive(): ActiveTimer | null {
    return this.active;
  }

  isActive(tid: string | null): boolean {
    return tid !== null && this.active?.tid === tid;
  }

  /** Seconds accumulated by the running session, 0 when idle. */
  elapsed(): number {
    if (!this.active) return 0;
    return Math.max(0, Math.round((Date.now() - this.active.startedAt) / 1000));
  }

  /** Seconds to add on top of the line's recorded `spent` for a given task. */
  liveExtra(tid: string | null): number {
    return this.isActive(tid) ? this.elapsed() : 0;
  }

  /**
   * Restores a timer left running by a previous session. Wall-clock time keeps
   * accruing while Obsidian is closed, which is the point: offline work counts.
   */
  async restore(saved: ActiveTimer | null): Promise<void> {
    if (!saved) {
      const open = await this.store.findOpenSession();
      if (!open) return;

      // The log knows about a running session the settings file lost track of.
      const path = await this.findPathByTid(open.tid);
      this.active = {
        tid: open.tid,
        title: open.title,
        startedAt: open.start,
        sourcePath: path ?? "",
        logKey: open.dateKey,
        baseSpent: await this.baseSpentFor(open.tid),
      };
      this.emit();
      return;
    }

    this.active = {
      ...saved,
      // Older saved state predates this field, and a line refreshed mid-session
      // cannot be trusted to hold the baseline — the closed sessions can.
      baseSpent:
        typeof saved.baseSpent === "number"
          ? saved.baseSpent
          : await this.baseSpentFor(saved.tid),
    };
    this.emit();
  }

  /** The task's committed time: everything already closed out in the log. */
  private async baseSpentFor(tid: string): Promise<number> {
    return (await this.store.totalsByTid()).get(tid) ?? 0;
  }

  /**
   * Recovery path only, used when the stored source path is gone: looks for the
   * line carrying this tid. Task lines live in recently touched notes, so the
   * scan runs newest-first and stops well short of walking the whole vault.
   */
  private async findPathByTid(tid: string): Promise<string | null> {
    const files = this.app.vault
      .getMarkdownFiles()
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, RECOVERY_SCAN_LIMIT);

    for (const file of files) {
      const content = await this.app.vault.cachedRead(file);
      if (findLineByTid(content, tid) !== -1) return file.path;
    }

    return null;
  }

  async toggleAtLine(file: TFile, lineNumber: number): Promise<void> {
    const content = await this.app.vault.read(file);
    const lines = content.split("\n");
    const task = parseTaskLine(lines[lineNumber] ?? "");

    if (!task || !isTrackable(task)) return;
    if (task.tid && this.isActive(task.tid)) {
      await this.stop();
      return;
    }

    await this.startAtLine(file, lineNumber);
  }

  async startAtLine(file: TFile, lineNumber: number): Promise<void> {
    const content = await this.app.vault.read(file);
    const lines = content.split("\n");
    const raw = lines[lineNumber] ?? "";
    const task = parseTaskLine(raw);

    if (!task || !isTrackable(task)) return;

    // The single-timer invariant: whatever was running is closed out first.
    if (this.active) await this.stop();

    let tid = task.tid;
    if (!tid) {
      tid = generateTid();
      const stamped = withTid(raw, tid);
      const written = await updateTaskLine(this.app, file.path, tid, () => stamped);

      if (!written) {
        // The line has no tid yet, so it cannot be found by one — write directly.
        await this.app.vault.process(file, (current) => {
          const currentLines = current.split("\n");
          if (currentLines[lineNumber] !== raw) return current;
          currentLines[lineNumber] = stamped;
          return currentLines.join("\n");
        });
      }
    }

    const startedAt = Date.now();
    const logKey = await this.store.openSession(tid, task.title, startedAt);

    this.active = {
      tid,
      title: task.title,
      startedAt,
      sourcePath: file.path,
      logKey,
      baseSpent: task.spent,
    };
    this.lastWritten = null;

    await this.persist(this.active);
    this.emit();
  }

  /** Closes the running session and folds it into the task's `spent` field. */
  async stop(): Promise<void> {
    const active = this.active;
    if (!active) return;

    const seconds = Math.round((Date.now() - active.startedAt) / 1000);
    this.active = null;
    this.lastWritten = null;

    if (seconds < this.settings.minSessionSeconds) {
      await this.store.discardSession(active.tid, active.logKey);
      await this.persist(null);
      this.emit();
      return;
    }

    const recorded =
      (await this.store.closeSession(active.tid, active.logKey, Date.now())) ??
      seconds;

    const path =
      active.sourcePath || (await this.findPathByTid(active.tid)) || "";

    // Deliberately not read back from the line: it may already carry a live
    // figure written mid-session, and re-adding would double count.
    const written = path
      ? await updateTaskLine(this.app, path, active.tid, (line) =>
          withSpent(line, active.baseSpent + recorded),
        )
      : false;

    if (!written) {
      new Notice(
        `Task Timer: the session was logged, but its task line could not be ` +
          `found (tid: ${active.tid}).`,
      );
    }

    await this.persist(null);
    this.emit();
  }

  /**
   * Writes the running total into the task line while the timer is going.
   * Cheap to call often: it only touches the file when the rendered value
   * actually changes, which works out to about once a minute.
   */
  async syncSpent(): Promise<void> {
    const active = this.active;
    if (!active) return;

    const elapsed = this.elapsed();
    // Below the minimum the session would be discarded anyway, so writing a
    // figure the user might never keep would be a lie on disk.
    if (elapsed < this.settings.minSessionSeconds) return;

    const total = active.baseSpent + elapsed;
    const rendered = formatDuration(total);
    if (rendered === this.lastWritten) return;

    this.lastWritten = rendered;
    const path = active.sourcePath;
    if (!path) return;

    await updateTaskLine(this.app, path, active.tid, (line) =>
      withSpent(line, total),
    );
  }

  /**
   * Recomputes every task's `spent` from the log — the repair path for a
   * forgotten timer edited by hand, or a line that drifted out of sync.
   */
  async recomputeFromLog(): Promise<number> {
    const totals = await this.store.totalsByTid();
    let updated = 0;

    for (const file of this.app.vault.getMarkdownFiles()) {
      const content = await this.app.vault.cachedRead(file);
      if (!/\[tid::/i.test(content)) continue;

      await this.app.vault.process(file, (current) => {
        const lines = current.split("\n");
        let touched = false;

        for (let index = 0; index < lines.length; index++) {
          const task = parseTaskLine(lines[index]);
          if (!task?.tid) continue;

          const total = totals.get(task.tid);
          if (total === undefined || total === task.spent) continue;

          lines[index] = withSpent(lines[index], total);
          touched = true;
          updated++;
        }

        return touched ? lines.join("\n") : current;
      });
    }

    return updated;
  }
}
