/**
 * Sales follow-up (#21 §9): pure helpers for autotask_create_sales_followup.
 *
 * A sales follow-up is a Company To-Do (CRM calendar item) assigned to the salesperson, linked to the
 * company and, when given, the contact and opportunity. These helpers pick the action type by label and
 * work out when the follow-up is due, so the service method stays thin and the rules are tested directly.
 */
import { addDays, dayIn } from './staff-tools';
import { toUtc } from './appointments';

export interface ActionTypeChoice { value: string | number; label: string; isActive?: boolean | undefined }

export type ActionTypePick = { ok: true; value: number; label: string } | { ok: false; error: string; choices: string[] };

/**
 * The To-Do action type for a follow-up. A requested label must match exactly (case-insensitive) — an
 * unknown label returns the choices and nothing is written. With no label: "Sales", then any label with
 * "sales" or "follow" in it, then "General".
 */
export function pickSalesActionType(picklist: ActionTypeChoice[], requested?: string): ActionTypePick {
  const active = picklist.filter((p) => p.isActive !== false);
  const labels = active.map((p) => String(p.label));
  const hit = (p: ActionTypeChoice | undefined): ActionTypePick | null => (p ? { ok: true, value: Number(p.value), label: String(p.label) } : null);
  const lc = (s: unknown) => String(s ?? '').trim().toLowerCase();
  if (requested != null && String(requested).trim()) {
    return hit(active.find((p) => lc(p.label) === lc(requested)))
      ?? { ok: false, error: `Unknown To-Do action type "${requested}".`, choices: labels };
  }
  return hit(active.find((p) => lc(p.label) === 'sales'))
    ?? hit(active.find((p) => /sales/.test(lc(p.label))))
    ?? hit(active.find((p) => /follow/.test(lc(p.label))))
    ?? hit(active.find((p) => lc(p.label) === 'general'))
    ?? { ok: false, error: 'No "Sales" or "General" To-Do action type in this tenant — pass actionTypeName.', choices: labels };
}

const isWeekend = (day: string): boolean => { const d = new Date(`${day}T00:00:00Z`).getUTCDay(); return d === 0 || d === 6; };

/** The next weekday after `day` (YYYY-MM-DD). */
export function nextBusinessDay(day: string): string {
  let d = addDays(day, 1);
  while (isWeekend(d)) d = addDays(d, 1);
  return d;
}

export type DueResult = { ok: true; start: string; end: string; day: string } | { ok: false; error: string };

/**
 * When the follow-up is due, in UTC. `when` is an offset ISO, a local wall-clock time in `timeZone`, or a
 * bare date (YYYY-MM-DD → `defaultTime` local). `inDays` counts business days from today. With neither:
 * the next business day at `defaultTime`. A due time in the past is refused (a typo, not a follow-up).
 */
export function resolveFollowupDue(o: {
  when?: string | undefined; inDays?: number | undefined; durationMinutes?: number | undefined;
  timeZone: string; defaultTime?: string | undefined; now?: Date | undefined;
}): DueResult {
  const now = o.now ?? new Date();
  const time = /^\d{2}:\d{2}$/.test(o.defaultTime ?? '') ? o.defaultTime! : '09:00';
  const minutes = o.durationMinutes ?? 15;
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 480) return { ok: false, error: 'durationMinutes must be between 1 and 480.' };
  const today = dayIn(now, o.timeZone);
  let local: string;
  if (o.when != null && String(o.when).trim()) {
    const w = String(o.when).trim();
    local = /^\d{4}-\d{2}-\d{2}$/.test(w) ? `${w}T${time}:00` : w;
  } else if (o.inDays != null) {
    const n = Math.floor(Number(o.inDays));
    if (!Number.isFinite(n) || n < 0 || n > 365) return { ok: false, error: 'inDays must be between 0 and 365.' };
    let d = today;
    for (let i = 0; i < n; i++) d = nextBusinessDay(d);
    local = `${d}T${time}:00`;
  } else {
    local = `${nextBusinessDay(today)}T${time}:00`;
  }
  let start: string;
  try { start = toUtc(local, o.timeZone); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  if (Date.parse(start) < now.getTime() - 60 * 60_000) return { ok: false, error: `The due time ${local} (${o.timeZone}) is in the past.` };
  const end = new Date(Date.parse(start) + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { ok: true, start, end, day: dayIn(new Date(start), o.timeZone) };
}
