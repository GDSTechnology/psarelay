// autotask_report_customer_reengagement — "which customer companies haven't we contacted
// recently?" Read-only, from the Postgres mirror (0 Autotask calls): a per-company aggregate
// instead of hundreds of per-company searches. Flat rows for a spreadsheet, or the .xlsx itself.

import type { Pool } from 'pg';
import ExcelJS from 'exceljs';
import type { AutotaskService } from '../services/autotask.service.js';
import { COLUMNS, TOUCHPOINT_TYPES, addDays, customerReengagementReport, type ReengagementRow, type TouchpointType } from './reengagement.js';

type Result = { result: unknown; message: string };
type H = (a: Record<string, any>) => Promise<Result>;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_MAX_ROWS = 1000;

const safe = (v: unknown): unknown => (typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : v ?? '');

export async function buildReengagementWorkbook(r: Record<string, any>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'PSArelay'; wb.created = new Date();
  const add = (title: string, header: string[], rows: unknown[][]) => {
    const ws = wb.addWorksheet(title, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.addRow(header).font = { bold: true };
    for (const row of rows) ws.addRow(row.map(safe));
    ws.columns.forEach((c, i) => { c.width = Math.min(48, Math.max(12, header[i]!.length + 2)); });
    if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: header.length } };
  };
  const s = r.summary ?? {};
  add('Summary', ['Item', 'Value'], [
    ['Window', `${r.window.from} – ${r.window.to} (inclusive)`], ['As of', r.asOf], ['Company types', (r.companyTypes ?? []).join(', ')],
    ['Touchpoint types', (r.touchpointTypes ?? []).join(', ')], ['Companies', s.companies], ['Contacted in window', s.contactedInWindow],
    ['Not contacted in window', s.notContactedInWindow], ['… with an older contact', s.notContactedWithOlderContact], ['… unknown', s.notContactedUnknown],
    ['Placeholder companies left out', s.excludedPlaceholderCompanies], ['Rules', r.rules], ...(r.warnings ?? []).map((w: string) => ['Warning', w]),
  ]);
  const header = COLUMNS.map(([h]) => h);
  const rows = (list: ReengagementRow[]) => list.map((x) => COLUMNS.map(([, k]) => x[k]));
  add('Contacted (oldest first)', header, rows(r.contacted ?? []));
  add('Not contacted in window', header, rows(r.notContacted ?? []));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function reportToolHandlers(s: AutotaskService, getPool: () => Pool | null): Array<[string, H]> {
  return [
    ['autotask_report_customer_reengagement', async (a) => {
      const today = new Date().toISOString().slice(0, 10);
      const to = a.to == null || a.to === '' ? today : String(a.to).slice(0, 10);
      const from = a.from == null || a.from === '' ? addDays(to, -365) : String(a.from).slice(0, 10);
      if (!ISO_DAY.test(from) || !ISO_DAY.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
        return { result: { status: 'invalid_value', field: 'from/to' }, message: 'from and to are dates, YYYY-MM-DD (both inclusive).' };
      }
      if (from > to) return { result: { status: 'invalid_value', field: 'from' }, message: `from (${from}) is after to (${to}).` };
      const companyTypes = (Array.isArray(a.companyTypes) && a.companyTypes.length ? a.companyTypes : [1]).map(Number);
      if (companyTypes.some((t: number) => !Number.isInteger(t) || t < 0)) return { result: { status: 'invalid_value', field: 'companyTypes' }, message: 'companyTypes are Companies.companyType numbers (1 = Customer).' };
      // Company ids: 0 is a valid id (our own company) but is never listed; keep the check explicit, never truthy.
      const companyIds = Array.isArray(a.companyIds) ? a.companyIds.filter((x: unknown) => x != null && x !== '').map(Number).filter((n: number) => Number.isInteger(n) && n >= 0) : null;
      const types = (Array.isArray(a.touchpointTypes) && a.touchpointTypes.length ? a.touchpointTypes : TOUCHPOINT_TYPES).map(String);
      const bad = types.filter((t: string) => !(TOUCHPOINT_TYPES as readonly string[]).includes(t));
      if (bad.length) return { result: { status: 'invalid_value', field: 'touchpointTypes' }, message: `Unknown touchpoint type(s): ${bad.join(', ')}. Use: ${TOUCHPOINT_TYPES.join(', ')}.` };

      const pool = getPool();
      if (!pool) return { result: { status: 'unavailable' }, message: 'Needs the Postgres mirror (MCP_PG_ENABLED + MCP_PG_SHADOW_ENABLED): answering this live would take hundreds of Autotask calls.' };

      const r = await customerReengagementReport(pool, {
        from, to, today, companyTypes, companyIds, types: types as TouchpointType[], includePlaceholders: a.includePlaceholders === true,
        contactsPerCompany: Math.min(Math.max(Number(a.contactsPerCompany) || 3, 1), 10),
      }, (id) => s.getRecordWebUrl('company', id)) as Record<string, any>;
      const sum = r.summary;
      const head = `${sum.companies} active ${r.companyTypes.join('/')} compan${sum.companies === 1 ? 'y' : 'ies'}, ${from} – ${to}: ${sum.contactedInWindow} contacted, ${sum.notContactedInWindow} not (${sum.notContactedWithOlderContact} with an older contact, ${sum.notContactedUnknown} unknown). From the mirror, 0 Autotask calls.`;

      if (a.format === 'xlsx') {
        const buf = await buildReengagementWorkbook(r);
        const fileName = `Customer_Reengagement_${from}_to_${to}.xlsx`;
        return { result: { fileName, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: buf.length, contentBase64: buf.toString('base64'), summary: sum, warnings: r.warnings },
          message: `${head} ${fileName} (${Math.round(buf.length / 1024)} KB): Summary, Contacted (oldest first), Not contacted in window. contentBase64 holds the file.` };
      }
      const max = Math.min(Math.max(Number(a.maxRows) || DEFAULT_MAX_ROWS, 1), 5000);
      const truncated = r.contacted.length > max || r.notContacted.length > max;
      return {
        result: { ...r, contacted: r.contacted.slice(0, max), notContacted: r.notContacted.slice(0, max), truncated, maxRows: max },
        message: `${head}${truncated ? ` Lists cut at ${max} rows each — pass maxRows (≤ 5000) or format "xlsx" for everything.` : ''}${r.warnings.length ? ` Notes: ${r.warnings.join(' ')}` : ''}`,
      };
    }],
  ];
}
