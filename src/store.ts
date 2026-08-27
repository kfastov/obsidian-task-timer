import { App, TFile, normalizePath } from "obsidian";

import { TID_KEY } from "./task-line";

export interface Session {
  tid: string;
  title: string;
  /** Epoch millis. */
  start: number;
  /** Epoch millis, or null while the session is still running. */
  end: number | null;
  /** Log file the session lives in, keyed by the day it started. */
  dateKey: string;
}

const OPEN_MARKER = "...";

/**
 * `- 09:12:04–09:47:31 [tid:: a1b2c3] Title`
 * Accepts `-`, `--` and en dash as the separator, and `HH:MM` without seconds,
 * so a log fixed up by hand still parses.
 */
const SESSION_LINE = new RegExp(
  `^\\s*-\\s+(\\d{1,2}:\\d{2}(?::\\d{2})?)\\s*(?:–|—|--|-)\\s*(\\d{1,2}:\\d{2}(?::\\d{2})?|\\.\\.\\.)\\s+` +
    `\\[${TID_KEY}::\\s*([^\\]\\s]+)\\s*\\]\\s*(.*)$`,
);

export function dateKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function timeOfDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Resolves `HH:MM[:SS]` against a `YYYY-MM-DD` key, in local time. */
function toEpoch(key: string, clock: string): number {
  const [year, month, day] = key.split("-").map(Number);
  const [hours, minutes, seconds = 0] = clock.split(":").map(Number);
  return new Date(year, month - 1, day, hours, minutes, seconds).getTime();
}

export class SessionStore {
  constructor(
    private readonly app: App,
    private readonly folder: string,
  ) {}

  private pathFor(key: string): string {
    return normalizePath(`${this.folder}/${key}.md`);
  }

  private async ensureFile(key: string): Promise<TFile> {
    const path = this.pathFor(key);
    const existing = this.app.vault.getFileByPath(path);
    if (existing) return existing;

    const folder = normalizePath(this.folder);
    if (!this.app.vault.getFolderByPath(folder)) {
      await this.app.vault.createFolder(folder);
    }

    return this.app.vault.create(path, `# Time log ${key}\n\n`);
  }

  /** Parses one log file; returns [] when it does not exist. */
  async read(key: string): Promise<Session[]> {
    const file = this.app.vault.getFileByPath(this.pathFor(key));
    if (!file) return [];

    const content = await this.app.vault.cachedRead(file);
    const sessions: Session[] = [];

    for (const line of content.split("\n")) {
      const match = line.match(SESSION_LINE);
      if (!match) continue;

      const [, startClock, endClock, tid, title] = match;
      const start = toEpoch(key, startClock);
      let end: number | null = null;

      if (endClock !== OPEN_MARKER) {
        end = toEpoch(key, endClock);
        // A session that ran past midnight ends on the following day.
        if (end < start) end += 24 * 60 * 60 * 1000;
      }

      sessions.push({ tid, title, start, end, dateKey: key });
    }

    return sessions;
  }

  /** Writes the opening half of a session; the end is filled in on stop. */
  async openSession(tid: string, title: string, start: number): Promise<string> {
    const key = dateKey(new Date(start));
    const file = await this.ensureFile(key);
    const line = `- ${timeOfDay(new Date(start))}–${OPEN_MARKER} [${TID_KEY}:: ${tid}] ${title}`;

    await this.app.vault.process(file, (content) => {
      const body = content.replace(/\s*$/, "");
      return `${body}\n${line}\n`;
    });

    return key;
  }

  /**
   * Closes the open session for `tid` in its log file.
   * Returns the recorded duration in seconds, or null when nothing was open.
   */
  async closeSession(
    tid: string,
    key: string,
    end: number,
  ): Promise<number | null> {
    const file = this.app.vault.getFileByPath(this.pathFor(key));
    if (!file) return null;

    let seconds: number | null = null;

    await this.app.vault.process(file, (content) => {
      const lines = content.split("\n");

      for (let index = lines.length - 1; index >= 0; index--) {
        const match = lines[index].match(SESSION_LINE);
        if (!match || match[3] !== tid || match[2] !== OPEN_MARKER) continue;

        const start = toEpoch(key, match[1]);
        seconds = Math.max(0, Math.round((end - start) / 1000));
        lines[index] = lines[index].replace(
          `–${OPEN_MARKER}`,
          `–${timeOfDay(new Date(end))}`,
        );
        break;
      }

      return lines.join("\n");
    });

    return seconds;
  }

  /** Drops an open session without recording it. */
  async discardSession(tid: string, key: string): Promise<void> {
    const file = this.app.vault.getFileByPath(this.pathFor(key));
    if (!file) return;

    await this.app.vault.process(file, (content) => {
      const lines = content.split("\n");

      for (let index = lines.length - 1; index >= 0; index--) {
        const match = lines[index].match(SESSION_LINE);
        if (match && match[3] === tid && match[2] === OPEN_MARKER) {
          lines.splice(index, 1);
          break;
        }
      }

      return lines.join("\n");
    });
  }

  /** Looks back over recent logs for a session left running. */
  async findOpenSession(days = 7): Promise<Session | null> {
    for (let back = 0; back < days; back++) {
      const date = new Date();
      date.setDate(date.getDate() - back);

      const open = (await this.read(dateKey(date))).find((s) => s.end === null);
      if (open) return open;
    }

    return null;
  }

  /** Total recorded seconds per tid across every log file. */
  async totalsByTid(): Promise<Map<string, number>> {
    const folder = this.app.vault.getFolderByPath(normalizePath(this.folder));
    const totals = new Map<string, number>();
    if (!folder) return totals;

    for (const child of folder.children) {
      if (!(child instanceof TFile) || child.extension !== "md") continue;

      for (const session of await this.read(child.basename)) {
        if (session.end === null) continue;
        const seconds = Math.round((session.end - session.start) / 1000);
        totals.set(session.tid, (totals.get(session.tid) ?? 0) + seconds);
      }
    }

    return totals;
  }
}
