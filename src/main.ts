import { MarkdownView, Notice, Plugin } from "obsidian";
import type { EditorView } from "@codemirror/view";

import { buildEditorExtension, refreshEffect } from "./editor-ext";
import { formatClock } from "./duration";
import { SessionStore } from "./store";
import { findLineByTid, isDone, parseTaskLine } from "./task-line";
import { Tracker, type ActiveTimer } from "./tracker";
import {
  DEFAULT_SETTINGS,
  TaskTimerSettingTab,
  type PluginData,
  type TaskTimerSettings,
} from "./settings";

/** How often the line highlight catches up with the running timer. */
const REPAINT_EVERY_TICKS = 15;

export default class TaskTimerPlugin extends Plugin {
  settings: TaskTimerSettings = { ...DEFAULT_SETTINGS };
  tracker!: Tracker;

  private store!: SessionStore;
  private statusBar!: HTMLElement;
  private ticks = 0;

  async onload(): Promise<void> {
    const data = (await this.loadData()) as PluginData | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };

    this.store = new SessionStore(this.app, this.settings.logFolder);
    this.tracker = new Tracker(
      this.app,
      this.store,
      this.settings,
      (active) => this.persist(active),
    );

    this.registerEditorExtension(buildEditorExtension(this));
    this.addSettingTab(new TaskTimerSettingTab(this.app, this));

    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("tt-status");
    this.registerDomEvent(this.statusBar, "click", () => void this.tracker.stop());

    this.register(
      this.tracker.onChange(() => {
        this.renderStatusBar();
        this.refreshEditors();
      }),
    );

    this.registerInterval(
      window.setInterval(() => {
        if (!this.tracker.getActive()) return;

        this.renderStatusBar();
        void this.tracker.syncSpent();
        if (++this.ticks % REPAINT_EVERY_TICKS === 0) this.refreshEditors();
      }, 1000),
    );

    // Checking a task off ends its session — the work is done, not paused.
    this.registerEvent(
      this.app.workspace.on("editor-change", (editor, info) => {
        const active = this.tracker.getActive();
        if (!active || info.file?.path !== active.sourcePath) return;

        const index = findLineByTid(editor.getValue(), active.tid);
        if (index === -1) return;

        const task = parseTaskLine(editor.getLine(index));
        if (task && isDone(task)) void this.tracker.stop();
      }),
    );

    this.addCommand({
      id: "toggle-timer",
      name: "Start or pause the timer on the task at the cursor",
      editorCallback: (editor, view) => {
        if (!(view instanceof MarkdownView) || !view.file) return;
        void this.tracker.toggleAtLine(view.file, editor.getCursor().line);
      },
    });

    this.addCommand({
      id: "stop-timer",
      name: "Stop the running timer",
      checkCallback: (checking) => {
        if (!this.tracker.getActive()) return false;
        if (!checking) void this.tracker.stop();
        return true;
      },
    });

    this.addCommand({
      id: "recompute-spent",
      name: "Recalculate spent from the log",
      callback: () => void this.recompute(),
    });

    // Deferred so the vault is fully indexed before the log is scanned.
    this.app.workspace.onLayoutReady(() => {
      void this.tracker.restore(data?.active ?? null).then(() => {
        this.renderStatusBar();
        this.refreshEditors();
      });
    });

    this.renderStatusBar();
  }

  onunload(): void {
    // The timer keeps running across restarts by design: wall-clock time counts
    // even while Obsidian is closed, so offline work is not lost.
  }

  async persist(active: ActiveTimer | null): Promise<void> {
    const payload: PluginData = { settings: this.settings, active };
    await this.saveData(payload);
  }

  /** Saves settings without touching the running timer. */
  async saveSettings(): Promise<void> {
    this.store = new SessionStore(this.app, this.settings.logFolder);
    await this.persist(this.tracker?.getActive() ?? null);
  }

  async recompute(): Promise<void> {
    const updated = await this.tracker.recomputeFromLog();
    new Notice(`Task Timer: ${updated} task line(s) updated.`);
    this.refreshEditors();
  }

  refreshEditors(): void {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;

      const cm = (view.editor as unknown as { cm?: EditorView }).cm;
      cm?.dispatch({ effects: refreshEffect.of() });
    }
  }

  private renderStatusBar(): void {
    const active = this.tracker?.getActive();

    if (!active) {
      this.statusBar.setText("");
      this.statusBar.removeClass("tt-status-running");
      return;
    }

    const title =
      active.title.length > 34 ? `${active.title.slice(0, 33)}…` : active.title;

    this.statusBar.setText(`▶ ${formatClock(this.tracker.elapsed())} · ${title}`);
    this.statusBar.addClass("tt-status-running");
    this.statusBar.setAttribute("aria-label", "Click to stop the timer");
  }
}
