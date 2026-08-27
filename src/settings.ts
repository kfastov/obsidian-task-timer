import { App, PluginSettingTab, Setting } from "obsidian";

import type TaskTimerPlugin from "./main";
import type { ActiveTimer } from "./tracker";

export interface TaskTimerSettings {
  /** Folder holding the per-day session logs. */
  logFolder: string;
  /** Percentage of the estimate at which the line turns yellow. */
  warnPercent: number;
  /** Percentage at which it turns red. */
  overPercent: number;
  /** Sessions shorter than this are discarded, so a stray click costs nothing. */
  minSessionSeconds: number;
}

export interface PluginData {
  settings: TaskTimerSettings;
  active: ActiveTimer | null;
}

export const DEFAULT_SETTINGS: TaskTimerSettings = {
  logFolder: "Time Log",
  warnPercent: 80,
  overPercent: 100,
  minSessionSeconds: 60,
};

export class TaskTimerSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: TaskTimerPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Log folder")
      .setDesc("Where session logs are written, one file per day.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.logFolder)
          .setValue(this.plugin.settings.logFolder)
          .onChange(async (value) => {
            this.plugin.settings.logFolder =
              value.trim() || DEFAULT_SETTINGS.logFolder;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Warning threshold")
      .setDesc("Percentage of the estimate at which the line turns yellow.")
      .addSlider((slider) =>
        slider
          .setLimits(50, 100, 5)
          .setValue(this.plugin.settings.warnPercent)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.warnPercent = value;
            await this.plugin.saveSettings();
            this.plugin.refreshEditors();
          }),
      );

    new Setting(containerEl)
      .setName("Over-budget threshold")
      .setDesc("Percentage of the estimate at which the line turns red.")
      .addSlider((slider) =>
        slider
          .setLimits(100, 200, 5)
          .setValue(this.plugin.settings.overPercent)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.overPercent = value;
            await this.plugin.saveSettings();
            this.plugin.refreshEditors();
          }),
      );

    new Setting(containerEl)
      .setName("Minimum session length")
      .setDesc(
        "Sessions shorter than this many seconds are discarded, " +
          "so a mistaken click leaves no trace.",
      )
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.minSessionSeconds))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed >= 0) {
              this.plugin.settings.minSessionSeconds = parsed;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Recalculate spent from the log")
      .setDesc(
        "Rewrites every tracked task's spent field as the sum of its logged " +
          "sessions. Run this after editing the log by hand — for instance " +
          "when a timer was left running overnight.",
      )
      .addButton((button) =>
        button
          .setButtonText("Recalculate")
          .onClick(() => this.plugin.recompute()),
      );
  }
}
