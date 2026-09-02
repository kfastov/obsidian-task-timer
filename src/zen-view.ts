import { ItemView, MarkdownView, TFile, WorkspaceLeaf, debounce } from "obsidian";

import { formatClock, formatDuration } from "./duration";
import { findLineByTid, isDone, isTrackable, parseTaskLine } from "./task-line";
import type TaskTimerPlugin from "./main";

export const ZEN_VIEW_TYPE = "task-timer-zen";

interface ZenTask {
  raw: string;
  title: string;
  estimate: number;
  spent: number;
  tid: string | null;
  done: boolean;
}

interface Row {
  el: HTMLElement;
  time: HTMLElement;
  task: ZenTask;
}

/**
 * A focused read-out of one note's tracked tasks: each row is its own progress
 * bar, the running task is outlined, and the day's total sits on top.
 */
export class ZenView extends ItemView {
  private sourcePath: string | null = null;
  private tasks: ZenTask[] = [];
  private rows: Row[] = [];

  private totalEl!: HTMLElement;
  private metaEl!: HTMLElement;
  private sourceEl!: HTMLElement;
  private controlEl!: HTMLButtonElement;
  private listEl!: HTMLElement;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: TaskTimerPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return ZEN_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Task timer";
  }

  getIcon(): string {
    return "timer";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("tt-zen");

    const shell = this.contentEl.createDiv({ cls: "tt-zen-shell" });
    const head = shell.createDiv({ cls: "tt-zen-head" });
    const clock = head.createDiv({ cls: "tt-zen-clock" });

    this.totalEl = clock.createDiv({ cls: "tt-zen-total", text: "0:00:00" });
    this.metaEl = clock.createDiv({ cls: "tt-zen-meta" });
    this.sourceEl = clock.createDiv({ cls: "tt-zen-source" });

    this.controlEl = head.createEl("button", {
      cls: "tt-zen-control",
      text: "▶",
      attr: { type: "button", "aria-label": "Start timer" },
    });
    this.controlEl.addEventListener("click", () => void this.toggleControl());

    this.listEl = shell.createEl("ul", { cls: "tt-zen-list" });

    const reload = debounce(() => void this.reload(), 400, true);

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file || view.file.path === this.sourcePath) return;

        this.sourcePath = view.file.path;
        void this.reload();
      }),
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file.path === this.sourcePath) reload();
      }),
    );

    this.register(this.plugin.tracker.onChange(() => void this.reload()));
    this.registerInterval(window.setInterval(() => this.render(), 1000));

    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    this.sourcePath = active?.file?.path ?? this.plugin.lastMarkdownPath;
    await this.reload();
  }

  /** Re-reads the source note and rebuilds the list. */
  private async reload(): Promise<void> {
    const file = this.sourcePath
      ? this.app.vault.getFileByPath(this.sourcePath)
      : null;

    this.tasks =
      file instanceof TFile ? await this.readTasks(file) : [];

    this.listEl.empty();
    this.rows = [];

    if (!this.tasks.length) {
      this.listEl.createEl("li", {
        cls: "tt-zen-empty",
        text: file
          ? "No tasks with an estimate in this note."
          : "Open a note with estimated tasks.",
      });
      this.sourceEl.setText(file ? file.basename : "");
      this.render();
      return;
    }

    for (const task of this.tasks) {
      const el = this.listEl.createEl("li", {
        cls: "tt-zen-task",
        attr: { role: "button", tabindex: "0" },
      });
      el.createSpan({ cls: "tt-zen-name", text: task.title });
      const time = el.createSpan({ cls: "tt-zen-time" });

      el.addEventListener("click", () => void this.toggleTask(task));
      el.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        void this.toggleTask(task);
      });

      this.rows.push({ el, time, task });
    }

    this.sourceEl.setText(file ? file.basename : "");
    this.render();
  }

  private async readTasks(file: TFile): Promise<ZenTask[]> {
    const content = await this.app.vault.cachedRead(file);
    const tasks: ZenTask[] = [];

    for (const raw of content.split("\n")) {
      const parsed = parseTaskLine(raw);
      if (!parsed || !isTrackable(parsed) || parsed.estimate === null) continue;

      tasks.push({
        raw,
        title: parsed.title,
        estimate: parsed.estimate,
        spent: parsed.spent,
        tid: parsed.tid,
        done: isDone(parsed),
      });
    }

    return tasks;
  }

  /** Paints current values; cheap enough to run every second. */
  private render(): void {
    const { warnPercent, overPercent } = this.plugin.settings;
    let totalSpent = 0;
    let totalPlanned = 0;
    let touched = 0;

    for (const { el, time, task } of this.rows) {
      const spent = this.plugin.tracker.displaySpent(task.tid, task.spent);
      const percent = (spent / task.estimate) * 100;
      const running = this.plugin.tracker.isActive(task.tid);

      totalSpent += spent;
      totalPlanned += task.estimate;
      if (spent > 0) touched++;

      el.style.setProperty("--tt-pct", `${Math.min(100, percent).toFixed(2)}%`);
      el.toggleClass("is-active", running);
      el.toggleClass("is-done", task.done);
      el.toggleClass("is-warn", !task.done && percent >= warnPercent && percent < overPercent);
      el.toggleClass("is-over", !task.done && percent >= overPercent);

      const over = spent - task.estimate;
      const plan = formatDuration(task.estimate);
      time.setText(
        spent === 0
          ? `— / ${plan}`
          : `${formatDuration(spent)} / ${plan}` +
              (!task.done && over >= 60 ? `  +${formatDuration(over)}` : ""),
      );
    }

    const running = this.plugin.tracker.getActive() !== null;
    this.totalEl.setText(formatClock(totalSpent));
    this.totalEl.toggleClass("is-running", running);
    this.metaEl.setText(
      this.rows.length
        ? `of ${formatDuration(totalPlanned)} planned · ${touched} of ${this.rows.length} touched`
        : "",
    );

    this.controlEl.setText(running ? "⏸" : "▶");
    this.controlEl.toggleClass("is-running", running);
    this.controlEl.setAttribute("aria-label", running ? "Pause timer" : "Start timer");
  }

  private async toggleControl(): Promise<void> {
    if (this.plugin.tracker.getActive()) {
      await this.plugin.tracker.stop();
      return;
    }

    const next =
      this.rows.find((row) => this.plugin.tracker.isActive(row.task.tid)) ??
      this.rows.find((row) => !row.task.done);

    if (next) await this.toggleTask(next.task);
  }

  /**
   * Resolves the task back to a live line before toggling: the note may have
   * been edited since the list was built.
   */
  private async toggleTask(task: ZenTask): Promise<void> {
    const file = this.sourcePath
      ? this.app.vault.getFileByPath(this.sourcePath)
      : null;
    if (!file) return;

    const content = await this.app.vault.read(file);
    const index = task.tid
      ? findLineByTid(content, task.tid)
      : content.split("\n").indexOf(task.raw);

    if (index === -1) {
      await this.reload();
      return;
    }

    await this.plugin.tracker.toggleAtLine(file, index);
  }
}
