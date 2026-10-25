// Company To-Dos (CRM calendar follow-ups) — brief §4.1 / §4.10.

import { resolveActionType } from '../src/utils/company-todo';
import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { TOOL_DEFINITIONS, TOOL_CATEGORIES } from '../src/handlers/tool.definitions';
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
    apiUrl: 'https://webservices2.autotask.net/ATServicesRest/',
  },
};

function res(status: number, body?: any): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => (body !== undefined ? JSON.stringify(body) : ''),
  } as unknown as Response;
}

const ACTION_TYPE_FIELDS = {
  fields: [{ name: 'actionType', isPickList: true, picklistValues: [
    { value: 3, label: 'General' },
    { value: 29682843, label: 'Sales' },
    { value: 1, label: 'Phone Call' },
  ] }],
};

function mockRoutes(routes: Array<{ method: string; path: RegExp; response: { status: number; body?: any } }>): jest.SpyInstance {
  return jest.spyOn(global, 'fetch' as any).mockImplementation((...args: any[]) => {
    const url = args[0] as string;
    const init = (args[1] || {}) as RequestInit;
    const match = routes.find(r => r.method === (init.method || 'GET') && r.path.test(url));
    if (!match) return Promise.resolve(res(599, { errors: [`unexpected ${init.method} ${url}`] }));
    return Promise.resolve(res(match.response.status, match.response.body));
  });
}

function bodyAt(mock: jest.SpyInstance, i: number): any {
  return JSON.parse((mock.mock.calls[i][1] as RequestInit).body as string);
}
function routes(mock: jest.SpyInstance): string[] {
  return mock.mock.calls.map((c: any[]) => `${(c[1] as RequestInit).method} ${new URL(c[0] as string).pathname}`);
}

beforeEach(() => _resetZoneUrlCache());
afterEach(() => jest.restoreAllMocks());

describe('resolveActionType (pure)', () => {
  const pl = [{ value: 3, label: 'General' }, { value: 29682843, label: 'Sales' }];
  test('numeric actionType passes through without needing the picklist', () => {
    expect(resolveActionType({ actionType: 42 }, [])).toBe(42);
  });
  test('resolves actionTypeName case-insensitively', () => {
    expect(resolveActionType({ actionTypeName: 'sALes' }, pl)).toBe(29682843);
  });
  test('defaults to General when neither is given', () => {
    expect(resolveActionType({}, pl)).toBe(3);
  });
  test('rejects supplying both', () => {
    expect(() => resolveActionType({ actionType: 1, actionTypeName: 'Sales' }, pl)).toThrow(/exactly one/i);
  });
  test('unknown name lists available labels', () => {
    expect(() => resolveActionType({ actionTypeName: 'Nope' }, pl)).toThrow(/General, Sales/);
  });
});

describe('AutotaskService CompanyToDo writes', () => {
  test('create resolves actionTypeName via metadata and posts to the company child route', async () => {
    const mock = mockRoutes([
      { method: 'GET', path: /\/CompanyToDos\/entityInformation\/fields$/, response: { status: 200, body: ACTION_TYPE_FIELDS } },
      { method: 'POST', path: /\/Companies\/29684773\/ToDos$/, response: { status: 200, body: { itemId: 29722498 } } },
    ]);
    const id = await new AutotaskService(config, logger).createCompanyToDo({
      companyID: 29684773,
      assignedToResourceID: 30683829,
      actionTypeName: 'Sales',
      startDateTime: '2026-08-26T14:00:00Z',
      endDateTime: '2026-08-26T15:00:00Z',
      ticketID: 204722,
    });
    expect(id).toBe(29722498);
    expect(routes(mock)).toContain('POST /ATServicesRest/v1.0/Companies/29684773/ToDos');
    const postBody = bodyAt(mock, 1);
    expect(postBody.actionType).toBe(29682843);
    expect(postBody.actionTypeName).toBeUndefined();
    expect(postBody.ticketID).toBe(204722);
  });

  test('create requires companyID before any API call', async () => {
    const mock = mockRoutes([]);
    await expect(
      new AutotaskService(config, logger).createCompanyToDo({
        assignedToResourceID: 1, startDateTime: 'a', endDateTime: 'b',
      } as any)
    ).rejects.toThrow(/companyID is required/);
    expect(mock).not.toHaveBeenCalled();
  });

  test('complete sets completedDate via PATCH /Companies/{id}/ToDos, resolving companyID from the record', async () => {
    const mock = mockRoutes([
      { method: 'GET', path: /\/CompanyToDos\/29722498$/, response: { status: 200, body: { item: { id: 29722498, companyID: 29684773, completedDate: null } } } },
      { method: 'PATCH', path: /\/Companies\/29684773\/ToDos$/, response: { status: 200, body: { itemId: 29722498 } } },
    ]);
    const completedDate = await new AutotaskService(config, logger).completeCompanyToDo(29722498);
    expect(typeof completedDate).toBe('string');
    expect(routes(mock)).toEqual([
      'GET /ATServicesRest/v1.0/CompanyToDos/29722498',
      'PATCH /ATServicesRest/v1.0/Companies/29684773/ToDos',
    ]);
    const patchBody = bodyAt(mock, 1);
    expect(patchBody.id).toBe(29722498);
    expect(patchBody.completedDate).toBe(completedDate);
  });

  test('open-only search filters completedDate is null', async () => {
    const mock = mockRoutes([
      { method: 'POST', path: /\/CompanyToDos\/query$/, response: { status: 200, body: { items: [] } } },
    ]);
    await new AutotaskService(config, logger).searchCompanyToDos({ companyID: 29684773, openOnly: true });
    const queryBody = bodyAt(mock, 0);
    expect(queryBody.filter).toContainEqual({ op: 'eq', field: 'completedDate', value: null });
    expect(queryBody.filter).toContainEqual({ op: 'eq', field: 'companyID', value: 29684773 });
  });
});

describe('router distinguishes To-Do from time entry (§4.10)', () => {
  function suggest(intent: string) {
    const handler = new AutotaskToolHandler(new AutotaskService(config, logger), logger);
    return handler.callTool('autotask_router', { intent }).then(r => JSON.parse(r.content[0].text).data);
  }

  test('"sales follow-up To-Do" routes to create_company_todo, not a time entry', async () => {
    const d = await suggest('Create a sales follow-up To-Do two hours from now.');
    expect(d.suggestedTool).toBe('autotask_create_company_todo');
    expect(d.suggestedParams.actionTypeName).toBe('Sales');
  });

  test('"log six minutes of Sales time" still routes to a time entry', async () => {
    const d = await suggest('Log 0.1 hours of Sales time on ticket 204722.');
    expect(d.suggestedTool).toBe('autotask_create_time_entry');
  });
});

describe('tool + category registration', () => {
  test('all six CompanyToDo tools are defined and categorized', () => {
    const names = new Set(TOOL_DEFINITIONS.map(t => t.name));
    const expected = [
      'autotask_get_company_todo', 'autotask_search_company_todos', 'autotask_create_company_todo',
      'autotask_update_company_todo', 'autotask_complete_company_todo', 'autotask_delete_company_todo',
    ];
    for (const n of expected) expect(names.has(n)).toBe(true);
    expect(TOOL_CATEGORIES.company_todos.tools).toEqual(expect.arrayContaining(expected));
  });
});
