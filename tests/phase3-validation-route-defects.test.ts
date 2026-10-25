// Validation + route defects (brief §6.1 owner, §6.2 note length, §6.3 contact
// search, §4.7 opportunity collection PATCH).

import { buildContactSearchFilter, normalizeContactNote, CONTACT_NOTE_MAX_LENGTH } from '../src/utils/contact';
import { resolveCompanyOwnerResourceID } from '../src/utils/company-owner';
import { AutotaskService } from '../src/services/autotask.service';
import { TOOL_DEFINITIONS, TOOL_CATEGORIES } from '../src/handlers/tool.definitions';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';
import { _resetZoneUrlCache } from '../src/utils/config';

const logger = new Logger('error');
const config: McpServerConfig = {
  name: 'test-server',
  version: '0.0.0',
  autotask: { username: 'user@example.com', secret: 'secret', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' },
};

function res(status: number, body?: any): Response {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => (body !== undefined ? JSON.stringify(body) : '') } as unknown as Response;
}
function mockRoutes(routes: Array<{ method: string; path: RegExp; response: { status: number; body?: any } }>): jest.SpyInstance {
  return jest.spyOn(global, 'fetch' as any).mockImplementation((...args: any[]) => {
    const url = args[0] as string; const init = (args[1] || {}) as RequestInit;
    const m = routes.find(r => r.method === (init.method || 'GET') && r.path.test(url));
    return Promise.resolve(m ? res(m.response.status, m.response.body) : res(599, { errors: [`unexpected ${init.method} ${url}`] }));
  });
}
function bodyAt(mock: jest.SpyInstance, i: number): any { return JSON.parse((mock.mock.calls[i][1] as RequestInit).body as string); }

beforeEach(() => _resetZoneUrlCache());
afterEach(() => jest.restoreAllMocks());

describe('buildContactSearchFilter (§6.3)', () => {
  test('single term: OR contains across first/last/email', () => {
    const f = buildContactSearchFilter('acme');
    expect(f.op).toBe('or');
    expect(f.items).toEqual(expect.arrayContaining([
      { op: 'contains', field: 'firstName', value: 'acme' },
      { op: 'contains', field: 'lastName', value: 'acme' },
      { op: 'contains', field: 'emailAddress', value: 'acme' },
    ]));
  });
  test('full name adds a combined firstName AND lastName group', () => {
    const f = buildContactSearchFilter('Joan Eberly');
    expect(f.items).toContainEqual({ op: 'and', items: [
      { op: 'contains', field: 'firstName', value: 'Joan' },
      { op: 'contains', field: 'lastName', value: 'Eberly' },
    ]});
  });
  test('email term adds an exact emailAddress match', () => {
    const f = buildContactSearchFilter('joan@example.com');
    expect(f.items).toContainEqual({ op: 'eq', field: 'emailAddress', value: 'joan@example.com' });
  });
});

describe('normalizeContactNote (§6.2)', () => {
  test('passes a short note through', () => {
    expect(normalizeContactNote('hello')).toBe('hello');
  });
  test('throws over the limit by default', () => {
    expect(() => normalizeContactNote('x'.repeat(CONTACT_NOTE_MAX_LENGTH + 1))).toThrow(/50-character limit/);
  });
  test('truncates when opted in', () => {
    const out = normalizeContactNote('x'.repeat(80), { truncate: true });
    expect(out).toHaveLength(CONTACT_NOTE_MAX_LENGTH);
  });
  test('undefined/null pass through as undefined', () => {
    expect(normalizeContactNote(undefined)).toBeUndefined();
    expect(normalizeContactNote(null)).toBeUndefined();
  });
});

describe('resolveCompanyOwnerResourceID (§6.1)', () => {
  test('uses supplied ownerResourceID', () => {
    expect(resolveCompanyOwnerResourceID({ ownerResourceID: 7 }, {} as any)).toBe(7);
  });
  test('falls back to AUTOTASK_DEFAULT_OWNER_RESOURCE_ID', () => {
    expect(resolveCompanyOwnerResourceID({}, { AUTOTASK_DEFAULT_OWNER_RESOURCE_ID: '99' } as any)).toBe(99);
  });
  test('throws when neither is available', () => {
    expect(() => resolveCompanyOwnerResourceID({}, {} as any)).toThrow(/ownerResourceID/);
  });
});

describe('service wiring', () => {
  test('searchContacts sends the combined name filter', async () => {
    const mock = mockRoutes([{ method: 'POST', path: /\/Contacts\/query$/, response: { status: 200, body: { items: [] } } }]);
    await new AutotaskService(config, logger).searchContacts({ searchTerm: 'Joan Eberly' });
    const filter = bodyAt(mock, 0).filter;
    // The OR group is the single top-level filter.
    expect(filter[0].items).toContainEqual({ op: 'and', items: [
      { op: 'contains', field: 'firstName', value: 'Joan' },
      { op: 'contains', field: 'lastName', value: 'Eberly' },
    ]});
  });

  test('createCompany injects ownerResourceID from env default', async () => {
    const prev = process.env.AUTOTASK_DEFAULT_OWNER_RESOURCE_ID;
    process.env.AUTOTASK_DEFAULT_OWNER_RESOURCE_ID = '30683829';
    const mock = mockRoutes([{ method: 'POST', path: /\/Companies$/, response: { status: 200, body: { itemId: 1 } } }]);
    try {
      await new AutotaskService(config, logger).createCompany({ companyName: 'Acme Technology' });
      expect(bodyAt(mock, 0).ownerResourceID).toBe(30683829);
    } finally {
      if (prev === undefined) delete process.env.AUTOTASK_DEFAULT_OWNER_RESOURCE_ID; else process.env.AUTOTASK_DEFAULT_OWNER_RESOURCE_ID = prev;
    }
  });

  test('createCompany refuses without owner or env default (no API call)', async () => {
    const prev = process.env.AUTOTASK_DEFAULT_OWNER_RESOURCE_ID;
    delete process.env.AUTOTASK_DEFAULT_OWNER_RESOURCE_ID;
    const mock = mockRoutes([{ method: 'POST', path: /\/Companies$/, response: { status: 200, body: { itemId: 1 } } }]);
    try {
      await expect(new AutotaskService(config, logger).createCompany({ companyName: 'Acme Technology' }))
        .rejects.toThrow(/ownerResourceID/);
      expect(mock).not.toHaveBeenCalled();
    } finally {
      if (prev !== undefined) process.env.AUTOTASK_DEFAULT_OWNER_RESOURCE_ID = prev;
    }
  });

  test('createContact rejects an over-length note before hitting the API', async () => {
    const mock = mockRoutes([]);
    await expect(new AutotaskService(config, logger).createContact({
      companyID: 777, firstName: 'A', note: 'x'.repeat(80),
    } as any)).rejects.toThrow(/50-character limit/);
    expect(mock).not.toHaveBeenCalled();
  });

  test('updateOpportunity uses collection PATCH /Opportunities with id in body (§4.7)', async () => {
    const mock = mockRoutes([{ method: 'PATCH', path: /\/Opportunities$/, response: { status: 200, body: { itemId: 500 } } }]);
    await new AutotaskService(config, logger).updateOpportunity(500, { status: 3 });
    expect(mock.mock.calls.map((c: any[]) => new URL(c[0] as string).pathname)).toEqual(['/ATServicesRest/v1.0/Opportunities']);
    expect(bodyAt(mock, 0)).toEqual({ id: 500, status: 3 });
  });
});

describe('tool registration', () => {
  test('autotask_update_opportunity is defined and categorized', () => {
    expect(TOOL_DEFINITIONS.some(t => t.name === 'autotask_update_opportunity')).toBe(true);
    const inSomeCategory = Object.values(TOOL_CATEGORIES).some(c => c.tools.includes('autotask_update_opportunity'));
    expect(inSomeCategory).toBe(true);
  });
});
