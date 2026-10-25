// #1 dashboard gap — invoices: surface the QuickBooks-sync fields (via includeFields
// so the read optimizer can't strip them), the unsynced/batch/date filters, and the
// invoice→work linkage (linkedTicketIDs/ProjectIDs/TaskIDs). Service mocked.

import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' } };
const mk = () => new AutotaskService(config, new Logger('error'));

describe('searchInvoices field coverage + filters', () => {
  test('requests the sync/paid/void fields via includeFields (optimizer-proof)', async () => {
    const s = mk();
    const query = jest.fn().mockResolvedValue([]);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query });
    await s.searchInvoices({} as any);
    const opts = query.mock.calls[0][2];
    for (const f of ['invoiceNumber', 'batchID', 'paidDate', 'webServiceDate', 'isVoided', 'voidedDate', 'invoiceDateTime', 'invoiceTotal', 'orderNumber']) {
      expect(opts.includeFields).toContain(f);
    }
  });

  test('unsyncedOnly filters invoiceNumber notExist; batchID + date window applied', async () => {
    const s = mk();
    const query = jest.fn().mockResolvedValue([]);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query });
    await s.searchInvoices({ unsyncedOnly: true, batchID: 55, fromDate: '2026-09-01', toDate: '2026-09-30', isVoided: false } as any);
    const filters = query.mock.calls[0][1];
    expect(filters).toEqual(expect.arrayContaining([
      { op: 'notExist', field: 'invoiceNumber' },
      { op: 'eq', field: 'batchID', value: 55 },
      { op: 'eq', field: 'isVoided', value: false },
      { op: 'gte', field: 'invoiceDateTime', value: '2026-09-01' },
      { op: 'lte', field: 'invoiceDateTime', value: '2026-09-30' },
    ]));
  });
});

describe('getInvoiceDetails work linkage', () => {
  test('derives distinct linkedTicketIDs/ProjectIDs/TaskIDs from billing items', async () => {
    const s = mk();
    const query = jest.fn().mockResolvedValue([
      { id: 1, invoiceID: 9, ticketID: 100, taskID: null, projectID: null },
      { id: 2, invoiceID: 9, ticketID: 100, taskID: null, projectID: null }, // dup ticket
      { id: 3, invoiceID: 9, ticketID: 101, taskID: 200, projectID: 300 },
      { id: 4, invoiceID: 9, ticketID: null, taskID: null, projectID: null }, // no links
    ]);
    const get = jest.fn().mockResolvedValue({ id: 9, invoiceNumber: null, isVoided: false });
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ get, query });
    const r = await s.getInvoiceDetails(9) as any;
    expect(r.linkedTicketIDs.sort()).toEqual([100, 101]);
    expect(r.linkedTaskIDs).toEqual([200]);
    expect(r.linkedProjectIDs).toEqual([300]);
    expect(r.lineItems).toHaveLength(4);
    expect(r.invoiceNumber).toBeNull(); // null survives (unsynced), not coerced
  });

  test('returns null when the invoice is missing', async () => {
    const s = mk();
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ get: async () => null, query: async () => [] });
    expect(await s.getInvoiceDetails(999)).toBeNull();
  });
});
