/**
 * Durations are handled in seconds internally and rendered in the same shape
 * Dataview parses (`number + unit`, repeated): `30m`, `1h`, `1h15m`.
 */

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  d: 86400,
  day: 86400,
  days: 86400,
};

const TERM = /(\d+(?:\.\d+)?)\s*([a-z]+)/gi;

/** Returns seconds, or null when the string holds no recognisable term. */
export function parseDuration(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;

  let total = 0;
  let matched = false;
  TERM.lastIndex = 0;

  for (const match of text.matchAll(TERM)) {
    const factor = UNIT_SECONDS[match[2]];
    if (factor === undefined) return null;
    total += Number.parseFloat(match[1]) * factor;
    matched = true;
  }

  return matched ? Math.round(total) : null;
}

/** `4500` -> `1h15m`. Rounds to whole minutes above a minute. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;

  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h${minutes}m`;
}

/** `4500` -> `1:15:00`, for the always-visible status bar readout. */
export function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  const pad = (value: number) => String(value).padStart(2, "0");

  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(secs)}`
    : `${minutes}:${pad(secs)}`;
}
