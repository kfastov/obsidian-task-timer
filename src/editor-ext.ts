import { MarkdownView, TFile } from "obsidian";
import { RangeSetBuilder, StateEffect } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  PluginValue,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";

import { isTrackable, parseTaskLine } from "./task-line";
import type TaskTimerPlugin from "./main";

/** Dispatched when the timer changes, to repaint decorations off a doc edit. */
export const refreshEffect = StateEffect.define<void>();

class TimerButton extends WidgetType {
  constructor(
    private readonly running: boolean,
    private readonly plugin: TaskTimerPlugin,
  ) {
    super();
  }

  eq(other: TimerButton): boolean {
    return other.running === this.running;
  }

  toDOM(view: EditorView): HTMLElement {
    const button = document.createElement("span");
    button.className = `tt-button${this.running ? " tt-button-running" : ""}`;
    button.setText(this.running ? "⏸" : "▶");
    button.setAttribute("aria-label", this.running ? "Pause timer" : "Start timer");

    button.addEventListener("mousedown", (event) => {
      // Claim the click before CodeMirror moves the cursor into the line.
      event.preventDefault();
      event.stopPropagation();

      const position = view.posAtDOM(button);
      const lineNumber = view.state.doc.lineAt(position).number - 1;
      const file = fileForEditorView(this.plugin, view);
      if (file) void this.plugin.tracker.toggleAtLine(file, lineNumber);
    });

    return button;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function fileForEditorView(
  plugin: TaskTimerPlugin,
  view: EditorView,
): TFile | null {
  for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
    const markdownView = leaf.view;
    if (!(markdownView instanceof MarkdownView)) continue;

    // `cm` is the underlying EditorView; not in the public typings.
    const cm = (markdownView.editor as unknown as { cm?: EditorView }).cm;
    if (cm === view) return markdownView.file;
  }

  return null;
}

export function buildEditorExtension(plugin: TaskTimerPlugin) {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }

      update(update: ViewUpdate): void {
        const refreshed = update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(refreshEffect)),
        );

        if (update.docChanged || update.viewportChanged || refreshed) {
          this.decorations = this.build(update.view);
        }
      }

      private build(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const { warnPercent, overPercent } = plugin.settings;

        for (const { from, to } of view.visibleRanges) {
          let position = from;

          while (position <= to) {
            const line = view.state.doc.lineAt(position);
            const task = parseTaskLine(line.text);

            if (task && isTrackable(task) && task.estimate) {
              const running = plugin.tracker.isActive(task.tid);
              const spent = task.spent + plugin.tracker.liveExtra(task.tid);
              const percent = (spent / task.estimate) * 100;

              const classes = ["tt-task"];
              if (running) classes.push("tt-running");
              if (percent >= overPercent) classes.push("tt-over");
              else if (percent >= warnPercent) classes.push("tt-warn");

              builder.add(
                line.from,
                line.from,
                Decoration.line({ class: classes.join(" ") }),
              );
              builder.add(
                line.to,
                line.to,
                Decoration.widget({
                  widget: new TimerButton(running, plugin),
                  side: 1,
                }),
              );
            }

            if (line.to + 1 > to) break;
            position = line.to + 1;
          }
        }

        return builder.finish();
      }
    },
    {
      decorations: (value) => value.decorations,
    },
  );
}
