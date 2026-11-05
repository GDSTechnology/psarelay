// Customer re-engagement report: the filters sent to the mirror (publish = 1, persons only,
// window bounds, customer type, never company 0, active contacts as 0 / 1), the assembly
// (oldest first, weak signals not counted, older / unknown last contact), and the tool's guards.

import { COMPANIES_SQL, CONTACTS_SQL, TOUCHPOINT_TYPES, addDays, assembleReport, touchpointSql, type CompanyRow, type ContactRow, type ReengagementOptions, type TouchRow } from '../src/reports/reengagement';
import { reportToolHandlers, buildReengagementWorkbook } from '../src/reports/tools';
import { TOOL_CATEGORIES, TOOL_DEFINITIONS } from '../src/handlers/tool.definitions';
import ExcelJS from 'exceljs';

type Q = { sql: string; params: unknown[] };

/** A pool that answers by what the SQL reads, and records every query. */
function fakePool(data: { resources?: Array<{ id: string; data: Record<string, unknown> }>; companies?: CompanyRow[]; contacts?: ContactRow[]; touches?: TouchRow[]; windowFrom?: string | null }) {
  const calls: Q[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/FROM shadow_sync_state/.test(sql)) {
        const e = String(params[0]);
        return { rows: [{ entity: e, backfill_done: true, row_count: 1, backfill_cursor: 0, api_calls_total: 0, last_incremental_at: new Date(), window_from: ['TicketNotes', 'TimeEntries', 'Tickets'].includes(e) && data.windowFrom ? new Date(`${data.windowFrom}T00:00:00Z`) : null }] };
      }
      if (/entity = 'Resources'/.test(sql)) return { rows: data.resources ?? [] };
      if (/entity = 'Companies'/.test(sql)) return { rows: data.companies ?? [] };
      if (/entity = 'Contacts'/.test(sql)) return { rows: data.contacts ?? [] };
      if (/WITH ev AS/.test(sql)) return { rows: data.touches ?? [] };
      throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
    },
  };
  return { pool: pool as any, calls };
}

const resources = [
  { id: '4', data: { firstName: 'Autotask', lastName: 'Administrator', licenseType: 1, isActive: true } },      // system
  { id: '29000001', data: { firstName: 'Avery', lastName: 'Tech', licenseType: 1, isActive: true } },           // person
  { id: '29000002', data: { firstName: 'Riley', lastName: 'Sales', licenseType: 2, isActive: true } },          // person
  { id: '29000003', data: { firstName: 'Email', lastName: 'Connector', licenseType: 7, isActive: true } },      // API user
  { id: '29000004', data: { firstName: 'Relay', lastName: 'MCP', licenseType: 7, isActive: true } },            // this MCP's API user
];
const fakeService = { getRecordWebUrl: (_k: string, id: number) => `https://example.invalid/company/${id}` } as any;
const run = (pool: unknown, a: Record<string, unknown>) => new Map(reportToolHandlers(fakeService, () => pool as any)).get('autotask_report_customer_reengagement')!(a);

describe('touchpoint SQL (what the mirror is asked)', () => {
  const sql = touchpointSql(TOUCHPOINT_TYPES);
  test('ticket notes: only publish = 1 (All Autotask Users), by a person, on the ticket\'s company', () => {
    expect(sql).toMatch(/n\.entity = 'TicketNotes'[\s\S]*\(n\.data->>'publish'\) = '1'/);
    expect(sql).toMatch(/creatorResourceID'\)::bigint END\) = ANY\(\$3::bigint\[\]\)/);
    expect(sql).toMatch(/JOIN shadow_record tk ON tk\.entity = 'Tickets'/);
  });
  test('window bounds and never company 0 / future rows', () => {
    expect(sql).toContain('ev.ts >= $1::timestamp AS in_window');
    expect(sql).toContain('ev.ts < $2::timestamp');
    expect(sql).toContain('ev.ts <= now()::timestamp');
    expect(sql).toContain("ev.company <> '0'");
  });
  test('to-dos: completed only; :17 or non-person = weak; service calls not cancelled', () => {
    expect(sql).toMatch(/CompanyToDos'[\s\S]*completedDate' IS NOT NULL/);
    expect(sql).toMatch(/extract\(minute FROM [\s\S]*completedDate[\s\S]*\) = 17/);
    expect(sql).toContain("s.data->>'canceledDateTime' IS NULL");
  });
  test('only the chosen kinds are read', () => {
    const only = touchpointSql(['ticket note']);
    expect(only).toContain("'TicketNotes'");
    expect(only).not.toContain("'TimeEntries'");
    expect(only).not.toContain("'Opportunities'");
    expect(() => touchpointSql([])).toThrow();
  });
  test('companies: active, by type, never id 0; contacts: active as 0 / 1, primary first', () => {
    expect(COMPANIES_SQL).toContain('id <> 0');
    expect(COMPANIES_SQL).toContain("(data->>'isActive') IN ('true', '1')");
    expect(COMPANIES_SQL).toContain("(data->>'companyType') = ANY($1::text[])");
    expect(CONTACTS_SQL).toContain("(data->>'isActive') IN ('1', 'true')");
    expect(CONTACTS_SQL).toMatch(/ORDER BY \(data->>'primaryContact'\) IN \('true', '1'\) DESC/);
  });
});

describe('the tool sends the right parameters', () => {
  test('window (inclusive end → next day), person ids only, customer type by default', async () => {
    const { pool, calls } = fakePool({ resources, companies: [{ id: '101', name: 'Northwind Test Co', type: '1', phone: null, owner: '29000002' }] });
    const r = await run(pool, { from: '2024-01-01', to: '2026-10-01' });
    const touch = calls.find((c) => /WITH ev AS/.test(c.sql))!;
    expect(touch.params[0]).toBe('2024-01-01');
    expect(touch.params[1]).toBe('2026-10-02');
    expect(touch.params[2]).toEqual([29000001, 29000002]); // not 4, not the API users
    const comp = calls.find((c) => /entity = 'Companies'/.test(c.sql))!;
    expect(comp.params).toEqual([['1'], null]);
    expect((r.result as any).notContacted).toHaveLength(1);
  });
  test('company filter and types pass through; company 0 is a valid id, never dropped by a truthy check', async () => {
    const { pool, calls } = fakePool({ resources });
    await run(pool, { from: '2025-01-01', to: '2025-12-31', companyTypes: [1, 3], companyIds: [0, 101, null] });
    const comp = calls.find((c) => /entity = 'Companies'/.test(c.sql))!;
    expect(comp.params).toEqual([['1', '3'], [0, 101]]);
    expect(calls.some((c) => /WITH ev AS/.test(c.sql))).toBe(false); // no companies → no touchpoint scan
  });
  test('guards: bad dates, reversed window, unknown kinds, no mirror', async () => {
    const { pool } = fakePool({ resources });
    expect((await run(pool, { from: '2024-13-45x' })).result).toMatchObject({ status: 'invalid_value' });
    expect((await run(pool, { from: '2026-01-02', to: '2026-01-01' })).result).toMatchObject({ status: 'invalid_value', field: 'from' });
    expect((await run(pool, { touchpointTypes: ['email'] })).result).toMatchObject({ status: 'invalid_value', field: 'touchpointTypes' });
    expect((await run(null, {})).result).toMatchObject({ status: 'unavailable' });
  });
  test('warns when the mirror holds less history than the window', async () => {
    const { pool } = fakePool({ resources, windowFrom: '2025-04-01', companies: [{ id: '101', name: 'Northwind Test Co', type: '1', phone: null, owner: null }] });
    const r = (await run(pool, { from: '2024-01-01', to: '2026-10-01' })).result as any;
    expect(r.warnings.join(' ')).toMatch(/from 2025-04-01 only/);
    expect(r.notContacted[0].lastContactDate).toMatch(/^unknown \(history before 2025-04-01/);
  });
  test('xlsx: a workbook with the three sheets', async () => {
    const { pool } = fakePool({ resources, companies: [{ id: '101', name: '=cmd', type: '1', phone: null, owner: null }] });
    const r = (await run(pool, { from: '2024-01-01', to: '2026-10-01', format: 'xlsx' })).result as any;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(r.contentBase64, 'base64') as any);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'Contacted (oldest first)', 'Not contacted in window']);
    expect(wb.getWorksheet('Not contacted in window')!.getRow(2).getCell(1).value).toBe("'=cmd"); // formula neutralised
    expect(typeof buildReengagementWorkbook).toBe('function');
  });
});

describe('assembly', () => {
  const opts: ReengagementOptions = { from: '2024-01-01', to: '2026-10-01', today: '2026-11-04', companyTypes: [1], types: TOUCHPOINT_TYPES, includePlaceholders: false, contactsPerCompany: 3 };
  const classify = (id: number) => ({ name: id === 29000001 ? 'Avery Tech' : null, kind: 'person' as const });
  const t = (company: string, p: Partial<TouchRow>): TouchRow => ({ company, in_window: true, weak: false, type: 'ticket note', who: '29000001', at: '2025-05-01T10:00', rec: '1', ref: 'T20250501.0001', title: 'Printer', n_in: 1, n_weak: 0, ...p });
  const companies: CompanyRow[] = [
    { id: '0', name: 'Our Own MSP', type: '1', phone: null, owner: null },
    { id: '101', name: 'Recent Co', type: '1', phone: '555-0101', owner: '29000001' },
    { id: '102', name: 'Old Co', type: '1', phone: null, owner: null },
    { id: '103', name: 'Older Co', type: '1', phone: null, owner: null },
    { id: '104', name: 'Before Window Co', type: '1', phone: null, owner: null },
    { id: '105', name: 'Never Co', type: '1', phone: null, owner: null },
    { id: '106', name: 'Gmail', type: '1', phone: null, owner: null },
    { id: '107', name: 'Robot Only Co', type: '1', phone: null, owner: null },
  ];
  const touches: TouchRow[] = [
    t('0', { at: '2026-10-01T09:00' }),
    t('101', { at: '2026-09-30T09:00', n_in: 4 }),
    t('102', { at: '2025-02-01T09:00', type: 'time entry' }),
    t('103', { at: '2024-03-01T09:00', type: 'CRM to-do', ref: null, title: 'Quarterly review' }),
    t('104', { in_window: false, at: '2023-06-01T09:00', type: 'service call', n_in: 0 }),
    t('107', { weak: true, at: '2026-08-01T13:17', type: 'CRM to-do', n_in: 0, n_weak: 3 }),
  ];
  const contacts: ContactRow[] = [
    { company: '101', id: '1', first: 'Pat', last: 'Primary', email: 'pat@example.com', phone: '555-0111', mobile: null, title: null, is_primary: true },
    { company: '101', id: '2', first: 'Sam', last: 'Second', email: 'sam@example.com', phone: null, mobile: '555-0112', title: null, is_primary: false },
    { company: '102', id: '3', first: 'Unknown', last: 'Contact', email: null, phone: null, mobile: null, title: null, is_primary: false },
    { company: '102', id: '4', first: null, last: null, email: 'office@example.com', phone: null, mobile: '555-0113', title: null, is_primary: false },
  ];
  const r = assembleReport({ companies, contacts, touches, opts, classify, link: (id) => `link/${id}`, historyFrom: null });

  test('contacted: oldest last contact first; company 0 and placeholders never listed', () => {
    expect(r.contacted.map((x) => x.companyName)).toEqual(['Older Co', 'Old Co', 'Recent Co']);
    expect([...r.contacted, ...r.notContacted].some((x) => x.companyId === 0)).toBe(false);
    expect(r.excludedPlaceholders).toBe(1);
  });
  test('row: contact, type, who, reference, days since, link', () => {
    const recent = r.contacted.find((x) => x.companyId === 101)!;
    expect(recent).toMatchObject({ contactName: 'Pat Primary', contactEmail: 'pat@example.com', contactPhone: '555-0111', otherContacts: 'Sam Second <sam@example.com>',
      lastContactDate: '2026-09-30', lastContactType: 'ticket note', lastContactBy: 'Avery Tech', lastContactReference: 'T20250501.0001 — Printer', daysSinceLastContact: 35,
      touchpointsInWindow: 4, accountManager: 'Avery Tech', companyLink: 'link/101' });
  });
  test('placeholder contacts are skipped, a nameless one with an email kept', () => {
    expect(r.contacted.find((x) => x.companyId === 102)).toMatchObject({ contactName: '', contactEmail: 'office@example.com', contactPhone: '555-0113' });
  });
  test('not contacted: older contact if known (oldest first), else unknown; weak signals shown, never counted', () => {
    expect(r.notContacted.map((x) => [x.companyName, x.lastContactDate])).toEqual([
      ['Before Window Co', '2023-06-01'], ['Never Co', 'unknown'], ['Robot Only Co', 'unknown'],
    ]);
    const robot = r.notContacted.find((x) => x.companyId === 107)!;
    expect(robot.weakerSignal).toBe('2026-08-01 CRM to-do (completed at :17 — automation)');
    expect(robot.touchpointsInWindow).toBe(0);
  });
  test('addDays crosses months and years', () => {
    expect(addDays('2026-10-01', 1)).toBe('2026-10-02');
    expect(addDays('2024-12-31', 1)).toBe('2025-01-01');
    expect(addDays('2025-01-01', -365)).toBe('2024-01-02');
  });
});

describe('registration', () => {
  test('defined, read-only, and discoverable under companies', () => {
    const d = TOOL_DEFINITIONS.find((x) => x.name === 'autotask_report_customer_reengagement');
    expect((d?.annotations as any)?.readOnlyHint).toBe(true);
    expect(TOOL_CATEGORIES.companies!.tools).toContain('autotask_report_customer_reengagement');
  });
});
