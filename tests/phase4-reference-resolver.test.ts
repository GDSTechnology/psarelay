// Canonical record-reference resolver (brief §7.30):
// "T20260825.0006" can be a Ticket OR a project Task — resolve by searching
// both, never by the prefix; return matched / ambiguous / not-found.

import {
  classifyReferenceMatches,
  isRecordReferenceShape,
  ReferenceCandidate,
} from '../src/utils/reference.resolver';
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

/** Mock POST /{Tickets|Tasks}/query, returning caller-supplied rows per entity. */
function mockResolve(tickets: any[], tasks: any[]): jest.SpyInstance {
  return jest.spyOn(global, 'fetch' as any).mockImplementation((...args: any[]) => {
    const url = args[0] as string;
    const init = (args[1] || {}) as RequestInit;
    if (init.method !== 'POST') return Promise.resolve(res(599, { errors: ['unexpected'] }));
    if (/\/Tickets\/query$/.test(url)) return Promise.resolve(res(200, { items: tickets }));
    if (/\/Tasks\/query$/.test(url)) return Promise.resolve(res(200, { items: tasks }));
    return Promise.resolve(res(599, { errors: [`unexpected ${url}`] }));
  });
}

beforeEach(() => _resetZoneUrlCache());
afterEach(() => jest.restoreAllMocks());

describe('classifyReferenceMatches (pure)', () => {
  const ticket: ReferenceCandidate = { entityType: 'ticket', id: 204722, reference: 'T20260825.0006', title: 'Printer down' };
  const task: ReferenceCandidate = { entityType: 'task', id: 555, reference: 'T20260825.0006' };

  test('no matches -> not-found', () => {
    expect(classifyReferenceMatches('T20260825.0006', [])).toEqual({
      status: 'not-found',
      reference: 'T20260825.0006',
    });
  });

  test('single match -> matched with typed id (and title when present)', () => {
    expect(classifyReferenceMatches('T20260825.0006', [ticket])).toEqual({
      status: 'matched',
      reference: 'T20260825.0006',
      entityType: 'ticket',
      id: 204722,
      title: 'Printer down',
    });
  });

  test('single match without title omits the title key', () => {
    const out = classifyReferenceMatches('T20260825.0006', [task]);
    expect(out.status).toBe('matched');
    expect('title' in out).toBe(false);
  });

  test('multiple matches -> ambiguous, no id chosen', () => {
    const out = classifyReferenceMatches('T20260825.0006', [ticket, task]);
    expect(out.status).toBe('ambiguous');
    expect(out.id).toBeUndefined();
    expect(out.candidates).toHaveLength(2);
  });

  test('trims the reference', () => {
    expect(classifyReferenceMatches('  T1.2  ', []).reference).toBe('T1.2');
  });
});

describe('isRecordReferenceShape', () => {
  test.each([
    ['T20260825.0006', true],
    ['t20260825.0006', true],
    ['T20260825.6', true],
    ['20260825.0006', false], // no leading letter
    ['T20260825', false], // no sequence
    ['hello', false],
  ])('%s -> %s', (input, expected) => {
    expect(isRecordReferenceShape(input)).toBe(expected);
  });
});

describe('AutotaskService.resolveRecordReference', () => {
  test('ticket-only match resolves to the ticket and queries both entities', async () => {
    const fetchMock = mockResolve(
      [{ id: 204722, ticketNumber: 'T20260825.0006', title: 'Printer down' }],
      []
    );
    const out = await new AutotaskService(config, logger).resolveRecordReference('T20260825.0006');

    expect(out).toEqual({
      status: 'matched',
      reference: 'T20260825.0006',
      entityType: 'ticket',
      id: 204722,
      title: 'Printer down',
    });
    const paths = fetchMock.mock.calls.map((c: any[]) => new URL(c[0] as string).pathname);
    expect(paths).toEqual(
      expect.arrayContaining(['/ATServicesRest/v1.0/Tickets/query', '/ATServicesRest/v1.0/Tasks/query'])
    );
  });

  test('task-only match resolves to the task', async () => {
    mockResolve([], [{ id: 555, taskNumber: 'T20260825.0006', title: 'Cabling' }]);
    const out = await new AutotaskService(config, logger).resolveRecordReference('T20260825.0006');
    expect(out).toMatchObject({ status: 'matched', entityType: 'task', id: 555, title: 'Cabling' });
  });

  test('a hit in both entities is ambiguous', async () => {
    mockResolve(
      [{ id: 204722, ticketNumber: 'T20260825.0006' }],
      [{ id: 555, taskNumber: 'T20260825.0006' }]
    );
    const out = await new AutotaskService(config, logger).resolveRecordReference('T20260825.0006');
    expect(out.status).toBe('ambiguous');
    expect(out.candidates?.map((c) => c.entityType).sort()).toEqual(['task', 'ticket']);
  });

  test('no hits is not-found', async () => {
    mockResolve([], []);
    const out = await new AutotaskService(config, logger).resolveRecordReference('T20260825.9999');
    expect(out).toEqual({ status: 'not-found', reference: 'T20260825.9999' });
  });

  test('blank reference short-circuits without querying', async () => {
    const fetchMock = mockResolve([], []);
    const out = await new AutotaskService(config, logger).resolveRecordReference('   ');
    expect(out).toEqual({ status: 'not-found', reference: '' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('autotask_resolve_record_reference tool', () => {
  test('dispatches and returns a human message for a match', async () => {
    const service = new AutotaskService(config, logger);
    jest.spyOn(service, 'resolveRecordReference').mockResolvedValue({
      status: 'matched',
      reference: 'T20260825.0006',
      entityType: 'ticket',
      id: 204722,
      title: 'Printer down',
    });
    const handler = new AutotaskToolHandler(service, logger);
    const result = await handler.callTool('autotask_resolve_record_reference', { reference: 'T20260825.0006' });
    const text = result.content[0].text;
    expect(text).toContain('ticket 204722');
    expect(text).toContain('Printer down');
  });
});
