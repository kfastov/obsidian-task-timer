import { SessionStore } from "../src/store";
import { Tracker } from "../src/tracker";
import { parseTaskLine } from "../src/task-line";
import { formatDuration } from "../src/duration";
import { FakeApp, notices } from "./obsidian-stub";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.log(`FAIL ${label}\n  got:      ${a}\n  expected: ${e}`);
  } else {
    console.log(`ok   ${label} -> ${a}`);
  }
}

// A controllable clock, starting 2026-08-27 09:00:00 local.
let now = new Date(2026, 7, 27, 9, 0, 0).getTime();
Date.now = () => now;
const advance = (minutes: number) => {
  now += minutes * 60_000;
};

const DAILY = "Daily/2026-08-27.md";
const SETTINGS = {
  logFolder: "Time Log",
  warnPercent: 80,
  overPercent: 100,
  minSessionSeconds: 60,
};

/** The line is refreshed while a timer runs, without inflating the total. */
async function liveUpdates(): Promise<void> {
  console.log("\n--- live spent updates ---");

  const app = new FakeApp();
  app.vault.add(
    DAILY,
    ["## Plan", "", "- [ ] Draft the quarterly report [estimate:: 1h]", ""].join("\n"),
  );

  const file = app.vault.getFileByPath(DAILY)! as never;
  const store = new SessionStore(app as never, SETTINGS.logFolder);
  const tracker = new Tracker(app as never, store, SETTINGS, async () => {});

  const line = () => app.vault.getFileByPath(DAILY)!.content.split("\n")[2];
  const spent = () => parseTaskLine(line())?.spent ?? 0;

  await tracker.startAtLine(file, 2);
  check("nothing written at the start", /spent::/.test(line()), false);

  advance(0.5);
  await tracker.syncSpent();
  check("still nothing under the minimum session", /spent::/.test(line()), false);

  advance(9.5);
  await tracker.syncSpent();
  check("line shows the running total", formatDuration(spent()), "10m");

  await tracker.syncSpent();
  check("repeat sync is a no-op", formatDuration(spent()), "10m");

  advance(5);
  await tracker.syncSpent();
  check("total keeps climbing", formatDuration(spent()), "15m");

  // What the editor and the zen view show must track the file, not double it.
  check(
    "display matches the line, not twice it",
    formatDuration(tracker.displaySpent(parseTaskLine(line())!.tid, spent())),
    "15m",
  );

  advance(5);
  check(
    "display keeps up between writes",
    formatDuration(tracker.displaySpent(parseTaskLine(line())!.tid, spent())),
    "20m",
  );
  check("the line itself lags until the next sync", formatDuration(spent()), "15m");

  await tracker.stop();
  check("stop does not double count", formatDuration(spent()), "20m");
  check(
    "display falls back to the line once stopped",
    formatDuration(tracker.displaySpent(parseTaskLine(line())!.tid, spent())),
    "20m",
  );

  // Resuming must build on the committed total, not restart from it.
  advance(1);
  await tracker.startAtLine(file, 2);
  advance(10);
  await tracker.syncSpent();
  check("second session accumulates on top", formatDuration(spent()), "30m");
  advance(2);
  await tracker.stop();
  check("second stop is exact", formatDuration(spent()), "32m");

  // Switching away mid-session banks the exact elapsed time, once.
  app.vault.getFileByPath(DAILY)!.content += "\n- [ ] Review the backlog [estimate:: 30m]";
  await tracker.startAtLine(file, 2);
  advance(6);
  await tracker.syncSpent();
  await tracker.startAtLine(file, 4);
  check("switching banks the exact total", formatDuration(spent()), "38m");
  await tracker.stop();

  // A restart mid-session recovers the baseline from the log, not the line.
  await tracker.startAtLine(file, 2);
  advance(4);
  await tracker.syncSpent();
  check("line carries the live figure", formatDuration(spent()), "42m");

  const revived = new Tracker(app as never, store, SETTINGS, async () => {});
  await revived.restore(null);
  advance(3);
  await revived.stop();
  check("restarted timer does not double count", formatDuration(spent()), "45m");
}

async function main(): Promise<void> {
  const app = new FakeApp();
  app.vault.add(
    DAILY,
    [
      "## Plan",
      "",
      "- [ ] Review the backlog [estimate:: 30m]",
      "- [ ] Draft the quarterly report [estimate:: 1h]",
      "- [ ] Untracked task without an estimate",
      "",
    ].join("\n"),
  );

  const file = app.vault.getFileByPath(DAILY)! as never;
  const store = new SessionStore(app as never, SETTINGS.logFolder);
  let persisted: unknown = undefined;
  const tracker = new Tracker(
    app as never,
    store,
    SETTINGS,
    async (active) => {
      persisted = active;
    },
  );

  const line = (index: number) => app.vault.getFileByPath(DAILY)!.content.split("\n")[index];
  const spentOf = (index: number) => parseTaskLine(line(index))?.spent ?? 0;
  const logContent = () =>
    app.vault.getFileByPath("Time Log/2026-08-27.md")?.content ?? "";

  // --- a task without an estimate is not trackable --------------------------
  await tracker.startAtLine(file, 4);
  check("no estimate -> no timer", tracker.getActive(), null);
  check("no estimate -> line untouched", line(4), "- [ ] Untracked task without an estimate");

  // --- starting the first task ---------------------------------------------
  await tracker.startAtLine(file, 2);
  const tid1 = tracker.getActive()?.tid ?? "";
  check("timer running", tracker.getActive() !== null, true);
  check("tid written into the line", /\[tid:: [0-9a-f]{8}\]/.test(line(2)), true);
  check("open session logged", logContent().includes(`–... [tid:: ${tid1}]`), true);
  check("state persisted", (persisted as { tid: string } | null)?.tid, tid1);

  // --- switching tasks closes the first one --------------------------------
  advance(10);
  await tracker.startAtLine(file, 3);
  const tid2 = tracker.getActive()?.tid ?? "";
  check("second task now active", tracker.getActive()?.tid === tid2 && tid2 !== tid1, true);
  check("first task got its spent", formatDuration(spentOf(2)), "10m");
  check("first session closed in log", logContent().includes(`09:00:00–09:10:00 [tid:: ${tid1}]`), true);
  check("only one open session", (logContent().match(/–\.\.\./g) ?? []).length, 1);

  // --- stopping ------------------------------------------------------------
  advance(5);
  await tracker.stop();
  check("no active timer", tracker.getActive(), null);
  check("second task spent", formatDuration(spentOf(3)), "5m");
  check("no open sessions left", (logContent().match(/–\.\.\./g) ?? []).length, 0);
  check("persisted cleared", persisted, null);

  // --- resuming the first task accumulates ---------------------------------
  advance(2);
  await tracker.startAtLine(file, 2);
  advance(25);
  await tracker.stop();
  check("first task accumulated", formatDuration(spentOf(2)), "35m");
  check("over its 30m estimate", spentOf(2) > 1800, true);
  check("three sessions in log", (logContent().match(/\[tid::/g) ?? []).length, 3);

  // --- toggle on the running task pauses it --------------------------------
  await tracker.toggleAtLine(file, 3);
  check("toggle started it", tracker.getActive()?.tid, tid2);
  advance(3);
  await tracker.toggleAtLine(file, 3);
  check("toggle stopped it", tracker.getActive(), null);
  check("second task accumulated", formatDuration(spentOf(3)), "8m");

  // --- a stray click is discarded, not recorded ----------------------------
  const beforeStray = logContent();
  await tracker.startAtLine(file, 2);
  advance(0.2); // 12 seconds, under minSessionSeconds
  await tracker.stop();
  check("stray session discarded from log", logContent().trim(), beforeStray.trim());
  check("stray session left spent alone", formatDuration(spentOf(2)), "35m");

  // --- a forgotten timer fixed by hand, then recomputed --------------------
  const logFile = app.vault.getFileByPath("Time Log/2026-08-27.md")!;
  logFile.content = logFile.content.replace(
    `09:00:00–09:10:00 [tid:: ${tid1}]`,
    `09:00:00–09:05:00 [tid:: ${tid1}]`,
  );
  const updated = await tracker.recomputeFromLog();
  check("recompute touched lines", updated >= 1, true);
  check("spent follows the hand-edited log", formatDuration(spentOf(2)), "30m");
  check("other task recomputed too", formatDuration(spentOf(3)), "8m");

  // --- a timer left running is restored across a restart -------------------
  await tracker.startAtLine(file, 3);
  const saved = tracker.getActive();
  const revived = new Tracker(app as never, store, SETTINGS, async () => {});
  advance(7);
  await revived.restore(saved);
  check("restored the running task", revived.getActive()?.tid, tid2);
  check("wall clock kept accruing", Math.round(revived.elapsed() / 60), 7);

  // --- and restored from the log alone when settings were lost -------------
  const fromLog = new Tracker(app as never, store, SETTINGS, async () => {});
  await fromLog.restore(null);
  check("recovered open session from log", fromLog.getActive()?.tid, tid2);
  check("found the source file by tid", fromLog.getActive()?.sourcePath, DAILY);

  await liveUpdates();

  check("no notices raised", notices, []);
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
  if (failures > 0) process.exit(1);
}

void main();
