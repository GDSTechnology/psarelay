/**
 * Appointments (#21 §5): pure helpers for the appointment tools.
 *
 * Appointments are first-class calendar entries on a resource (resourceID, title, description,
 * startDateTime, endDateTime). Scheduled work is booked as an appointment, never as a future time
 * entry. Callers may give local wall-clock times plus a timezone; everything is stored in UTC and
 * returned with both UTC and local times.
 */
import { hasOffset, zonedLocalToUTC } from './timezone';
import { addDays, dayIn, localDayWindow } from './staff-tools';

const isoSeconds = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** "YYYY-MM-DDTHH:MM:SS" — the wall-clock time `iso` shows in `timeZone`. */
export function localWallClock(iso: string, timeZone: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).reduce<Record<string, string>>((acc, x) => { if (x.type !== 'literal') acc[x.type] = x.value; return acc; }, {});
  const hour = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}`;
}

/** A UTC instant from an offset ISO (used as-is) or a local wall-clock time in `timeZone`. */
export function toUtc(value: string, timeZone: string): string {
  const s = value.trim();
  if (hasOffset(s)) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw new Error(`Unparseable datetime: "${value}"`);
    return isoSeconds(d);
  }
  return isoSeconds(zonedLocalToUTC(s, timeZone));
}

export type TimesResult = { ok: true; start: string; end: string } | { ok: false; error: string };

/**
 * Start / end of an appointment in UTC: start + (end or durationMinutes). End must be after start.
 * Never more than 14 days long (a typo in a date, not a real appointment).
 */
export function resolveTimes(o: { startDateTime?: string | undefined; endDateTime?: string | undefined; durationMinutes?: number | undefined; timeZone: string }): TimesResult {
  if (!o.startDateTime) return { ok: false, error: 'startDateTime is required.' };
  let start: string;
  try { start = toUtc(o.startDateTime, o.timeZone); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  let end: string;
  if (o.endDateTime) {
    try { end = toUtc(o.endDateTime, o.timeZone); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  } else if (o.durationMinutes != null && Number(o.durationMinutes) > 0) {
    end = isoSeconds(new Date(Date.parse(start) + Number(o.durationMinutes) * 60_000));
  } else {
    return { ok: false, error: 'Give endDateTime or durationMinutes.' };
  }
  const ms = Date.parse(end) - Date.parse(start);
  if (!(ms > 0)) return { ok: false, error: `The end (${end}) must be after the start (${start}).` };
  if (ms > 14 * 86_400_000) return { ok: false, error: 'An appointment can be at most 14 days long — check the dates.' };
  return { ok: true, start, end };
}

/** The appointment with local times, its duration and the timezone they are shown in. */
export function withLocalTimes<T extends Record<string, unknown>>(a: T, timeZone: string): T & { startLocal: string | null; endLocal: string | null; durationMinutes: number | null; timeZone: string } {
  const s = typeof a.startDateTime === 'string' ? a.startDateTime : null;
  const e = typeof a.endDateTime === 'string' ? a.endDateTime : null;
  const ms = s && e ? Date.parse(e) - Date.parse(s) : NaN;
  return {
    ...a,
    startLocal: s ? localWallClock(s, timeZone) : null,
    endLocal: e ? localWallClock(e, timeZone) : null,
    durationMinutes: Number.isFinite(ms) ? Math.round(ms / 60_000) : null,
    timeZone,
  };
}

export interface BusyBlock { kind: 'appointment' | 'service_call'; id: number; title?: string | null; start: string; end: string }

/** True when [aStart, aEnd) and [bStart, bEnd) share any time (touching ends do not overlap). */
export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return Date.parse(aStart) < Date.parse(bEnd) && Date.parse(bStart) < Date.parse(aEnd);
}

/** The busy blocks that overlap [start, end), excluding one appointment id (the one being moved). */
export function conflictsWith(busy: BusyBlock[], start: string, end: string, excludeAppointmentId?: number): BusyBlock[] {
  return busy.filter((b) => !(b.kind === 'appointment' && excludeAppointmentId != null && b.id === excludeAppointmentId) && overlaps(b.start, b.end, start, end));
}

/** Each local day from `from` to `to` (inclusive, YYYY-MM-DD). */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 62; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The UTC window covering local days `from`..`to` in `timeZone`. */
export function localDaysWindow(from: string, to: string, timeZone: string): { start: string; end: string } {
  return { start: localDayWindow(from, timeZone).start, end: localDayWindow(to, timeZone).end };
}

export interface FreeSlot { start: string; end: string; startLocal: string | null; endLocal: string | null; minutes: number }

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * Free time inside working hours on each local day, after removing the busy blocks.
 * workdayStart / workdayEnd are local "HH:MM"; weekends are skipped unless includeWeekends.
 * Slots shorter than minMinutes are dropped; slots before `now` are cut at `now`.
 */
export function freeSlots(o: {
  busy: BusyBlock[]; days: string[]; timeZone: string; workdayStart: string; workdayEnd: string;
  minMinutes: number; includeWeekends?: boolean | undefined; now?: Date | undefined;
}): FreeSlot[] {
  if (!HHMM.test(o.workdayStart) || !HHMM.test(o.workdayEnd)) throw new Error('workdayStart / workdayEnd must be "HH:MM".');
  const pad = (t: string) => t.padStart(5, '0');
  const nowMs = (o.now ?? new Date()).getTime();
  const blocks = o.busy.map((b) => [Date.parse(b.start), Date.parse(b.end)] as const).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: FreeSlot[] = [];
  for (const day of o.days) {
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (!o.includeWeekends && (weekday === 0 || weekday === 6)) continue;
    let cursor = Math.max(zonedLocalToUTC(`${day}T${pad(o.workdayStart)}:00`, o.timeZone).getTime(), nowMs);
    const dayEnd = zonedLocalToUTC(`${day}T${pad(o.workdayEnd)}:00`, o.timeZone).getTime();
    const push = (a: number, b: number) => {
      if (b - a >= o.minMinutes * 60_000) {
        const s = isoSeconds(new Date(a)); const e = isoSeconds(new Date(b));
        out.push({ start: s, end: e, startLocal: localWallClock(s, o.timeZone), endLocal: localWallClock(e, o.timeZone), minutes: Math.round((b - a) / 60_000) });
      }
    };
    for (const [bs, be] of blocks) {
      if (be <= cursor || bs >= dayEnd) continue;
      if (bs > cursor) push(cursor, Math.min(bs, dayEnd));
      cursor = Math.max(cursor, be);
      if (cursor >= dayEnd) break;
    }
    if (cursor < dayEnd) push(cursor, dayEnd);
  }
  return out;
}

/** Today in `timeZone` (YYYY-MM-DD). */
export const todayIn = (timeZone: string, now: Date = new Date()): string => dayIn(now, timeZone);
