// #42 slice 3 — my_day + idempotent log_my_time for the scheduled assistant.
// The MCP provides safe primitives; the assistant (calendar/meetings/emails)
// does the matching. Mocked http / service.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { TOOL_DEFINITIONS, TOOL_CATEGORIES } from '../src/handlers/tool.definitions';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
function withHttp(fake: any) {
  const service = new AutotaskService(config, logger);
  jest.spyOn(service as any, 'ensureClient').mockResolvedValue(fake);
  return service;
}
const findTool = (name: string) => TOOL_DEFINITIONS.find((t) => t.name === name);
afterEach(() => jest.restoreAllMocks());

/** Wrap fixture rows in the PagedResult envelope the search methods now return. */
const pagedOf = <T>(items: T[]) => ({ items, page: 1, pageSize: 25, hasMore: false });

describe('getMyDay (#42)', () => {
  test('aggregates assigned tickets, the day\'s time entries, and open tasks', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 1, hoursWorked: 1.5 }, { id: 2, hoursWorked: 2 }]); // TimeEntries
    const svc = withHttp({ query });
    jest.spyOn(svc, 'searchTickets').mockResolvedValue(pagedOf([{ id: 10 } as any, { id: 11 } as any]));
    jest.spyOn(svc, 'searchTasks').mockResolvedValue(pagedOf([{ id: 20 } as any]));
    const r = await svc.getMyDay(5, '2026-09-15');
    expect(r.date).toBe('2026-09-15');
    expect(r.totals).toMatchObject({ assignedTickets: 2, timeEntries: 2, hoursLogged: 3.5 });
    expect(r.openTasks).toHaveLength(1);
    // TimeEntries filtered by resource + dateWorked
    expect(query).toHaveBeenCalledWith('TimeEntries', [
      { op: 'eq', field: 'resourceID', value: 5 },
      { op: 'eq', field: 'dateWorked', value: '2026-09-15' },
    ], expect.anything());
  });

  test('fail-soft: a failing section is recorded, not thrown', async () => {
    const query = jest.fn().mockRejectedValue(new Error('boom')); // TimeEntries fails
    const svc = withHttp({ query });
    jest.spyOn(svc, 'searchTickets').mockResolvedValue(pagedOf([]));
    jest.spyOn(svc, 'searchTasks').mockResolvedValue(pagedOf([]));
    const r = await svc.getMyDay(5, '2026-09-15');
    expect(r.errors.map((e: any) => e.section)).toEqual(['timeEntries', 'serviceCalls', 'todos']);
    expect(r.timeEntries).toEqual([]);
    expect(r.missingTime).toEqual([]); // no gaps invented from failed reads
  });
});

describe('logTimeIdempotent (#42)', () => {
  test('skips when a same-day, same-ticket entry with the same summary exists', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 700, summaryNotes: 'Firmware review' }]);
    const svc = withHttp({ query });
    const create = jest.spyOn(svc, 'createTimeEntry').mockResolvedValue(999);
    const r = await svc.logTimeIdempotent({ resourceID: 5, dateWorked: '2026-09-15', ticketID: 10, summaryNotes: 'firmware review', hoursWorked: 1 });
    expect(r).toEqual({ created: false, id: 700, duplicateOf: 700 });
    expect(create).not.toHaveBeenCalled();
  });

  test('creates when no matching entry exists', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 700, summaryNotes: 'something else' }]);
    const svc = withHttp({ query });
    const create = jest.spyOn(svc, 'createTimeEntry').mockResolvedValue(999);
    const r = await svc.logTimeIdempotent({ resourceID: 5, dateWorked: '2026-09-15', ticketID: 10, summaryNotes: 'Firmware review', hoursWorked: 1 });
    expect(r).toEqual({ created: true, id: 999 });
    expect(create).toHaveBeenCalled();
  });

  test('guard-read failure falls through to create (never blocks logging)', async () => {
    const query = jest.fn().mockRejectedValue(new Error('guard read failed'));
    const svc = withHttp({ query });
    jest.spyOn(svc, 'createTimeEntry').mockResolvedValue(999);
    const r = await svc.logTimeIdempotent({ resourceID: 5, dateWorked: '2026-09-15', summaryNotes: 'x', hoursWorked: 1 });
    expect(r).toEqual({ created: true, id: 999 });
  });
});

describe('handler wiring (#42)', () => {
  test('log_my_time defaults to the caller, auto-fills role, and logs idempotently', async () => {
    const service = new AutotaskService(config, logger);
    jest.spyOn(service, 'resolveResourceDefaultRole').mockResolvedValue(99);
    const log = jest.spyOn(service, 'logTimeIdempotent').mockResolvedValue({ created: true, id: 5 });
    const handler = new AutotaskToolHandler(service, logger);
    jest.spyOn(handler as any, 'resolveCaller').mockResolvedValue({ status: 'resolved', resource: { id: 5, name: 'Me' } });
    await handler.callTool('autotask_log_my_time', { ticketID: 10, hoursWorked: 1, summaryNotes: 'Did the thing' });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ resourceID: 5, roleID: 99, ticketID: 10, summaryNotes: 'Did the thing' }));
  });

  test('get_my_day defaults to the caller', async () => {
    const service = new AutotaskService(config, logger);
    const myDay = jest.spyOn(service, 'getMyDay').mockResolvedValue({ date: '2026-09-15', totals: { assignedTickets: 0, timeEntries: 0, hoursLogged: 0 }, openTasks: [] } as any);
    const handler = new AutotaskToolHandler(service, logger);
    jest.spyOn(handler as any, 'resolveCaller').mockResolvedValue({ status: 'resolved', resource: { id: 5, name: 'Me' } });
    await handler.callTool('autotask_get_my_day', {});
    expect(myDay).toHaveBeenCalledWith(5, undefined, undefined); // (resourceID, date, timeZone)
  });

  test('log_my_time reports a skipped duplicate', async () => {
    const service = new AutotaskService(config, logger);
    jest.spyOn(service, 'resolveResourceDefaultRole').mockResolvedValue(99);
    jest.spyOn(service, 'logTimeIdempotent').mockResolvedValue({ created: false, id: 700, duplicateOf: 700 });
    const handler = new AutotaskToolHandler(service, logger);
    jest.spyOn(handler as any, 'resolveCaller').mockResolvedValue({ status: 'resolved', resource: { id: 5, name: 'Me' } });
    const result = await handler.callTool('autotask_log_my_time', { ticketID: 10, hoursWorked: 1, summaryNotes: 'dupe' });
    expect(JSON.parse(result.content[0].text).message).toMatch(/duplicate of existing time entry 700/i);
  });
});

describe('tool surface (#42 slice 3)', () => {
  test('tools exist with expected shapes and categories', () => {
    expect((findTool('autotask_get_my_day') as any).annotations.readOnlyHint).toBe(true);
    expect(findTool('autotask_log_my_time')!.inputSchema.required).toEqual(['summaryNotes']);
    const categorized = new Set(Object.values(TOOL_CATEGORIES).flatMap((c: any) => c.tools));
    expect(categorized.has('autotask_get_my_day')).toBe(true);
    expect(categorized.has('autotask_log_my_time')).toBe(true);
  });
});
