import {
  ItemView,
  MarkdownView,
  Scope,
  TFile,
  WorkspaceLeaf,
  debounce,
  setIcon,
  setTooltip,
} from "obsidian";

import { formatClock, formatDuration } from "./duration";
import { readNote, rewriteNote } from "./edit";
import { dateKey, type Session } from "./store";
import { findLineByTid, isDone, isTrackable, parseTaskLine } from "./task-line";
import { moveInList } from "./task-mover";
import {
  assignColours,
  buildTimeline,
  totalsByTask,
  type Timeline,
} from "./timeline";
import type TaskTimerPlugin from "./main";

export const ZEN_VIEW_TYPE = "task-timer-zen";

type Mode = "list" | "history";

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

interface LegendRow {
  el: HTMLElement;
  time: HTMLElement;
  tid: string;
}

/** What the pointer is over in history: one span, or every span of a task. */
interface Hot {
  tid: string;
  span?: number;
}

const DAILY_NAME = /^\d{4}-\d{2}-\d{2}$/;

function clockTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * A focused read-out of one note's tracked tasks. In list mode each row is its
 * own progress bar and a hairline timeline of the day runs above them; clicked,
 * that line unfolds into a history of the day's sessions, coloured by task.
 */
export class ZenView extends ItemView {
  private sourcePath: string | null = null;
  private tasks: ZenTask[] = [];
  private rows: Row[] = [];

  private mode: Mode = "list";
  private dayKey = dateKey(new Date(Date.now()));
  private sessions: Session[] = [];
  private timeline: Timeline | null = null;
  private colours = new Map<string, string>();
  private spanEls: HTMLElement[] = [];
  private legendRows: LegendRow[] = [];
  private hot: Hot | null = null;
  private pinnedBlock: number | null = null;

  private dragging = false;
  private reloadWhileDragging = false;

  private shellEl!: HTMLElement;
  private clockEl!: HTMLElement;
  private totalEl!: HTMLElement;
  private metaEl!: HTMLElement;
  private sourceEl!: HTMLElement;
  private controlEl!: HTMLButtonElement;
  private captionTextEl!: HTMLElement;
  private clearEl!: HTMLButtonElement;
  private timelineEl!: HTMLElement;
  private trackEl!: HTMLElement;
  private axisStartEl!: HTMLElement;
  private axisEndEl!: HTMLElement;
  private listEl!: HTMLElement;
  private legendEl!: HTMLElement;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: TaskTimerPlugin,
  ) {
    super(leaf);

    this.scope = new Scope(this.app.scope);
    this.scope.register([], "Escape", () => {
      if (this.pinnedBlock !== null) this.pin(null);
      else if (this.mode === "history") this.setMode("list");
      return false;
    });
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
    this.build();

    const reload = debounce(() => void this.reload(), 300, true);
    const reloadSessions = debounce(() => void this.reloadSessions(), 300, true);

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file || view.file.path === this.sourcePath) return;

        this.sourcePath = view.file.path;
        void this.reload();
        void this.reloadSessions();
      }),
    );

    this.registerEvent(
      this.app.workspace.on("editor-change", (_editor, info) => {
        if (info.file?.path === this.sourcePath) reload();
      }),
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file.path === this.sourcePath) reload();
        if (file.path === this.logPath()) reloadSessions();
      }),
    );

    this.register(
      this.plugin.tracker.onChange(() => {
        void this.reload();
        void this.reloadSessions();
      }),
    );

    this.registerInterval(window.setInterval(() => this.render(), 1000));

    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    this.sourcePath = active?.file?.path ?? this.plugin.lastMarkdownPath;
    await this.reload();
    await this.reloadSessions();
  }

  // --- structure ------------------------------------------------------------

  private build(): void {
    this.shellEl = this.contentEl.createDiv({
      cls: "tt-zen-shell",
      attr: { "data-mode": this.mode },
    });

    const head = this.shellEl.createDiv({ cls: "tt-zen-head" });
    this.clockEl = head.createDiv({
      cls: "tt-zen-clock",
      attr: { role: "button", tabindex: "0" },
    });
    this.totalEl = this.clockEl.createDiv({ cls: "tt-zen-total", text: "0:00:00" });
    this.metaEl = this.clockEl.createDiv({ cls: "tt-zen-meta" });
    this.sourceEl = this.clockEl.createDiv({ cls: "tt-zen-source" });
    this.clockEl.addEventListener("click", () => this.toggleMode());
    this.clockEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.toggleMode();
    });

    this.controlEl = head.createEl("button", {
      cls: "tt-zen-control",
      text: "▶",
      attr: { type: "button", "aria-label": "Start timer" },
    });
    this.controlEl.addEventListener("click", () => void this.toggleControl());

    const caption = this.shellEl.createDiv({ cls: "tt-zen-caption" });
    this.captionTextEl = caption.createSpan({ cls: "tt-zen-caption-text" });
    const actions = caption.createDiv({ cls: "tt-zen-caption-actions" });
    this.clearEl = actions.createEl("button", {
      cls: "tt-zen-link",
      text: "Clear filter",
      attr: { type: "button" },
    });
    this.clearEl.addEventListener("click", () => this.pin(null));
    const back = actions.createEl("button", {
      cls: "tt-zen-link",
      text: "Back to tasks",
      attr: { type: "button" },
    });
    back.addEventListener("click", () => this.setMode("list"));

    this.timelineEl = this.shellEl.createDiv({
      cls: "tt-zen-timeline",
      attr: { role: "button", tabindex: "0" },
    });
    this.trackEl = this.timelineEl.createDiv({ cls: "tt-zen-track" });
    this.trackEl.createDiv({ cls: "tt-zen-rail" });
    const axis = this.timelineEl.createDiv({ cls: "tt-zen-axis" });
    this.axisStartEl = axis.createSpan();
    this.axisEndEl = axis.createSpan();

    this.timelineEl.addEventListener("click", (event) => this.onTimelineClick(event));
    this.timelineEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (this.mode !== "list" || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      this.setMode("history");
    });
    this.timelineEl.addEventListener("mouseleave", () => this.setHot(null));

    this.listEl = this.shellEl.createEl("ul", { cls: "tt-zen-list" });
    this.legendEl = this.shellEl.createEl("ul", { cls: "tt-zen-legend" });
    this.legendEl.addEventListener("mouseleave", () => this.setHot(null));

    this.syncModeAffordances();
  }

  // --- data -----------------------------------------------------------------

  private sourceFile(): TFile | null {
    return this.sourcePath ? this.app.vault.getFileByPath(this.sourcePath) : null;
  }

  /** A daily note shows its own day; any other note shows today. */
  private resolveDay(): string {
    const file = this.sourceFile();
    return file && DAILY_NAME.test(file.basename)
      ? file.basename
      : dateKey(new Date(Date.now()));
  }

  private logPath(): string {
    return `${this.plugin.settings.logFolder}/${this.dayKey}.md`;
  }

  private isToday(): boolean {
    return this.dayKey === dateKey(new Date(Date.now()));
  }

  /** Re-reads the source note and rebuilds the task list. */
  private async reload(): Promise<void> {
    if (this.dragging) {
      this.reloadWhileDragging = true;
      return;
    }

    const file = this.sourceFile();
    this.tasks = file ? await this.readTasks(file) : [];

    this.listEl.empty();
    this.rows = [];

    if (!this.tasks.length) {
      this.listEl.createEl("li", {
        cls: "tt-zen-empty",
        text: file
          ? "No tasks with an estimate in this note."
          : "Open a note with estimated tasks.",
      });
    }

    this.tasks.forEach((task, index) => {
      const el = this.listEl.createEl("li", {
        cls: "tt-zen-task",
        attr: { role: "button", tabindex: "0" },
      });

      const handle = el.createSpan({ cls: "tt-zen-handle" });
      setIcon(handle, "grip-vertical");
      handle.addEventListener("click", (event) => event.stopPropagation());
      handle.addEventListener("pointerdown", (event) =>
        this.startDrag(event, index, handle),
      );

      el.createSpan({ cls: "tt-zen-name", text: task.title });
      const time = el.createSpan({ cls: "tt-zen-time" });

      el.addEventListener("click", () => void this.toggleTask(task));
      el.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        void this.toggleTask(task);
      });

      this.rows.push({ el, time, task });
    });

    this.sourceEl.setText(file ? file.basename : "");
    this.rebuildLegend();
    this.render();
  }

  private async readTasks(file: TFile): Promise<ZenTask[]> {
    const content = await readNote(this.app, file);
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

  /** Re-reads the day's session log and rebuilds the timeline around it. */
  private async reloadSessions(): Promise<void> {
    this.dayKey = this.resolveDay();
    this.sessions = await this.plugin.store.read(this.dayKey);
    this.pinnedBlock = null;
    this.hot = null;
    this.rebuildTimeline();
    this.rebuildLegend();
    this.render();
  }

  private computeTimeline(): Timeline | null {
    const now = Date.now();
    return buildTimeline(this.sessions, now, this.isToday() ? now : undefined);
  }

  // --- timeline -------------------------------------------------------------

  private rebuildTimeline(): void {
    this.timeline = this.computeTimeline();
    for (const el of this.spanEls) el.remove();
    this.spanEls = [];

    const timeline = this.timeline;
    this.timelineEl.toggleClass("is-empty", !timeline);
    if (!timeline) return;

    const order: string[] = [];
    for (const span of timeline.spans) {
      if (!order.includes(span.tid)) order.push(span.tid);
    }
    this.colours = assignColours(order);

    timeline.blocks.forEach((block, blockIndex) => {
      for (const span of block.spans) {
        const index = timeline.spans.indexOf(span);
        const el = this.trackEl.createDiv({
          cls: "tt-zen-span",
          attr: { "data-tid": span.tid, "data-block": String(blockIndex) },
        });
        el.style.setProperty("--tt-span-colour", this.colours.get(span.tid) ?? "");
        el.addEventListener("mouseenter", () => {
          if (this.mode === "history") this.setHot({ tid: span.tid, span: index });
        });
        this.spanEls[index] = el;
      }
    });

    this.applyEmphasis();
  }

  /** Repositions spans; the line keeps growing toward the present. */
  private renderTimeline(): void {
    const next = this.computeTimeline();
    if ((next?.spans.length ?? 0) !== this.spanEls.length) {
      this.rebuildTimeline();
    } else {
      this.timeline = next;
    }

    const timeline = this.timeline;
    if (!timeline) {
      this.axisStartEl.setText("");
      this.axisEndEl.setText("");
      return;
    }

    const range = Math.max(1, timeline.end - timeline.start);
    timeline.spans.forEach((span, index) => {
      const el = this.spanEls[index];
      el.style.left = `${((span.start - timeline.start) / range) * 100}%`;
      el.style.width = `${((span.end - span.start) / range) * 100}%`;

      if (this.mode === "history") {
        const title = this.titleFor(span.tid, span.title);
        const length = formatDuration((span.end - span.start) / 1000);
        el.setAttribute(
          "aria-label",
          `${title} · ${clockTime(span.start)}–${clockTime(span.end)} · ${length}`,
        );
      }
    });

    this.axisStartEl.setText(clockTime(timeline.start));
    const live = this.isToday() && this.plugin.tracker.getActive() !== null;
    this.axisEndEl.setText(this.isToday() ? "now" : clockTime(timeline.end));
    this.axisEndEl.toggleClass("is-live", live);
  }

  private onTimelineClick(event: MouseEvent): void {
    if (this.mode === "list") {
      this.setMode("history");
      return;
    }

    const target = event.target as HTMLElement;
    const spanEl = target.closest<HTMLElement>(".tt-zen-span");
    if (!spanEl) {
      this.pin(null);
      return;
    }

    const block = Number(spanEl.dataset.block);
    this.pin(this.pinnedBlock === block ? null : block);
  }

  // --- history --------------------------------------------------------------

  private titleFor(tid: string, fallback: string): string {
    return this.tasks.find((task) => task.tid === tid)?.title ?? fallback;
  }

  private rebuildLegend(): void {
    this.legendEl.empty();
    this.legendRows = [];

    const timeline = this.timeline;
    if (!timeline) {
      this.legendEl.createEl("li", {
        cls: "tt-zen-empty",
        text: "No sessions logged for this day yet.",
      });
      return;
    }

    for (const tid of this.colours.keys()) {
      const span = timeline.spans.find((candidate) => candidate.tid === tid);
      const el = this.legendEl.createEl("li", {
        cls: "tt-zen-legend-row",
        attr: { "data-tid": tid },
      });
      const dot = el.createSpan({ cls: "tt-zen-dot" });
      dot.style.setProperty("--tt-span-colour", this.colours.get(tid) ?? "");
      el.createSpan({ cls: "tt-zen-name", text: this.titleFor(tid, span?.title ?? tid) });
      const time = el.createSpan({ cls: "tt-zen-time" });
      el.addEventListener("mouseenter", () => this.setHot({ tid }));

      this.legendRows.push({ el, time, tid });
    }

    this.applyEmphasis();
  }

  private setHot(hot: Hot | null): void {
    if (hot?.tid === this.hot?.tid && hot?.span === this.hot?.span) return;
    this.hot = hot;
    this.applyEmphasis();
  }

  /** Clicking a stretch of work narrows the list to the tasks inside it. */
  private pin(block: number | null): void {
    this.pinnedBlock = block;
    this.applyEmphasis();
    this.render();
  }

  private applyEmphasis(): void {
    const history = this.mode === "history";
    const hot = history ? this.hot : null;
    const block =
      history && this.pinnedBlock !== null
        ? this.timeline?.blocks[this.pinnedBlock]
        : undefined;

    this.spanEls.forEach((el, index) => {
      const tid = el.dataset.tid ?? "";
      const inBlock = !block || Number(el.dataset.block) === this.pinnedBlock;
      const isHot =
        !!hot && (hot.span !== undefined ? hot.span === index : hot.tid === tid);

      el.toggleClass("is-hot", isHot);
      el.toggleClass("is-dim", (!!hot && !isHot) || (!inBlock && !isHot));
    });

    for (const row of this.legendRows) {
      const isHot = !!hot && hot.tid === row.tid;
      row.el.toggleClass("is-hot", isHot);
      row.el.toggleClass("is-dim", !!hot && !isHot);
      row.el.toggleClass("is-hidden", !!block && !block.tids.includes(row.tid));
    }

    this.clearEl.toggleClass("is-hidden", !block);
  }

  private toggleMode(): void {
    this.setMode(this.mode === "list" ? "history" : "list");
  }

  private setMode(mode: Mode): void {
    if (mode === this.mode) return;

    if (mode === "history") {
      // The band opens to exactly the height of a task row.
      const height = this.rows[0]?.el.offsetHeight || 46;
      this.shellEl.style.setProperty("--tt-band-h", `${height}px`);
    }

    this.mode = mode;
    this.hot = null;
    this.pinnedBlock = null;
    this.shellEl.setAttr("data-mode", mode);
    this.syncModeAffordances();
    this.applyEmphasis();
    this.render();
  }

  private syncModeAffordances(): void {
    if (this.mode === "list") {
      setTooltip(this.timelineEl, "Show history");
      setTooltip(this.clockEl, "Show history");
      this.timelineEl.setAttr("role", "button");
      this.timelineEl.setAttr("tabindex", "0");
    } else {
      // Unfolded, the band is a chart rather than a button: take it out of the
      // tab order so it does not keep a focus ring after a click.
      this.timelineEl.removeAttribute("aria-label");
      this.timelineEl.removeAttribute("role");
      this.timelineEl.removeAttribute("tabindex");
      if (document.activeElement === this.timelineEl) this.timelineEl.blur();
      setTooltip(this.clockEl, "Back to tasks");
    }
  }

  // --- rendering ------------------------------------------------------------

  /** Paints current values; cheap enough to run every second. */
  private render(): void {
    this.renderTimeline();
    if (this.mode === "list") this.renderList();
    else this.renderHistory();

    const running = this.plugin.tracker.getActive() !== null;
    this.totalEl.toggleClass("is-running", running);
    this.controlEl.setText(running ? "⏸" : "▶");
    this.controlEl.toggleClass("is-running", running);
    this.controlEl.setAttribute("aria-label", running ? "Pause timer" : "Start timer");
  }

  private renderList(): void {
    const { warnPercent, overPercent } = this.plugin.settings;
    let totalSpent = 0;
    let totalPlanned = 0;
    let touched = 0;

    for (const { el, time, task } of this.rows) {
      const spent = this.plugin.tracker.displaySpent(task.tid, task.spent);
      const percent = (spent / task.estimate) * 100;

      totalSpent += spent;
      totalPlanned += task.estimate;
      if (spent > 0) touched++;

      el.style.setProperty("--tt-pct", `${Math.min(100, percent).toFixed(2)}%`);
      el.toggleClass("is-active", this.plugin.tracker.isActive(task.tid));
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

    this.totalEl.setText(formatClock(totalSpent));
    this.metaEl.setText(
      this.rows.length
        ? `of ${formatDuration(totalPlanned)} planned · ${touched} of ${this.rows.length} touched`
        : "",
    );
  }

  private renderHistory(): void {
    const timeline = this.timeline;
    const block =
      timeline && this.pinnedBlock !== null ? timeline.blocks[this.pinnedBlock] : undefined;

    const scope = block
      ? { ...timeline!, spans: block.spans }
      : timeline;
    const totals = scope ? totalsByTask(scope) : new Map<string, number>();

    for (const row of this.legendRows) {
      const seconds = totals.get(row.tid) ?? 0;
      row.time.setText(seconds ? formatDuration(seconds) : "");
    }

    const worked = [...totals.values()].reduce((sum, seconds) => sum + seconds, 0);
    this.totalEl.setText(formatClock(worked));

    if (!timeline) {
      this.metaEl.setText("nothing tracked");
      this.captionTextEl.setText(this.isToday() ? "Today" : this.dayKey);
      return;
    }

    const day = this.isToday() ? "Today" : this.dayKey;
    if (block) {
      const count = block.tids.length;
      this.metaEl.setText(`in this stretch · ${count} ${count === 1 ? "task" : "tasks"}`);
      this.captionTextEl.setText(`${clockTime(block.start)} – ${clockTime(block.end)}`);
    } else {
      const count = this.colours.size;
      this.metaEl.setText(`worked · ${count} ${count === 1 ? "task" : "tasks"}`);
      this.captionTextEl.setText(
        `${day} · ${clockTime(timeline.start)} – ${this.isToday() ? "now" : clockTime(timeline.end)}`,
      );
    }
  }

  // --- reordering -----------------------------------------------------------

  private startDrag(event: PointerEvent, index: number, handle: HTMLElement): void {
    if (event.button !== 0 || this.rows.length < 2) return;
    event.preventDefault();
    event.stopPropagation();

    const dragged = this.rows[index].el;
    const rects = this.rows.map((row) => row.el.getBoundingClientRect());
    const height = rects[index].height;
    const startY = event.clientY;
    let target = index;

    this.dragging = true;
    handle.setPointerCapture(event.pointerId);
    dragged.addClass("is-dragging");
    for (const row of this.rows) if (row.el !== dragged) row.el.addClass("is-shifting");

    const onMove = (move: PointerEvent) => {
      const dy = move.clientY - startY;
      dragged.style.transform = `translateY(${dy}px)`;

      const centre = rects[index].top + height / 2 + dy;
      target = rects.filter(
        (rect, i) => i !== index && rect.top + rect.height / 2 < centre,
      ).length;

      this.rows.forEach((row, i) => {
        if (i === index) return;
        let shift = 0;
        if (index < target && i > index && i <= target) shift = -height;
        if (index > target && i >= target && i < index) shift = height;
        row.el.style.transform = shift ? `translateY(${shift}px)` : "";
      });
    };

    const finish = (commit: boolean) => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);

      const moved = commit && target !== index;
      const tasksBefore = this.tasks.slice();

      if (moved) {
        // Settle the drop in the DOM straight away, so the row stays where it
        // was released instead of snapping back while the note is written.
        const [row] = this.rows.splice(index, 1);
        this.rows.splice(target, 0, row);
        const [task] = this.tasks.splice(index, 1);
        this.tasks.splice(target, 0, task);
        this.listEl.insertBefore(row.el, this.rows[target + 1]?.el ?? null);
      }

      for (const row of this.rows) {
        row.el.removeClass("is-dragging", "is-shifting");
        row.el.style.transform = "";
      }

      this.dragging = false;
      const pending = this.reloadWhileDragging;
      this.reloadWhileDragging = false;

      if (moved) void this.moveTask(tasksBefore, index, target);
      else if (pending) void this.reload();
    };

    const onUp = () => finish(true);
    const onCancel = () => finish(false);

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
  }

  /**
   * Writes a drop back into the note as one undoable edit. `tasks` is the list
   * as it stood before the drop, which is what `from` and `to` index into.
   */
  private async moveTask(tasks: ZenTask[], from: number, to: number): Promise<void> {
    const file = this.sourceFile();
    if (!file) return;

    await rewriteNote(this.app, file, (content) => {
      const lines = content.split("\n");
      const used = new Set<number>();

      const taskLines = tasks.map((task) => {
        let line = task.tid ? findLineByTid(content, task.tid) : -1;
        if (line === -1) {
          line = lines.findIndex((text, i) => text === task.raw && !used.has(i));
        }
        used.add(line);
        return line;
      });

      // The note changed under the drag in a way we cannot map; leave it be.
      if (taskLines.includes(-1)) return content;
      return moveInList(lines, taskLines, from, to).join("\n");
    });

    await this.reload();
  }

  // --- timer ----------------------------------------------------------------

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
    const file = this.sourceFile();
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
