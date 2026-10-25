// Regression tests for Phase 1 route/payload defects (GDS brief §4.2–§4.4):
//
//  §4.2  createContact must use the company child route
//        POST /Companies/{companyID}/Contacts, not root POST /Contacts.
//  §4.3  createServiceCallTicket must use POST /ServiceCalls/{id}/Tickets and
//        createServiceCallTicketResource must use
//        POST /ServiceCallTickets/{id}/Resources — the root collections used
//        previously (POST /ServiceCallTickets, POST /ServiceCallTicketResources)
//        do not exist and returned 404.
//  §4.4  buildTicketPayload must preserve assignedResourceRoleID alongside
//        assignedResourceID — Autotask requires both together, and the field was
//        silently dropped by the writable-field allowlist.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';
import { _resetZoneUrlCache } from '../src/utils/config';

const logger = new Logger('error');

const config: McpServerConfig = {
  name: 'test-server',
  version: '0.0.0',
  autotask: {
    username: 'user@example.com',
    secret: 'secret',
    integrationCode: 'integration-code',
    // Pre-set apiUrl so baseUrl() resolves without a zone-info network round-trip.
    apiUrl: 'https://webservices2.autotask.net/ATServicesRest/',
  },
};

interface MockResponseSpec {
  status: number;
  body?: any;
  text?: string;
}

function res(spec: MockResponseSpec): Response {
  return {
    ok: spec.status >= 200 && spec.status < 300,
    status: spec.status,
    headers: { get: () => null },
    text: async () =>
      spec.text !== undefined ? spec.text : spec.body !== undefined ? JSON.stringify(spec.body) : '',
  } as unknown as Response;
}

/** Route-table fetch mock: match on method + URL pattern. */
function mockFetchRoutes(
  routes: Array<{ method: string; path: RegExp; response: MockResponseSpec }>
): jest.SpyInstance {
  return jest.spyOn(global, 'fetch' as any).mockImplementation((...args: any[]) => {
    const url = args[0] as string;
    const init = (args[1] || {}) as RequestInit;
    const match = routes.find(r => r.method === (init.method || 'GET') && r.path.test(url));
    if (!match) {
      return Promise.resolve(res({ status: 599, text: `unexpected request: ${init.method} ${url}` }));
    }
    return Promise.resolve(res(match.response));
  });
}

/** Human-readable "<METHOD> <pathname>" trace of every fetch the code made. */
function calledRoutes(fetchMock: jest.SpyInstance): string[] {
  return fetchMock.mock.calls.map(
    (c: any[]) => `${(c[1] as RequestInit).method} ${new URL(c[0] as string).pathname}`
  );
}

beforeEach(() => {
  _resetZoneUrlCache();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('createContact() child route (§4.2)', () => {
  test('creates via POST /Companies/{companyID}/Contacts and returns itemId', async () => {
    const fetchMock = mockFetchRoutes([
      { method: 'POST', path: /\/Companies\/777\/Contacts$/, response: { status: 200, body: { itemId: 555 } } },
    ]);
    const service = new AutotaskService(config, logger);

    const id = await service.createContact({ companyID: 777, firstName: 'Joan', lastName: 'Eberly' });

    expect(id).toBe(555);
    expect(calledRoutes(fetchMock)).toEqual(['POST /ATServicesRest/v1.0/Companies/777/Contacts']);
    // Never touches the root collection that fails in the GDS zone.
    expect(calledRoutes(fetchMock)).not.toContain('POST /ATServicesRest/v1.0/Contacts');
  });

  test('throws without hitting the API when companyID is missing', async () => {
    const fetchMock = mockFetchRoutes([]);
    const service = new AutotaskService(config, logger);

    await expect(service.createContact({ firstName: 'Joan' })).rejects.toThrow(/companyID is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('createServiceCallTicket() child route (§4.3)', () => {
  test('creates via POST /ServiceCalls/{serviceCallID}/Tickets', async () => {
    const fetchMock = mockFetchRoutes([
      { method: 'POST', path: /\/ServiceCalls\/4733\/Tickets$/, response: { status: 200, body: { itemId: 5215 } } },
    ]);
    const service = new AutotaskService(config, logger);

    const id = await service.createServiceCallTicket({ serviceCallID: 4733, ticketID: 204722 });

    expect(id).toBe(5215);
    expect(calledRoutes(fetchMock)).toEqual(['POST /ATServicesRest/v1.0/ServiceCalls/4733/Tickets']);
    expect(calledRoutes(fetchMock)).not.toContain('POST /ATServicesRest/v1.0/ServiceCallTickets');
  });

  test('throws without hitting the API when serviceCallID is missing', async () => {
    const fetchMock = mockFetchRoutes([]);
    const service = new AutotaskService(config, logger);

    await expect(service.createServiceCallTicket({ ticketID: 204722 })).rejects.toThrow(/serviceCallID is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('createServiceCallTicketResource() child route (§4.3)', () => {
  test('creates via POST /ServiceCallTickets/{serviceCallTicketID}/Resources', async () => {
    const fetchMock = mockFetchRoutes([
      { method: 'POST', path: /\/ServiceCallTickets\/5215\/Resources$/, response: { status: 200, body: { itemId: 7632 } } },
    ]);
    const service = new AutotaskService(config, logger);

    const id = await service.createServiceCallTicketResource({ serviceCallTicketID: 5215, resourceID: 30683829 });

    expect(id).toBe(7632);
    expect(calledRoutes(fetchMock)).toEqual(['POST /ATServicesRest/v1.0/ServiceCallTickets/5215/Resources']);
    expect(calledRoutes(fetchMock)).not.toContain('POST /ATServicesRest/v1.0/ServiceCallTicketResources');
  });

  test('throws without hitting the API when serviceCallTicketID is missing', async () => {
    const fetchMock = mockFetchRoutes([]);
    const service = new AutotaskService(config, logger);

    await expect(
      service.createServiceCallTicketResource({ resourceID: 30683829 })
    ).rejects.toThrow(/serviceCallTicketID is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('buildTicketPayload assignment preservation (§4.4)', () => {
  test('forwards both assignedResourceID and assignedResourceRoleID to updateTicket', async () => {
    const service = new AutotaskService(config, logger);
    const updateSpy = jest.spyOn(service, 'updateTicket').mockResolvedValue(undefined as any);
    const handler = new AutotaskToolHandler(service, logger);

    await handler.callTool('autotask_update_ticket', {
      ticketId: 204722,
      assignedResourceID: 30683829,
      assignedResourceRoleID: 29683355,
    });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const [id, payload] = updateSpy.mock.calls[0];
    expect(id).toBe(204722);
    expect(payload).toEqual(
      expect.objectContaining({ assignedResourceID: 30683829, assignedResourceRoleID: 29683355 })
    );
  });

  test('forwards both assignment fields to createTicket', async () => {
    const service = new AutotaskService(config, logger);
    const createSpy = jest.spyOn(service, 'createTicket').mockResolvedValue(999 as any);
    const handler = new AutotaskToolHandler(service, logger);

    await handler.callTool('autotask_create_ticket', {
      companyID: 29684773,
      title: 'Test',
      status: 1,
      assignedResourceID: 30683829,
      assignedResourceRoleID: 29683355,
    });

    expect(createSpy).toHaveBeenCalledTimes(1);
    const [payload] = createSpy.mock.calls[0];
    expect(payload).toEqual(
      expect.objectContaining({ assignedResourceID: 30683829, assignedResourceRoleID: 29683355 })
    );
  });
});
