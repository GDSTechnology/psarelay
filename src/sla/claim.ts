// SLA credit claims (console → SLA credits): turn a month of logged Autotask outages into a credit request for
// Kaseya. Pure — the outage rows, the settings and the month come in; the draft (numbers + plain-text email) goes out.
//
// What counts: an outage where Autotask answered with HTTP 5xx is Autotask's side. One with only network errors /
// timeouts (no HTTP answer) could be this server's own connection, so it is listed apart and not counted unless
// the setting says so. Overlapping outages are merged; each is clipped to the month. Times are UTC.

export interface OutageRow {
  id: number;
  startedAt: string;
  endedAt: string | null;
  lastSeenAt: string;
  confirmedBack: boolean;
  endedReason: string | null;
  failures: number;
  endpoints: string[];
  httpStatuses: number[];
  networkErrors: number;
  lastError: string | null;
}

export interface SlaSettings {
  /** Build a draft on the 1st for the month before. */
  enabled: boolean;
  to: string[];
  cc: string[];
  /** Draft a claim only when the month's counted downtime reaches this many minutes. */
  thresholdMinutes: number;
  /** Account / agreement reference lines put in the email (e.g. company name, account number, contract). */
  reference: string;
  /** The uptime the contract commits to (e.g. 99.9), quoted in the email; null = not quoted. */
  committedUptimePct: number | null;
  /** Count outages with no HTTP answer too (they may be this server's own connection). */
  includeNetworkOnly: boolean;
}

export const DEFAULT_SLA_SETTINGS: SlaSettings = { enabled: false, to: [], cc: [], thresholdMinutes: 5, reference: '', committedUptimePct: null, includeNetworkOnly: false };

export interface ClaimIncident { id: number; start: string; end: string; seconds: number; statuses: number[]; endpoints: string[]; counted: boolean; note: string | null }

export interface ClaimDraft {
  month: string; // YYYY-MM-01
  monthLabel: string; // "November 2026"
  incidents: ClaimIncident[];
  countedIncidents: number;
  downtimeSeconds: number;
  uptimePct: number;
  qualifies: boolean;
  subject: string;
  bodyText: string;
}

const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
export const validEmail = (s: string): boolean => EMAIL.test(s.trim());

/** First day of the month (UTC) for "YYYY-MM" / "YYYY-MM-DD" / a Date. */
export function monthStart(m: string | Date): Date {
  if (m instanceof Date) return new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), 1));
  const x = /^(\d{4})-(\d{2})/.exec(m);
  if (!x || Number(x[2]) < 1 || Number(x[2]) > 12) throw new Error(`not a month: ${m}`);
  return new Date(Date.UTC(Number(x[1]), Number(x[2]) - 1, 1));
}
export const nextMonth = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
export const previousMonth = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
export const monthLabel = (d: Date): string => d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** "1 h 4 min", "3 min 10 s", "40 s". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return r ? `${m} min ${r} s` : `${m} min`;
  const h = Math.floor(m / 60), rm = m % 60;
  return rm ? `${h} h ${rm} min` : `${h} h`;
}

const utc = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/** Build the month's claim from its outage rows. `now` caps a still-open outage. */
export function buildClaim(rows: OutageRow[], month: string | Date, s: SlaSettings, now = Date.now()): ClaimDraft {
  const from = monthStart(month);
  const to = nextMonth(from);
  const lo = from.getTime(), hi = Math.min(to.getTime(), Math.max(lo, now));
  const incidents: ClaimIncident[] = [];
  const spans: Array<[number, number]> = [];
  for (const r of [...rows].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))) {
    const start = Math.max(lo, Date.parse(r.startedAt));
    const endRaw = r.endedAt ? Date.parse(r.endedAt) : Math.max(Date.parse(r.lastSeenAt), Math.min(now, hi));
    const end = Math.min(hi, endRaw);
    if (!(end > start)) continue;
    const autotaskSide = r.httpStatuses.length > 0;
    const counted = autotaskSide || s.includeNetworkOnly;
    const notes = [
      !autotaskSide ? 'no HTTP answer — could be our connection' : null,
      !r.endedAt ? 'still open' : r.endedReason === 'restart' ? 'end = last seen before a restart' : null,
    ].filter(Boolean);
    incidents.push({ id: r.id, start: new Date(start).toISOString(), end: new Date(end).toISOString(), seconds: Math.round((end - start) / 1000), statuses: r.httpStatuses, endpoints: r.endpoints, counted, note: notes.length ? notes.join('; ') : null });
    if (counted) spans.push([start, end]);
  }
  // Merge overlaps so two outages at once aren't counted twice.
  let downtimeMs = 0, curS = -1, curE = -1;
  for (const [a, b] of spans) {
    if (a > curE) { if (curE > curS) downtimeMs += curE - curS; curS = a; curE = b; } else curE = Math.max(curE, b);
  }
  if (curE > curS) downtimeMs += curE - curS;
  const downtimeSeconds = Math.round(downtimeMs / 1000);
  const monthSeconds = (to.getTime() - lo) / 1000;
  const uptimePct = Math.round((1 - downtimeSeconds / monthSeconds) * 1e6) / 1e4;
  const counted = incidents.filter((i) => i.counted);
  const label = monthLabel(from);
  const subject = `SLA credit request — Autotask PSA downtime, ${label}`;

  const line = (i: ClaimIncident) => `  ${utc(Date.parse(i.start))} – ${utc(Date.parse(i.end)).slice(11)}  ${duration(i.seconds).padEnd(12)} ${i.statuses.length ? i.statuses.map((x) => `HTTP ${x}`).join('/') : 'no HTTP answer'}  ${i.endpoints.slice(0, 6).join(', ')}${i.note ? `  (${i.note})` : ''}`;
  const notCounted = incidents.filter((i) => !i.counted);
  const body = [
    'Hello Kaseya Support,',
    '',
    `We are requesting a service credit under our Autotask PSA service level agreement for ${label}.`,
    ...(s.reference.trim() ? ['', ...s.reference.trim().split(/\r?\n/)] : []),
    '',
    `Our Autotask API integration recorded ${counted.length} period${counted.length === 1 ? '' : 's'} in ${label} when Autotask's REST API failed across several modules at once, totalling ${duration(downtimeSeconds)}. ` +
      `That is a measured availability of ${uptimePct.toFixed(3)}% for the month${s.committedUptimePct != null ? `, against the ${s.committedUptimePct}% in our agreement` : ''}.`,
    '',
    'Outages (UTC):',
    ...(counted.length ? counted.map(line) : ['  none']),
    ...(notCounted.length ? ['', 'Also seen, not counted above (no HTTP answer from Autotask, so possibly on our side):', ...notCounted.map(line)] : []),
    '',
    'Each period runs from when our integration detected the failures to when a call next succeeded.',
    'Please confirm the credit and how it will be applied, or let us know what else you need from us.',
    '',
    'Thank you.',
  ].join('\n');

  return {
    month: from.toISOString().slice(0, 10), monthLabel: label, incidents, countedIncidents: counted.length,
    downtimeSeconds, uptimePct, qualifies: downtimeSeconds >= s.thresholdMinutes * 60 && downtimeSeconds > 0,
    subject, bodyText: body,
  };
}

/** Settings from console input (throws a plain message on a bad value). Unknown fields are ignored. */
export function settingsFromInput(b: Record<string, unknown>, prev: SlaSettings): SlaSettings {
  const list = (v: unknown, name: string): string[] => {
    if (v == null) return [];
    const arr = (Array.isArray(v) ? v : String(v).split(/[,;\s]+/)).map((x) => String(x).trim()).filter(Boolean);
    const bad = arr.filter((x) => !validEmail(x));
    if (bad.length) throw new Error(`${name}: not an email address: ${bad.join(', ')}`);
    if (arr.length > 10) throw new Error(`${name}: at most 10 addresses`);
    return [...new Set(arr)];
  };
  const n = (v: unknown, name: string, min: number, max: number): number => {
    const x = Number(v);
    if (!Number.isFinite(x) || x < min || x > max) throw new Error(`${name} must be between ${min} and ${max}`);
    return x;
  };
  const out: SlaSettings = {
    enabled: 'enabled' in b ? b.enabled === true : prev.enabled,
    to: 'to' in b ? list(b.to, 'To') : prev.to,
    cc: 'cc' in b ? list(b.cc, 'Cc') : prev.cc,
    thresholdMinutes: 'thresholdMinutes' in b ? Math.round(n(b.thresholdMinutes, 'Threshold (minutes)', 0, 10_000)) : prev.thresholdMinutes,
    reference: 'reference' in b ? String(b.reference ?? '').slice(0, 1000) : prev.reference,
    committedUptimePct: 'committedUptimePct' in b ? (b.committedUptimePct == null || b.committedUptimePct === '' ? null : n(b.committedUptimePct, 'Committed uptime %', 90, 100)) : prev.committedUptimePct,
    includeNetworkOnly: 'includeNetworkOnly' in b ? b.includeNetworkOnly === true : prev.includeNetworkOnly,
  };
  if (out.enabled && !out.to.length) throw new Error('Add Kaseya\'s address (To) before turning monthly claims on.');
  return out;
}
