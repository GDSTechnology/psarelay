// Ticket completeness: §4.5 create fields + §4.6 safe move-ticket-to-company.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';
import { _resetZoneUrlCache } from '../src/utils/config';

const logger = new Logger('error');
const config: McpServerConfig = {
  name: 'test-server', version: '0.0.0',
  autotask: { username: 'user@example.com', secret: 'secret', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' },
};

function res(status: number, body?: any): Response {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => (body !== undefined ? JSON.stringify(body) : '') } as unknown as Response;
}

/** Stateful ticket mock: GET returns current state, PATCH /Tickets merges the body. */
function moveMock(initialTicket: Record<string, any>, locations: any[]): jest.SpyInstance {
  let ticket = { ...initialTicket };
  return jest.spyOn(global, 'fetch' as any).mockImplementation((...args: any[]) => {
    const url = args[0] as string; const init = (args[1] || {}) as RequestInit;
    const path = new URL(url).pathname; const method = init.method || 'GET';
    if (method === 'GET' && /\/Tickets\/\d+$/.test(path)) return Promise.resolve(res(200, { item: ticket }));
    if (method === 'POST' && /\/CompanyLocations\/query$/.test(path)) return Promise.resolve(res(200, { items: locations }));
    if (method === 'PATCH' && /\/Tickets$/.test(path)) { ticket = { ...ticket, ...JSON.parse(init.body as string) }; return Promise.resolve(res(200, { itemId: ticket.id })); }
    return Promise.resolve(res(599, { errors: [`unexpected ${method} ${path}`] }));
  });
}
function calls(mock: jest.SpyInstance): string[] {
  return mock.mock.calls.map((c: any[]) => `${(c[1] as RequestInit).method || 'GET'} ${new URL(c[0] as string).pathname}`);
}
function patchBody(mock: jest.SpyInstance): any {
  const call = mock.mock.calls.find((c: any[]) => ((c[1] as RequestInit).method) === 'PATCH');
  return call ? JSON.parse((call[1] as RequestInit).body as string) : undefined;
}

beforeEach(() => _resetZoneUrlCache());
afterEach(() => jest.restoreAllMocks());

describe('ticket create/update field completeness (§4.5)', () => {
  test('create forwards dueDateTime, companyLocationID, configurationItemID', async () => {
    const service = new AutotaskService(config, logger);
    const spy = jest.spyOn(service, 'createTicket').mockResolvedValue(1 as any);
    const handler = new AutotaskToolHandler(service, logger);
    await handler.callTool('autotask_create_ticket', {
      companyID: 1, title: 't', description: 'd',
      dueDateTime: '2026-08-26T17:00:00Z', companyLocationID: 900, configurationItemID: 555,
    });
    expect(spy.mock.calls[0][0]).toEqual(expect.objectContaining({
      dueDateTime: '2026-08-26T17:00:00Z', companyLocationID: 900, configurationItemID: 555,
    }));
  });

  test('update forwards companyLocationID + configurationItemID', async () => {
    const service = new AutotaskService(config, logger);
    const spy = jest.spyOn(service, 'updateTicket').mockResolvedValue(undefined as any);
    const handler = new AutotaskToolHandler(service, logger);
    await handler.callTool('autotask_update_ticket', { ticketId: 1, companyLocationID: 900, configurationItemID: 555 });
    expect(spy.mock.calls[0][1]).toEqual(expect.objectContaining({ companyLocationID: 900, configurationItemID: 555 }));
  });
});

describe('moveTicketToCompany (§4.6)', () => {
  test('sets companyID + primary location together, clears contact, verifies', async () => {
    const mock = moveMock(
      { id: 204722, companyID: 111, companyLocationID: 5, contactID: 99 },
      [{ id: 800, companyID: 222, isPrimary: false, isActive: true }, { id: 900, companyID: 222, isPrimary: true, isActive: true }]
    );
    const out = await new AutotaskService(config, logger).moveTicketToCompany(204722, 222);
    expect(out.status).toBe('updated');
    expect(out.verified).toBe(true);
    const body = patchBody(mock);
    expect(body).toMatchObject({ id: 204722, companyID: 222, companyLocationID: 900, contactID: null });
  });

  test('refuses to move a CI-linked ticket and performs no write', async () => {
    const mock = moveMock({ id: 1, companyID: 111, configurationItemID: 555 }, []);
    const out = await new AutotaskService(config, logger).moveTicketToCompany(1, 222);
    expect(out).toMatchObject({ status: 'blocked', reason: 'configuration-item-linked', configurationItemID: 555 });
    expect(calls(mock).some((c) => c.startsWith('PATCH'))).toBe(false);
    expect(calls(mock).some((c) => c.includes('CompanyLocations'))).toBe(false);
  });

  test('force overrides the CI block', async () => {
    const mock = moveMock(
      { id: 1, companyID: 111, configurationItemID: 555 },
      [{ id: 900, companyID: 222, isPrimary: true, isActive: true }]
    );
    const out = await new AutotaskService(config, logger).moveTicketToCompany(1, 222, { force: true });
    expect(out.status).toBe('updated');
    expect(patchBody(mock)).toMatchObject({ companyID: 222, companyLocationID: 900 });
  });

  test('throws when the target company has no active location', async () => {
    moveMock({ id: 1, companyID: 111 }, []);
    await expect(new AutotaskService(config, logger).moveTicketToCompany(1, 222)).rejects.toThrow(/no active location/);
  });

  test('uses a supplied contactID instead of clearing', async () => {
    const mock = moveMock(
      { id: 1, companyID: 111 },
      [{ id: 900, companyID: 222, isPrimary: true, isActive: true }]
    );
    await new AutotaskService(config, logger).moveTicketToCompany(1, 222, { contactID: 77 });
    expect(patchBody(mock)).toMatchObject({ contactID: 77 });
  });
});
