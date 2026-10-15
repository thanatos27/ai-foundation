/**
 * Date / time-zone arithmetic on ISO 8601 strings, built on Intl only.
 *
 * - "date": `YYYY-MM-DD` (a calendar day, no time zone)
 * - "date-time": ISO 8601 with an explicit offset or `Z`
 * - "local date-time": `YYYY-MM-DDTHH:mm:ss` without offset, interpreted in a given IANA zone
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const pad = (n: number, width = 2) => String(Math.trunc(Math.abs(n))).padStart(width, '0');

function parseDate(date: string): number {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day);
}

function formatDate(utcMs: number): string {
  const d = new Date(utcMs);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Adds whole days to a date. */
export function addDays(date: string, days: number): string {
  return formatDate(parseDate(date) + days * DAY_MS);
}

/** Offset (minutes east of UTC) written in a date-time string, e.g. `+09:00` → 540, `Z` → 0. */
function offsetOf(dateTime: string): number {
  const match = /(Z|([+-])(\d{2}):?(\d{2}))$/i.exec(dateTime);
  if (!match || match[1]!.toUpperCase() === 'Z') return 0;
  const minutes = Number(match[3]) * 60 + Number(match[4]);
  return match[2] === '-' ? -minutes : minutes;
}

/** Formats an instant as a date-time in a fixed offset, e.g. `2026-10-17T14:00:00+09:00`. */
function formatWithOffset(instantMs: number, offsetMinutes: number): string {
  const local = new Date(instantMs + offsetMinutes * MINUTE_MS);
  const sign = offsetMinutes < 0 ? '-' : '+';
  return (
    `${formatDate(local.getTime())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `${sign}${pad(offsetMinutes / 60)}:${pad(offsetMinutes % 60)}`
  );
}

/** Adds hours to a date-time, keeping the offset it was written in. */
export function addHoursKeepingOffset(dateTime: string, hours: number): string {
  return formatWithOffset(Date.parse(dateTime) + hours * HOUR_MS, offsetOf(dateTime));
}

/** Offset (minutes east of UTC) of `timeZone` at `instantMs`. */
export function timeZoneOffset(timeZone: string, instantMs: number): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(instantMs)
    .find((part) => part.type === 'timeZoneName')?.value;
  const match = /GMT(?:([+-])(\d{2}):(\d{2}))?/.exec(name ?? '');
  if (!match?.[1]) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

/** Formats an instant as a date-time in `timeZone`'s offset at that instant. */
export function formatInTimeZone(instantMs: number, timeZone: string): string {
  return formatWithOffset(instantMs, timeZoneOffset(timeZone, instantMs));
}

/**
 * Instant of a local date-time in `timeZone`. Times skipped by a DST jump resolve forward by the
 * length of the gap (02:30 in a 02:00→03:00 gap becomes 03:30), repeated times resolve to the
 * earlier occurrence.
 */
export function zonedDateTimeToInstant(localDateTime: string, timeZone: string): number {
  const wallClock = Date.parse(`${localDateTime}Z`);
  // The offsets in force a day either side bracket any single transition around this time.
  const offsetBefore = timeZoneOffset(timeZone, wallClock - DAY_MS);
  const offsetAfter = timeZoneOffset(timeZone, wallClock + DAY_MS);
  const candidates = [offsetBefore, offsetAfter]
    .map((offset) => wallClock - offset * MINUTE_MS)
    // A candidate is real when the zone, at that instant, shows the requested wall-clock time.
    .filter((instant) => instant + timeZoneOffset(timeZone, instant) * MINUTE_MS === wallClock);

  if (candidates.length > 0) return Math.min(...candidates);
  // Skipped by a gap: keep the offset from before the transition, which lands after the gap.
  return wallClock - offsetBefore * MINUTE_MS;
}

/** Instant at which `date` begins in `timeZone`. */
export function startOfDay(date: string, timeZone: string): number {
  return zonedDateTimeToInstant(`${date}T00:00:00`, timeZone);
}

/** Calendar date of an instant in `timeZone`. */
export function localDateOf(instantMs: number, timeZone: string): string {
  return formatInTimeZone(instantMs, timeZone).slice(0, 10);
}

/** Date-time as UTC without milliseconds, e.g. `2026-10-17T05:00:00Z`. */
export function toUtcDateTime(dateTime: string): string {
  return new Date(Date.parse(dateTime)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
