// Customer re-engagement: "which customer companies haven't we contacted recently?"
// For Sales / Account Management. Answered from the Postgres mirror in three SQL reads
// (0 Autotask calls) — per company the latest CUSTOMER-FACING touchpoint inside the window
// and the latest before it, the active customer companies, and their active contacts.
//
// What counts as a touchpoint (only by a PERSON — a licensed user, per the actor
// classification; resource 4 "Autotask Administrator", API users and this MCP's own API
// user never count):
//   ticket note    TicketNotes with publish = 1 (All Autotask Users = client-visible), on a ticket of the company;
//   time entry     time on a ticket of the company, or on a task of one of its projects;
//   CRM to-do      a completed CompanyToDo (completedDate);
//   opportunity    an opportunity's last activity (else its creation), owner = a person;
//   service call   a service call that started (not cancelled), created by a person.
// Weak signals — shown, never counted as "last contact": a To-Do completed at minute :17
// (an hourly automation completes To-Dos then) or assigned to a non-person; an opportunity
// or service call whose owner / creator isn't a person.
// Company 0 (the tenant's own company) is never a customer; placeholder companies ("Gmail",
// "Unknown…") are left out unless asked for.

import type { Pool } from 'pg';
import { ShadowStore, type Freshness } from '../db/shadow-store.js';
import { classifierFrom, type Classify } from '../bulk/activity.js';
import { parseReference, parseRegistry, type ActorRecord, type ClassifyContext } from '../utils/actor-classify.js';
import { settingValue } from '../admin/settings.js';
import { isPlaceholderCompany, isPlaceholderContact } from '../merge/model.js';

export const TOUCHPOINT_TYPES = ['ticket note', 'time entry', 'CRM to-do', 'opportunity', 'service call'] as const;
export type TouchpointType = typeof TOUCHPOINT_TYPES[number];

/** Autotask's standard company types (Companies.companyType). */
export const COMPANY_TYPES: Record<number, string> = { 1: 'Customer', 2: 'Lead', 3: 'Prospect', 4: 'Dead', 6: 'Cancellation', 7: 'Vendor', 8: 'Partner' };


/** "2026-10-01" + n days (UTC, no time-zone drift). */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** A date-ish text column as a timestamp (minute precision); NULL when it isn't a date. */
const TS = (e: string) => `(CASE WHEN ${e} ~ '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d' THEN (left(${e}, 16) || ':00')::timestamp WHEN ${e} ~ '^\\d{4}-\\d\\d-\\d\\d$' THEN (${e})::timestamp END)`;
/** An id text column as bigint; NULL when it isn't one. */
const INT = (e: string) => `(CASE WHEN ${e} ~ '^\\d+$' THEN (${e})::bigint END)`;
const live = (alias: string, entity: string) => `${alias}.entity = '${entity}' AND ${alias}.deleted_at IS NULL`;
const HUMAN = (e: string) => `coalesce(${INT(e)} = ANY($3::bigint[]), false)`;

/**
 * One UNION branch per touchpoint type: (type, company, who, ts, rec, ref, title, weak).
 * $3 = the person resource ids. Static SQL only — nothing caller-supplied is spliced in.
 */
const BRANCHES: Record<TouchpointType, string[]> = {
  'ticket note': [`
      SELECT 'ticket note' AS type, tk.data->>'companyID' AS company, ${INT("n.data->>'creatorResourceID'")} AS who, ${TS("n.data->>'createDateTime'")} AS ts,
             n.id AS rec, tk.data->>'ticketNumber' AS ref, left(coalesce(n.data->>'title', tk.data->>'title'), 120) AS title, false AS weak
        FROM shadow_record n
        JOIN shadow_record tk ON ${live('tk', 'Tickets')} AND tk.id = ${INT("n.data->>'ticketID'")}
       WHERE ${live('n', 'TicketNotes')} AND (n.data->>'publish') = '1' AND ${HUMAN("n.data->>'creatorResourceID'")}`],
  'time entry': [`
      SELECT 'time entry', tk.data->>'companyID', ${INT("t.data->>'resourceID'")}, ${TS("coalesce(t.data->>'startDateTime', t.data->>'dateWorked')")},
             t.id, tk.data->>'ticketNumber', left(tk.data->>'title', 120), false
        FROM shadow_record t
        JOIN shadow_record tk ON ${live('tk', 'Tickets')} AND tk.id = ${INT("t.data->>'ticketID'")}
       WHERE ${live('t', 'TimeEntries')} AND ${HUMAN("t.data->>'resourceID'")}`, `
      SELECT 'time entry', p.data->>'companyID', ${INT("t.data->>'resourceID'")}, ${TS("coalesce(t.data->>'startDateTime', t.data->>'dateWorked')")},
             t.id, coalesce(ta.data->>'taskNumber', p.data->>'projectNumber'), left(coalesce(ta.data->>'title', p.data->>'projectName'), 120), false
        FROM shadow_record t
        JOIN shadow_record ta ON ${live('ta', 'Tasks')} AND ta.id = ${INT("t.data->>'taskID'")}
        JOIN shadow_record p ON ${live('p', 'Projects')} AND p.id = ${INT("ta.data->>'projectID'")}
       WHERE ${live('t', 'TimeEntries')} AND ${INT("t.data->>'ticketID'")} IS NULL AND ${HUMAN("t.data->>'resourceID'")}`],
  'CRM to-do': [`
      SELECT 'CRM to-do', d.data->>'companyID', ${INT("d.data->>'assignedToResourceID'")}, ${TS("d.data->>'completedDate'")},
             d.id, NULL, left(d.data->>'activityDescription', 120),
             (NOT ${HUMAN("d.data->>'assignedToResourceID'")}) OR extract(minute FROM ${TS("d.data->>'completedDate'")}) = 17
        FROM shadow_record d
       WHERE ${live('d', 'CompanyToDos')} AND d.data->>'completedDate' IS NOT NULL`],
  'opportunity': [`
      SELECT 'opportunity', o.data->>'companyID', ${INT("o.data->>'ownerResourceID'")}, ${TS("coalesce(o.data->>'lastActivity', o.data->>'lastActivityDate', o.data->>'createDate')")},
             o.id, NULL, left(o.data->>'title', 120), NOT ${HUMAN("o.data->>'ownerResourceID'")}
        FROM shadow_record o
       WHERE ${live('o', 'Opportunities')}`],
  'service call': [`
      SELECT 'service call', s.data->>'companyID', ${INT("s.data->>'creatorResourceID'")}, ${TS("s.data->>'startDateTime'")},
             s.id, NULL, left(s.data->>'description', 120), NOT ${HUMAN("s.data->>'creatorResourceID'")}
        FROM shadow_record s
       WHERE ${live('s', 'ServiceCalls')} AND s.data->>'canceledDateTime' IS NULL`],
};

/**
 * The touchpoint query: per company, the latest touchpoint inside the window and before it,
 * strong and weak apart (≤ 4 rows per company), with counts. $1 = from (inclusive), $2 = the
 * day after "to" (exclusive), $3 = person resource ids. Future-dated rows never count.
 */
export function touchpointSql(types: readonly TouchpointType[]): string {
  const branches = types.flatMap((t) => BRANCHES[t]);
  if (!branches.length) throw new Error('No touchpoint types selected.');
  return `
    WITH ev AS (${branches.join('\n      UNION ALL')}
    ), b AS (
      SELECT ev.*, ev.ts >= $1::timestamp AS in_window FROM ev
       WHERE ev.ts IS NOT NULL AND ev.ts < $2::timestamp AND ev.ts <= now()::timestamp
         AND ev.company ~ '^\\d+$' AND ev.company <> '0'
    ), latest AS (
      SELECT DISTINCT ON (company, in_window, weak) company, in_window, weak, type, who, ts, rec, ref, title
        FROM b ORDER BY company, in_window, weak, ts DESC, rec DESC
    ), counts AS (
      SELECT company, count(*) FILTER (WHERE in_window AND NOT weak)::int AS n_in, count(*) FILTER (WHERE in_window AND weak)::int AS n_weak FROM b GROUP BY company
    )
    SELECT l.company, l.in_window, l.weak, l.type, l.who::text AS who, to_char(l.ts, 'YYYY-MM-DD"T"HH24:MI') AS at, l.rec::text AS rec, l.ref, l.title, c.n_in, c.n_weak
      FROM latest l JOIN counts c USING (company)`;
}

/** Active companies of the given types; never company 0. $1 = types (text), $2 = company ids or NULL. */
export const COMPANIES_SQL = `
    SELECT id::text AS id, data->>'companyName' AS name, data->>'companyType' AS type, data->>'phone' AS phone, data->>'ownerResourceID' AS owner
      FROM shadow_record
     WHERE entity = 'Companies' AND deleted_at IS NULL AND id <> 0
       AND (data->>'isActive') IN ('true', '1') AND (data->>'companyType') = ANY($1::text[])
       AND ($2::bigint[] IS NULL OR id = ANY($2::bigint[]))`;

/** Active contacts (Contacts.isActive is 0 / 1) of those companies, primary first, then ones with an email. $1 = company ids (text), $2 = per company. */
export const CONTACTS_SQL = `
    SELECT company, id, first, last, email, phone, mobile, title, is_primary FROM (
      SELECT data->>'companyID' AS company, id::text AS id, data->>'firstName' AS first, data->>'lastName' AS last, data->>'emailAddress' AS email,
             data->>'phone' AS phone, data->>'mobilePhone' AS mobile, data->>'title' AS title, (data->>'primaryContact') IN ('true', '1') AS is_primary,
             row_number() OVER (PARTITION BY data->>'companyID' ORDER BY (data->>'primaryContact') IN ('true', '1') DESC, (coalesce(data->>'emailAddress', '') <> '') DESC, id) AS rn
        FROM shadow_record
       WHERE entity = 'Contacts' AND deleted_at IS NULL AND (data->>'isActive') IN ('1', 'true') AND (data->>'companyID') = ANY($1::text[])
    ) x WHERE rn <= $2 ORDER BY company, rn`;

export interface TouchRow { company: string; in_window: boolean; weak: boolean; type: string; who: string | null; at: string; rec: string; ref: string | null; title: string | null; n_in: number; n_weak: number }
export interface CompanyRow { id: string; name: string | null; type: string | null; phone: string | null; owner: string | null }
export interface ContactRow { company: string; id: string; first: string | null; last: string | null; email: string | null; phone: string | null; mobile: string | null; title: string | null; is_primary: boolean }

/** One flat row per company — the columns in COLUMNS order, ready for a spreadsheet. */
export interface ReengagementRow {
  companyName: string; companyId: number; companyType: string; companyPhone: string; accountManager: string;
  contactName: string; contactEmail: string; contactPhone: string; otherContacts: string;
  lastContactDate: string; daysSinceLastContact: number | null; lastContactType: string; lastContactBy: string; lastContactReference: string;
  touchpointsInWindow: number; weakerSignal: string; companyLink: string;
}

export const COLUMNS: Array<[string, keyof ReengagementRow]> = [
  ['Company Name', 'companyName'], ['Contact Name', 'contactName'], ['Contact Email', 'contactEmail'], ['Contact Phone', 'contactPhone'],
  ['Last Contact Date', 'lastContactDate'], ['Last Contact Type', 'lastContactType'], ['Days Since Last Contact', 'daysSinceLastContact'],
  ['Last Contact By', 'lastContactBy'], ['Last Contact Reference', 'lastContactReference'], ['Touchpoints In Window', 'touchpointsInWindow'],
  ['Weaker Signal (not counted)', 'weakerSignal'], ['Other Contacts', 'otherContacts'], ['Account Manager', 'accountManager'],
  ['Company Phone', 'companyPhone'], ['Company Type', 'companyType'], ['Company ID', 'companyId'], ['Autotask Link', 'companyLink'],
];

export interface ReengagementOptions { from: string; to: string; companyTypes: number[]; companyIds?: number[] | null; types: readonly TouchpointType[]; includePlaceholders: boolean; contactsPerCompany: number; today: string }

const name = (c: { first: string | null; last: string | null }) => [c.first, c.last].map((x) => String(x ?? '').trim()).filter(Boolean).join(' ');
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86_400_000);

/** Pure assembly (tested): the two lists, sorted oldest contact first. */
export function assembleReport(d: {
  companies: CompanyRow[]; contacts: ContactRow[]; touches: TouchRow[]; opts: ReengagementOptions;
  classify: Classify; link: (companyId: number) => string | null; historyFrom: string | null;
}): { contacted: ReengagementRow[]; notContacted: ReengagementRow[]; excludedPlaceholders: number } {
  const byCompany = new Map<string, TouchRow[]>();
  for (const t of d.touches) (byCompany.get(t.company) ?? byCompany.set(t.company, []).get(t.company)!).push(t);
  const contactsBy = new Map<string, ContactRow[]>();
  for (const c of d.contacts) {
    const placeholder = isPlaceholderContact({ firstName: c.first, lastName: c.last });
    if (placeholder && placeholder !== 'no name') continue; // "Unknown Contact"; a nameless contact with an email still helps
    (contactsBy.get(c.company) ?? contactsBy.set(c.company, []).get(c.company)!).push(c);
  }
  const who = (id: string | null) => (id && /^\d+$/.test(id) ? d.classify(Number(id)).name ?? `resource ${id}` : '');
  const describe = (t: TouchRow) => [t.ref, t.title].filter(Boolean).join(' — ');
  const contacted: ReengagementRow[] = [], notContacted: ReengagementRow[] = [];
  let excludedPlaceholders = 0;

  for (const c of d.companies) {
    const id = Number(c.id);
    if (!Number.isInteger(id) || id < 0) continue; // not an id
    if (id === 0) continue;                        // the tenant's own company is never a customer
    if (!d.opts.includePlaceholders && isPlaceholderCompany({ companyName: c.name })) { excludedPlaceholders++; continue; }
    const ts = byCompany.get(c.id) ?? [];
    const strongIn = ts.find((t) => t.in_window && !t.weak);
    const strongBefore = ts.find((t) => !t.in_window && !t.weak);
    const weakIn = ts.find((t) => t.in_window && t.weak);
    const last = strongIn ?? strongBefore;
    const people = contactsBy.get(c.id) ?? [];
    const first = people[0];
    const unknown = d.historyFrom && d.historyFrom > d.opts.from ? `unknown (history before ${d.historyFrom} is not in the mirror)` : 'unknown';
    const row: ReengagementRow = {
      companyName: c.name ?? `#${c.id}`, companyId: id, companyType: COMPANY_TYPES[Number(c.type)] ?? String(c.type ?? ''), companyPhone: c.phone ?? '',
      accountManager: who(c.owner),
      contactName: first ? name(first) : '', contactEmail: first?.email ?? '', contactPhone: first ? (first.phone || first.mobile || '') : '',
      otherContacts: people.slice(1).map((p) => (p.email ? `${name(p) || '(no name)'} <${p.email}>` : name(p))).filter(Boolean).join('; '),
      lastContactDate: last ? last.at.slice(0, 10) : unknown,
      daysSinceLastContact: last ? dayDiff(last.at, d.opts.today) : null,
      lastContactType: last ? last.type : '', lastContactBy: last ? who(last.who) : '', lastContactReference: last ? describe(last) : '',
      touchpointsInWindow: ts[0]?.n_in ?? 0,
      weakerSignal: weakIn ? `${weakIn.at.slice(0, 10)} ${weakIn.type}${weakIn.type === 'CRM to-do' && /:17$/.test(weakIn.at) ? ' (completed at :17 — automation)' : ''}` : '',
      companyLink: d.link(id) ?? '',
    };
    (strongIn ? contacted : notContacted).push(row);
  }
  const byDate = (a: ReengagementRow, b: ReengagementRow) => {
    const ka = a.daysSinceLastContact == null ? null : a.lastContactDate, kb = b.daysSinceLastContact == null ? null : b.lastContactDate;
    if (ka !== kb) { if (ka == null) return 1; if (kb == null) return -1; return ka < kb ? -1 : 1; } // unknown last
    return a.companyName.localeCompare(b.companyName);
  };
  contacted.sort(byDate);
  notContacted.sort(byDate);
  return { contacted, notContacted, excludedPlaceholders };
}

/** Person resource ids and a name lookup, from the mirror's Resources and the console's Actors settings. */
export async function mirrorActors(pool: Pool): Promise<{ humanIds: number[]; classify: Classify }> {
  const rows = (await pool.query<{ id: string; data: Record<string, unknown> }>(`SELECT id::text, data FROM shadow_record WHERE entity = 'Resources' AND deleted_at IS NULL`)).rows;
  const ctx: ClassifyContext = {
    resources: new Map(rows.map((r) => [Number(r.id), { id: Number(r.id), ...(r.data as Omit<ActorRecord, 'id'>) }])),
    mcpApiUserId: null, apiLicenseValue: 7, // 7 = "API User" on standard tenants (this MCP's own API user is one)
    registry: parseRegistry(settingValue<string[]>('actors.registry') ?? []),
    reference: parseReference(settingValue<string[]>('actors.reference') ?? []),
  };
  const classify = classifierFrom(ctx);
  const ids = new Set<number>([...ctx.resources.keys(), ...ctx.registry.keys(), ...ctx.reference.keys()]);
  return { humanIds: [...ids].filter((id) => id !== 4 && classify(id).kind === 'person').sort((a, b) => a - b), classify };
}

/** Entities the report reads; windowed ones bound how far back the mirror can see. */
export const REPORT_ENTITIES = ['Companies', 'Contacts', 'Resources', 'Tickets', 'TicketNotes', 'TimeEntries', 'Tasks', 'Projects', 'CompanyToDos', 'Opportunities', 'ServiceCalls'];
const HISTORY_ENTITIES: Record<TouchpointType, string[]> = {
  'ticket note': ['TicketNotes', 'Tickets'], 'time entry': ['TimeEntries', 'Tickets'], 'CRM to-do': ['CompanyToDos'], 'opportunity': ['Opportunities'], 'service call': ['ServiceCalls'],
};

export async function customerReengagementReport(pool: Pool, opts: ReengagementOptions, link: (companyId: number) => string | null): Promise<Record<string, unknown>> {
  const store = new ShadowStore(pool);
  const fresh: Freshness[] = await Promise.all(REPORT_ENTITIES.map((e) => store.freshness(e)));
  const { humanIds, classify } = await mirrorActors(pool);
  const companies = (await pool.query<CompanyRow>(COMPANIES_SQL, [opts.companyTypes.map(String), opts.companyIds?.length ? opts.companyIds : null])).rows;
  const ids = companies.map((c) => c.id);
  const [contacts, touches] = await Promise.all([
    ids.length ? pool.query<ContactRow>(CONTACTS_SQL, [ids, Math.max(1, opts.contactsPerCompany)]).then((r) => r.rows) : Promise.resolve([]),
    ids.length ? pool.query<TouchRow>(touchpointSql(opts.types), [opts.from, addDays(opts.to, 1), humanIds]).then((r) => r.rows) : Promise.resolve([]),
  ]);
  const windowed = [...new Set(opts.types.flatMap((t) => HISTORY_ENTITIES[t]))];
  const historyFrom = fresh.filter((f) => windowed.includes(f.entity) && f.windowFrom).map((f) => f.windowFrom as string).sort().pop() ?? null;
  const { contacted, notContacted, excludedPlaceholders } = assembleReport({ companies, contacts, touches, opts, classify, link, historyFrom });

  const warnings: string[] = [];
  const notReady = fresh.filter((f) => !f.ready).map((f) => f.entity);
  if (notReady.length) warnings.push(`Still backfilling (incomplete): ${notReady.join(', ')}.`);
  if (historyFrom && historyFrom > opts.from) warnings.push(`The mirror holds ticket notes / time entries from ${historyFrom} only (plus open tickets): touchpoints between ${opts.from} and ${historyFrom} of those kinds are not seen, so some companies may be listed as not contacted that were.`);
  if (!humanIds.length) warnings.push('No person resources in the mirror — every touchpoint was left out. Check that Resources are mirrored.');
  warnings.push('Quotes are not mirrored and are not counted (their opportunity is).');

  return {
    window: { from: opts.from, to: opts.to, inclusive: true }, asOf: opts.today,
    companyTypes: opts.companyTypes.map((t) => COMPANY_TYPES[t] ?? String(t)), touchpointTypes: opts.types,
    summary: { companies: contacted.length + notContacted.length, contactedInWindow: contacted.length, notContactedInWindow: notContacted.length,
      notContactedWithOlderContact: notContacted.filter((r) => r.daysSinceLastContact != null).length, notContactedUnknown: notContacted.filter((r) => r.daysSinceLastContact == null).length,
      excludedPlaceholderCompanies: excludedPlaceholders, personResources: humanIds.length },
    columns: COLUMNS.map(([h, k]) => ({ header: h, key: k })),
    contacted, notContacted, warnings,
    freshness: fresh.map((f) => ({ entity: f.entity, ready: f.ready, ageSeconds: f.ageSeconds, windowFrom: f.windowFrom })),
    rules: 'Touchpoints by a PERSON only (not resource 4, API users or this MCP). Ticket notes: publish = 1 (All Autotask Users, client-visible). Time entries: on the company\'s tickets or project tasks. To-Dos: completed ones; completed at :17 (hourly automation) or by a non-person = weaker signal, never counted. Opportunities: last activity (else created), owner a person. Service calls: started, not cancelled, created by a person. Company 0 (our own) is never listed.',
  };
}
