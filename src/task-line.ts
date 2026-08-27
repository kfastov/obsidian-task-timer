import { formatDuration, parseDuration } from "./duration";

export const ESTIMATE_KEY = "estimate";
export const TID_KEY = "tid";
export const SPENT_KEY = "spent";

/** `- [ ] text`, `* [x] text`, `+ [/] text`, with any indentation. */
const TASK_LINE = /^(\s*)([-*+])\s+\[(.)\]\s+(.*)$/;

export interface ParsedTask {
  /** Line text as it appears in the file. */
  raw: string;
  indent: string;
  bullet: string;
  /** The character inside the brackets: " ", "x", "/", "-" … */
  status: string;
  /** Everything after the checkbox, inline fields included. */
  body: string;
  estimate: number | null;
  spent: number;
  tid: string | null;
  /** Body with all recognised inline fields stripped, for display. */
  title: string;
}

function inlineFieldPattern(key: string): RegExp {
  return new RegExp(`\\[${key}::\\s*([^\\]]*)\\]`, "i");
}

function readField(body: string, key: string): string | null {
  const match = body.match(inlineFieldPattern(key));
  return match ? match[1].trim() : null;
}

/** Returns null when the line is not a checkbox task. */
export function parseTaskLine(raw: string): ParsedTask | null {
  const match = raw.match(TASK_LINE);
  if (!match) return null;

  const [, indent, bullet, status, body] = match;
  const estimateRaw = readField(body, ESTIMATE_KEY);
  const spentRaw = readField(body, SPENT_KEY);

  const title = body
    .replace(/\[[a-z0-9_-]+::[^\]]*\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return {
    raw,
    indent,
    bullet,
    status,
    body,
    estimate: estimateRaw ? parseDuration(estimateRaw) : null,
    spent: (spentRaw ? parseDuration(spentRaw) : null) ?? 0,
    tid: readField(body, TID_KEY),
    title,
  };
}

/** Only tasks carrying an estimate get a timer button. */
export function isTrackable(task: ParsedTask): boolean {
  return task.estimate !== null && task.estimate > 0;
}

export function isDone(task: ParsedTask): boolean {
  return task.status.toLowerCase() === "x";
}

/**
 * Sets an inline field, replacing it in place when present and appending it
 * to the end of the line otherwise, so field order stays stable across edits.
 */
export function withField(raw: string, key: string, value: string): string {
  const pattern = inlineFieldPattern(key);
  const field = `[${key}:: ${value}]`;

  if (pattern.test(raw)) return raw.replace(pattern, field);

  return `${raw.replace(/\s+$/, "")} ${field}`;
}

export function withSpent(raw: string, seconds: number): string {
  return withField(raw, SPENT_KEY, formatDuration(seconds));
}

export function withTid(raw: string, tid: string): string {
  return withField(raw, TID_KEY, tid);
}

/** Short, collision-resistant enough for a personal vault. */
export function generateTid(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Finds the line index of a task carrying this tid, or -1. */
export function findLineByTid(content: string, tid: string): number {
  const needle = new RegExp(`\\[${TID_KEY}::\\s*${tid}\\s*\\]`, "i");
  const lines = content.split("\n");

  for (let index = 0; index < lines.length; index++) {
    if (needle.test(lines[index])) return index;
  }

  return -1;
}
