import { parseDuration, formatDuration, formatClock } from "../src/duration";
import {
  parseTaskLine,
  isTrackable,
  isDone,
  withSpent,
  withTid,
  findLineByTid,
  generateTid,
} from "../src/task-line";

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

// --- durations -------------------------------------------------------------
check("parse 30m", parseDuration("30m"), 1800);
check("parse 1h", parseDuration("1h"), 3600);
check("parse 1h15m", parseDuration("1h15m"), 4500);
check("parse 1h 15m", parseDuration("1h 15m"), 4500);
check("parse 15", parseDuration("15"), null);
check("parse junk", parseDuration("soon"), null);
check("parse empty", parseDuration(""), null);
check("format 2700", formatDuration(2700), "45m");
check("format 4500", formatDuration(4500), "1h15m");
check("format 3600", formatDuration(3600), "1h");
check("format 30", formatDuration(30), "30s");
check("roundtrip 1h15m", formatDuration(parseDuration("1h15m")!), "1h15m");
check("clock 4500", formatClock(4500), "1:15:00");
check("clock 65", formatClock(65), "1:05");

// --- task lines ------------------------------------------------------------
const real = "- [ ] Draft the quarterly report [estimate:: 1h]";
const parsed = parseTaskLine(real)!;
check("parse estimate", parsed.estimate, 3600);
check("parse spent default", parsed.spent, 0);
check("parse tid absent", parsed.tid, null);
check("parse title", parsed.title, "Draft the quarterly report");
check("trackable", isTrackable(parsed), true);
check("not done", isDone(parsed), false);

check("no estimate -> untrackable", isTrackable(parseTaskLine("- [ ] Something untracked")!), false);
check("non-task line", parseTaskLine("## Plan"), null);
check("bullet without checkbox", parseTaskLine("- a plain bullet"), null);
check("asterisk bullet", parseTaskLine("* [ ] X [estimate:: 30m]")?.estimate, 1800);
check("nested task", parseTaskLine("    - [ ] X [estimate:: 30m]")?.indent, "    ");
check("done task", isDone(parseTaskLine("- [x] X [estimate:: 30m]")!), true);

const stamped = withTid(real, "a1b2c3d4");
check("withTid appends", stamped, "- [ ] Draft the quarterly report [estimate:: 1h] [tid:: a1b2c3d4]");
const spent1 = withSpent(stamped, 2700);
check("withSpent appends", spent1, "- [ ] Draft the quarterly report [estimate:: 1h] [tid:: a1b2c3d4] [spent:: 45m]");
const spent2 = withSpent(spent1, 4500);
check("withSpent replaces in place", spent2, "- [ ] Draft the quarterly report [estimate:: 1h] [tid:: a1b2c3d4] [spent:: 1h15m]");
check("reparse spent", parseTaskLine(spent2)!.spent, 4500);
check("reparse tid", parseTaskLine(spent2)!.tid, "a1b2c3d4");
check("title strips fields", parseTaskLine(spent2)!.title, "Draft the quarterly report");

const doubled = parseTaskLine("- [ ] Grab lunch [[estimate:: 10m]] [tid:: c7f880f2]")!;
check("double-bracketed field still parses", doubled.estimate, 600);
check("double-bracketed field leaves no debris", doubled.title, "Grab lunch");
const parens = parseTaskLine("- [ ] Call the notary (estimate:: 5m)")!;
check("paren-style field parses", parens.estimate, 300);
check("paren-style field leaves no debris", parens.title, "Call the notary");
check("paren-style is trackable", isTrackable(parens), true);
check("plain parentheses survive", parseTaskLine("- [ ] Call (twice) [estimate:: 5m]")!.title, "Call (twice)");
check("paren field normalised on write", withSpent("- [ ] Call (spent:: 1m) [estimate:: 5m]", 120), "- [ ] Call [spent:: 2m] [estimate:: 5m]");

check("trailing space handled", withSpent("- [ ] X [estimate:: 30m]   ", 60), "- [ ] X [estimate:: 30m] [spent:: 1m]");

const doc = ["# Plan", "- [ ] A [estimate:: 30m]", "- [ ] B [estimate:: 1h] [tid:: beef]"].join("\n");
check("findLineByTid hit", findLineByTid(doc, "beef"), 2);
check("findLineByTid miss", findLineByTid(doc, "cafe"), -1);
check("tid length", generateTid().length, 8);

// The session log grammar, mirrored from store.ts.
const SESSION_LINE = new RegExp(
  `^\\s*-\\s+(\\d{1,2}:\\d{2}(?::\\d{2})?)\\s*(?:–|—|--|-)\\s*(\\d{1,2}:\\d{2}(?::\\d{2})?|\\.\\.\\.)\\s+` +
    `\\[tid::\\s*([^\\]\\s]+)\\s*\\]\\s*(.*)$`,
);
const closed = "- 09:12:04–09:47:31 [tid:: a1b2c3] Review the backlog";
check("log closed", closed.match(SESSION_LINE)?.slice(1, 4), ["09:12:04", "09:47:31", "a1b2c3"]);
const open = "- 09:12:04–... [tid:: a1b2c3] Review the backlog";
check("log open", open.match(SESSION_LINE)?.slice(1, 4), ["09:12:04", "...", "a1b2c3"]);
const handEdited = "- 9:12-10:00 [tid:: a1b2c3] edited by hand";
check("log hand-edited", handEdited.match(SESSION_LINE)?.slice(1, 4), ["9:12", "10:00", "a1b2c3"]);
check("log heading ignored", "# Time log 2026-08-27".match(SESSION_LINE), null);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
