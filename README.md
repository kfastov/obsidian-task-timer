# Task Timer

Time tracking for checkbox tasks that carry an estimate. One timer runs at a
time: click a task to start it, click another and the first one pauses and
banks its time. The line changes colour as you approach the estimate.

## The problem this solves

You plan a day as a list of tasks with estimates, then work them **interleaved** —
twenty minutes here, a phone call, back to the first task, something urgent, back
again. By evening you genuinely cannot say whether the task you budgeted an hour
for took forty minutes or two and a half hours. The estimate stops being a budget
and becomes decoration.

Stopwatch plugins do not fix this, because the moment you switch tasks without
stopping the previous timer the day's numbers are worthless. What makes the
difference is a single-timer invariant enforced by the plugin rather than by your
discipline: starting a timer anywhere always closes whatever was running.

Task Timer keeps a running total per task, writes it back into the task line, and
colours the line yellow at 80% of the estimate and red past 100% — so an overrun
is something you notice while it is happening, not during a post-mortem.

## Who it is for

People who plan the day as markdown checkbox tasks in a daily note, put an
estimate on each one, and switch between them constantly. If you work one task
to completion before touching the next, a simpler stopwatch will serve you fine.
If your tasks live one-per-note, this is the wrong shape — the plugin tracks
individual task *lines*.

## Prerequisites

**Tasks must carry an estimate.** The timer button only appears on checkbox
tasks with an `estimate` inline field:

```markdown
- [ ] Draft the quarterly report [estimate:: 1h]
- [ ] Review the backlog [estimate:: 30m]
- [ ] Fix the flaky integration test [estimate:: 1h30m]
```

This is deliberate — the estimate is what makes the colour and the budget
meaningful. Tasks without one are ignored entirely, so a daily note can freely
mix tracked work with ordinary checkboxes.

Accepted duration units: `s`, `m`/`min`, `h`/`hr`, `d`, in any combination —
`45m`, `2h`, `1h30m`, `1h 30m`.

Any list marker works (`-`, `*`, `+`), nesting and indentation are fine.

**Dataview is optional.** The plugin has no dependency on it, but the fields it
writes are Dataview inline fields, so if you have it installed you get roll-up
tables for free (see [Working with Dataview](#working-with-dataview)) and the
bookkeeping field is hidden from rendered output.

## What it writes

Two inline fields are added to the task line:

```markdown
- [ ] Draft the quarterly report [estimate:: 1h] [tid:: a1b2c3d4] [spent:: 45m]
```

* **`tid`** — a stable identifier. It survives rewording the task and moving the
  line to another note, which is what lets time accumulate *per task* rather than
  per day: carry an unfinished task into tomorrow's daily note and it resumes with
  its total intact. With Dataview installed, this field is hidden in reading view.
* **`spent`** — the running total, in a format Dataview parses as a duration, so
  it sums alongside `estimate` in queries.

Every session is also appended to a per-day log, one line each:

```markdown
- 09:12:04–09:47:31 [tid:: a1b2c3d4] Draft the quarterly report
- 09:47:31–10:05:12 [tid:: 9ca04b3e] Review the backlog
- 10:05:12–...      [tid:: a1b2c3d4] Draft the quarterly report
```

`...` marks the session running right now. The log is the audit trail and the
repair surface: it is plain markdown, so a bad entry is fixed by editing the line
and running **Recalculate spent from the log**, which rewrites every `spent`
field from the logged sessions.

## Colour coding

The task line is tinted by `spent / estimate` — yellow from 80%, red from 100%,
both thresholds configurable. While a timer runs, the current session counts
toward the colour and the line refreshes every fifteen seconds. The active task
also carries an accent bar on its left edge.

Tints are translucent, so they layer over your theme rather than fighting it.

## Commands

| Command | What it does |
| --- | --- |
| Start or pause the timer on the task at the cursor | Same as clicking ▶/⏸. Worth a hotkey. |
| Stop the running timer | Works from anywhere; clicking the status bar does the same. |
| Recalculate spent from the log | Rewrites every task's `spent` as the sum of its logged sessions. |

The status bar shows the active task and its running time.

## Behaviour at the edges

* **Obsidian closed, or the machine asleep** — time keeps accruing. This is
  intentional: work that happens away from the computer still counts. The
  trade-off is that a timer forgotten overnight records the whole night; fix the
  log line and run **Recalculate spent from the log**.
* **A task is checked off** — its timer stops automatically. The work is
  finished, not paused.
* **Sessions under a minute** are discarded, so a mistaken click leaves no trace.
  The threshold is configurable.
* **A session crossing midnight** stays in the log file of the day it started.
* **Crash or restart mid-session** — the running timer is restored on load, from
  the plugin state or, failing that, from the open session in the log.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Log folder | `Time Log` | One markdown file per day. Created on first use. |
| Warning threshold | 80% | Where the line turns yellow. |
| Over-budget threshold | 100% | Where it turns red. |
| Minimum session length | 60s | Shorter sessions are discarded. |

## Working with Dataview

Because `estimate` and `spent` are both Dataview durations, a daily note can
summarise itself:

````markdown
```dataview
TABLE WITHOUT ID
  sum(rows.task.estimate) AS "Planned",
  sum(filter(rows.task, (t) => t.spent).spent) AS "Spent",
  sum(filter(rows.task, (t) => !t.completed).estimate) AS "Remaining"
WHERE file.path = this.file.path
FLATTEN file.tasks AS task
WHERE task.estimate != null
GROUP BY true
```
````

Or find everything that blew its budget across the vault:

````markdown
```dataview
TASK
WHERE estimate AND spent AND spent > estimate
SORT spent - estimate DESC
```
````

## Installation

Not in the community plugin registry yet.

**Manually:** download `main.js`, `manifest.json` and `styles.css` from the
[latest release](https://github.com/kfastov/obsidian-task-timer/releases), drop
them into `<vault>/.obsidian/plugins/task-timer/`, and enable the plugin under
Settings → Community plugins.

**With [BRAT](https://github.com/TfTHacker/obsidian42-brat):** add
`kfastov/obsidian-task-timer` as a beta plugin.

## Limitations

* Buttons and colouring live in the editor (Live Preview and source mode).
  Reading view is not covered yet.
* Not tested on mobile, though nothing in it is desktop-only.
* One timer, by design. There is no way to run two tasks at once.

## Development

```bash
npm install
npm run dev                              # watch build into ./dist
OBSIDIAN_VAULT=~/Notes npm run dev       # watch build straight into a vault
npm run build                            # production build
npm test                                 # unit + integration checks
npm run typecheck
```

`npm test` runs the parsers against their edge cases and drives the tracker
through a full interleaved day on an in-memory vault: switching tasks, resuming,
discarded stray clicks, hand-edited logs, and restarts with a timer left running.

## License

MIT
