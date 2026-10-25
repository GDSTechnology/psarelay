// Operator asks (2026-10-25): full ticket-charge rows, more mirrored entities, the CI serial-number filter, tenant
// defaults on new companies. Filters are asserted on the payload SENT UPSTREAM — a dropped filter looks like a
// successful broad search (learned 2026-09-16).

import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import { formatCompactResponse, detectEntityType } from '../src/utils/response.formatter';
import { SHADOW_ENTITIES, shadowEntity } from '../src/db/shadow-entities';
import { companyCreateDefaults, companyDefaultLineProblem, withCompanyDefaults } from '../src/utils/company-defaults';
import { _resetSettings } from '../src/admin/settings';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@example.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
function svc(rows: unknown[] = []) {
  const s = new AutotaskService(config, logger);
  const query = jest.fn().mockResolvedValue(rows);
  const create = jest.fn().mockResolvedValue(77);
  jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query, create });
  return { s, query, create };
}
afterEach(() => { jest.restoreAllMocks(); delete process.env.MCP_COMPANY_DEFAULTS; _resetSettings(); });

describe('ticket charges', () => {
  test('search results keep the charge fields (they used to be cut down to ticket fields — only the id survived)', () => {
    expect(detectEntityType('autotask_search_ticket_charges')).toBe('ticketCharges');
    const out = formatCompactResponse([{ id: 1, ticketID: 9, name: 'UPS battery', unitQuantity: 2, unitPrice: 80, unitCost: 50, billableAmount: 160, isBilled: false, billingCodeID: 3, status: 6 }], 'ticketCharges', {});
    const row = out.items[0];
    expect(row).toMatchObject({ id: 1, ticketID: 9, name: 'UPS battery', unitQuantity: 2, unitPrice: 80, billableAmount: 160, isBilled: false });
  });
  test('ticketIds → one "in" query; isBilled and purchase date go upstream', async () => {
    const { s, query } = svc();
    await s.searchTicketCharges({ ticketIds: [5, 6, 6, 7], isBilled: false, purchasedAfter: '2026-10-01' });
    const filters = query.mock.calls[0][1];
    expect(filters).toEqual(expect.arrayContaining([
      { op: 'in', field: 'ticketID', value: [5, 6, 7] },
      { op: 'eq', field: 'isBilled', value: false },
      { op: 'gte', field: 'datePurchased', value: '2026-10-01' },
    ]));
  });
});

describe('configuration items', () => {
  test('serialNumber filters on the serial or the reference number (it used to be ignored)', async () => {
    const { s, query } = svc();
    await s.searchConfigurationItems({ serialNumber: ' 3S1234X ' } as any);
    expect(query.mock.calls[0][1]).toContainEqual({ op: 'or', items: [{ op: 'eq', field: 'serialNumber', value: '3S1234X' }, { op: 'eq', field: 'referenceNumber', value: '3S1234X' }] });
  });
});

describe('the mirror', () => {
  test('mirrors ExpenseItems (by expense date), Opportunities and ConfigurationItems as well as TicketCharges', () => {
    for (const n of ['TicketCharges', 'ExpenseItems', 'Opportunities', 'ConfigurationItems']) expect(shadowEntity(n)).toBeDefined();
    expect(shadowEntity('ExpenseItems')!.window!('2026-01-01')).toEqual({ op: 'gte', field: 'expenseDate', value: '2026-01-01' });
    expect(new Set(SHADOW_ENTITIES.map((e) => e.name)).size).toBe(SHADOW_ENTITIES.length);
  });
});

describe('new company defaults', () => {
  test('lines are validated; the caller\'s values win; applied defaults are reported', () => {
    expect(companyDefaultLineProblem('invoiceTemplateID=12')).toBeNull();
    expect(companyDefaultLineProblem('isTaxExempt=true')).toBeNull();
    expect(companyDefaultLineProblem('invoiceTemplate=12')).toMatch(/Unknown field/);
    expect(companyDefaultLineProblem('taxRegionID=two')).toMatch(/whole number/);
    const d = companyCreateDefaults(['invoiceTemplateID=12', 'quotetemplateid=34', 'taxRegionID=5', 'bogus=1']);
    expect(d).toEqual({ invoiceTemplateID: 12, quoteTemplateID: 34, taxRegionID: 5 });
    const r = withCompanyDefaults({ companyName: 'Acme', quoteTemplateID: 7 }, d);
    expect(r.company).toEqual({ companyName: 'Acme', invoiceTemplateID: 12, quoteTemplateID: 7, taxRegionID: 5 });
    expect(r.applied.sort()).toEqual(['invoiceTemplateID', 'taxRegionID']);
  });
  test('createCompany sends the tenant defaults upstream', async () => {
    process.env.MCP_COMPANY_DEFAULTS = 'invoiceTemplateID=12,taxRegionID=5';
    process.env.AUTOTASK_DEFAULT_OWNER_RESOURCE_ID = '4';
    _resetSettings();
    const { s, create } = svc();
    await s.createCompany({ companyName: 'Acme Plumbing', companyType: 1, phone: '555-0100' } as any);
    expect(create.mock.calls[0][1]).toMatchObject({ companyName: 'Acme Plumbing', invoiceTemplateID: 12, taxRegionID: 5 });
    delete process.env.AUTOTASK_DEFAULT_OWNER_RESOURCE_ID;
  });
});
