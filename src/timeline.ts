import type { Session } from "./store";

export interface Span {
  tid: string;
  title: string;
  start: number;
  end: number;
}

/** A stretch of uninterrupted work, possibly across several tasks. */
export interface Block {
  start: number;
  end: number;
  spans: Span[];
  tids: string[];
}

export interface Timeline {
  start: number;
  end: number;
  spans: Span[];
  blocks: Block[];
}

/**
 * Switching tasks closes one session and opens the next a moment later; gaps
 * this short are a switch, not a pause.
 */
export const SWITCH_GAP_MS = 30_000;

/**
 * Lays one day's sessions out on a line. The running session ends at `now`;
 * `until` stretches the line to the present on a day still in progress.
 */
export function buildTimeline(
  sessions: Session[],
  now: number,
  until?: number,
): Timeline | null {
  const spans: Span[] = [];

  for (const session of [...sessions].sort((a, b) => a.start - b.start)) {
    const end = session.end ?? now;
    const previous = spans[spans.length - 1];
    // A hand-edited log can overlap; clip rather than draw on top.
    const start = previous ? Math.max(session.start, previous.end) : session.start;
    if (end <= start) continue;

    spans.push({ tid: session.tid, title: session.title, start, end });
  }

  if (!spans.length) return null;

  const blocks: Block[] = [];
  for (const span of spans) {
    const current = blocks[blocks.length - 1];

    if (current && span.start - current.end <= SWITCH_GAP_MS) {
      current.end = span.end;
      current.spans.push(span);
      if (!current.tids.includes(span.tid)) current.tids.push(span.tid);
    } else {
      blocks.push({ start: span.start, end: span.end, spans: [span], tids: [span.tid] });
    }
  }

  const lastEnd = spans[spans.length - 1].end;
  return {
    start: spans[0].start,
    end: Math.max(lastEnd, until ?? lastEnd),
    spans,
    blocks,
  };
}

/** Seconds per task across the day, in order of first appearance. */
export function totalsByTask(timeline: Timeline): Map<string, number> {
  const totals = new Map<string, number>();
  for (const span of timeline.spans) {
    const seconds = (span.end - span.start) / 1000;
    totals.set(span.tid, (totals.get(span.tid) ?? 0) + seconds);
  }
  return totals;
}

/** Obsidian's built-in accents, ordered so neighbours in a day contrast. */
const ACCENTS = ["purple", "orange", "cyan", "pink", "green", "blue", "yellow", "red"];

/**
 * One colour per task, assigned in order of first appearance so a day never
 * repeats a colour until the eight accents run out; past that, each accent
 * comes back pulled toward the text colour, which reads as a distinct shade in
 * both light and dark themes.
 */
export function assignColours(tids: string[]): Map<string, string> {
  const colours = new Map<string, string>();

  tids.forEach((tid, index) => {
    const accent = `var(--color-${ACCENTS[index % ACCENTS.length]})`;
    colours.set(
      tid,
      index < ACCENTS.length
        ? accent
        : `color-mix(in srgb, ${accent} 58%, var(--text-normal))`,
    );
  });

  return colours;
}
