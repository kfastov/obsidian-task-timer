import { App, MarkdownView, Notice, TFile } from "obsidian";

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
}

type Listener = () => void;

/**
 * Rewrites a single task line, preferring the open editor so the cursor and
 * undo history survive, and falling back to a vault write otherwise.
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

    editor.setLine(index, transform(editor.getLine(index)));
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
      };
      this.emit();
      return;
    }

    this.active = saved;
    this.emit();
  }

  /** Scans daily notes for the line carrying this tid. */
  private async findPathByTid(tid: string): Promise<string | null> {
    const files = this.app.vault
      .getMarkdownFiles()
      .sort((a, b) => b.stat.mtime - a.stat.mtime);

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
    };

    await this.persist(this.active);
    this.emit();
  }

  /** Closes the running session and folds it into the task's `spent` field. */
  async stop(): Promise<void> {
    const active = this.active;
    if (!active) return;

    const seconds = Math.round((Date.now() - active.startedAt) / 1000);
    this.active = null;

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

    const written = path
      ? await updateTaskLine(this.app, path, active.tid, (line) => {
          const task = parseTaskLine(line);
          return withSpent(line, (task?.spent ?? 0) + recorded);
        })
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
