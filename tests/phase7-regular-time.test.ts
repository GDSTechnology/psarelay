// Timesheet P1 fixes: Regular Time categories come from BillingCodes useType=3
// (not work types), case-insensitive exact resolve, get_my_day splits the three
// time types, and idempotency scopes to category + start time. Service mocked.

import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' } };
const mk = () => new AutotaskService(config, new Logger('error'));

describe('Regular Time categories (useType 3)', () => {
  test('getRegularTimeCategories queries useType=3, returns {id,name,active} sorted', async () => {
    const s = mk();
    const query = jest.fn().mockResolvedValue([
      { id: 2, name: 'Office Management', isActive: true, useType: 3 },
      { id: 1, name: 'Internal Meeting', isActive: true, useType: 3 },
      { id: 3, name: 'Old Category', isActive: false, useType: 3 },
    ]);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query });
    const r = await s.getRegularTimeCategories();
    expect(query.mock.calls[0][1]).toEqual([{ op: 'eq', field: 'useType', value: 3 }]);
    expect(r.map((c) => c.name)).toEqual(['Internal Meeting', 'Office Management', 'Old Category']); // sorted
    expect(r.find((c) => c.name === 'Old Category')!.active).toBe(false);
  });

  test('getInternalBillingCodeNames returns only ACTIVE category names', async () => {
    const s = mk();
    jest.spyOn(s, 'getRegularTimeCategories').mockResolvedValue([
      { id: 1, name: 'Internal Meeting', active: true },
      { id: 3, name: 'Old Category', active: false },
    ]);
    expect(await s.getInternalBillingCodeNames()).toEqual(['Internal Meeting']);
  });

  test('resolveInternalBillingCodeByName is case-insensitive exact (no fuzzy)', async () => {
    const s = mk();
    jest.spyOn(s, 'getRegularTimeCategories').mockResolvedValue([
      { id: 1, name: 'Internal Meeting', active: true },
      { id: 2, name: 'Non-billable Meeting', active: true },
    ]);
    expect(await s.resolveInternalBillingCodeByName('internal meeting')).toEqual({ id: 1, name: 'Internal Meeting' });
    expect(await s.resolveInternalBillingCodeByName('MEETING')).toBeNull(); // no fuzzy across categories
    expect(await s.resolveInternalBillingCodeByName('nope')).toBeNull();
  });
});

describe('get_my_day splits the three time types', () => {
  test('ticket/task/regular buckets + billable totals', async () => {
    const s = mk();
    jest.spyOn(s, 'searchTickets').mockResolvedValue({ items: [] } as any);
    jest.spyOn(s, 'searchTasks').mockResolvedValue({ items: [] } as any);
    const entries = [
      { ticketID: 10, hoursWorked: 2, isNonBillable: false },
      { taskID: 20, hoursWorked: 3, isNonBillable: false },
      { internalBillingCodeID: 1, hoursWorked: 1, isNonBillable: true }, // regular
    ];
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query: async () => entries });
    const r = await s.getMyDay(99, '2026-09-22');
    expect(r.ticketTime).toHaveLength(1);
    expect(r.taskTime).toHaveLength(1);
    expect(r.regularTime).toHaveLength(1);
    expect(r.totals).toMatchObject({ ticketHours: 2, taskHours: 3, regularHours: 1, hoursLogged: 6, billableHours: 5, nonBillableHours: 1 });
  });
});

describe('ticket/task time start-stop derivation', () => {
  test('ticket time with hours but no span derives start/stop on the work date', async () => {
    const s = mk();
    const create = jest.fn().mockResolvedValue(1);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ create });
    await s.createTimeEntry({ ticketID: 204722, resourceID: 1, roleID: 5, dateWorked: '2026-09-22', hoursWorked: 0.25, summaryNotes: 'x' } as any);
    const body = create.mock.calls[0][1];
    expect(body.startDateTime).toBe('2026-09-22T09:00:00');
    expect(body.endDateTime).toBe('2026-09-22T09:15:00'); // 09:00 + 0.25h
  });

  test('caller-supplied start/stop is preserved (calendar-derived)', async () => {
    const s = mk();
    const create = jest.fn().mockResolvedValue(1);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ create });
    await s.createTimeEntry({ ticketID: 204722, resourceID: 1, roleID: 5, dateWorked: '2026-09-22', hoursWorked: 1, startDateTime: '2026-09-22T16:00:00', endDateTime: '2026-09-22T17:00:00', summaryNotes: 'x' } as any);
    const body = create.mock.calls[0][1];
    expect(body.startDateTime).toBe('2026-09-22T16:00:00');
    expect(body.endDateTime).toBe('2026-09-22T17:00:00');
  });

  test('regular time (no ticket/task) is NOT given a derived span', async () => {
    const s = mk();
    const create = jest.fn().mockResolvedValue(1);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ create });
    await s.createTimeEntry({ internalBillingCodeID: 9, resourceID: 1, dateWorked: '2026-09-22', hoursWorked: 1, summaryNotes: 'x' } as any);
    const body = create.mock.calls[0][1];
    expect(body.startDateTime).toBeUndefined();
    expect(body.endDateTime).toBeUndefined();
  });

  test('full span given, hoursWorked omitted → derives worked hours from the span', async () => {
    const s = mk();
    const create = jest.fn().mockResolvedValue(1);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ create });
    await s.createTimeEntry({ ticketID: 1, resourceID: 1, roleID: 5, dateWorked: '2026-09-22', startDateTime: '2026-09-22T01:46:00', endDateTime: '2026-09-22T09:46:00', summaryNotes: 'x' } as any);
    expect(create.mock.calls[0][1].hoursWorked).toBe(8);
  });

  // hoursToBill is READ-ONLY (live entityInformation, 2026-09-29): Autotask
  // derives it from hoursWorked − offsetHours + contract rounding and ignores a
  // supplied value, so the offset is sent and hoursToBill never is.
  test('billing offset (lunch) sends offsetHours, never the read-only hoursToBill', async () => {
    const s = mk();
    const create = jest.fn().mockResolvedValue(1);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ create });
    await s.createTimeEntry({ ticketID: 1, resourceID: 1, roleID: 5, dateWorked: '2026-09-22', hoursWorked: 8, offsetHours: 0.5, hoursToBill: 7.5, summaryNotes: 'x' } as any);
    expect(create.mock.calls[0][1].offsetHours).toBe(0.5);
    expect(create.mock.calls[0][1]).not.toHaveProperty('hoursToBill');
  });

  test('updateTimeEntry never sends the read-only hoursToBill', async () => {
    const s = mk();
    const update = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ update });
    await s.updateTimeEntry(7, { hoursToBill: 0.1, summaryNotes: 'y' } as any);
    expect(update.mock.calls[0][2]).toEqual({ summaryNotes: 'y' });
  });

  test('hours-only span rolls past midnight to the next day', async () => {
    const s = mk();
    const create = jest.fn().mockResolvedValue(1);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ create });
    await s.createTimeEntry({ ticketID: 1, resourceID: 1, roleID: 5, dateWorked: '2026-09-22', hoursWorked: 18, summaryNotes: 'x' } as any);
    const body = create.mock.calls[0][1];
    expect(body.startDateTime).toBe('2026-09-22T09:00:00');
    expect(body.endDateTime).toBe('2026-09-23T03:00:00'); // 09:00 + 18h → next day 03:00
  });
});

describe('logTimeIdempotent scoping', () => {
  test('regular time: same category + summary + start = duplicate (not re-created)', async () => {
    const s = mk();
    const query = jest.fn().mockResolvedValue([
      { id: 500, summaryNotes: 'Peer Meeting', internalBillingCodeID: 1, startDateTime: '2026-09-22T16:00:00Z' },
    ]);
    const create = jest.spyOn(s, 'createTimeEntry').mockResolvedValue(999 as any);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query });
    const r = await s.logTimeIdempotent({ resourceID: 1, dateWorked: '2026-09-22', summaryNotes: 'Peer Meeting', internalBillingCodeID: 1, startDateTime: '2026-09-22T16:00:00Z' } as any);
    expect(r).toEqual({ created: false, id: 500, duplicateOf: 500 });
    expect(create).not.toHaveBeenCalled();
    // category is part of the guard scope
    expect(query.mock.calls[0][1]).toEqual(expect.arrayContaining([{ op: 'eq', field: 'internalBillingCodeID', value: 1 }]));
  });

  test('same summary/category but different start time = distinct (created)', async () => {
    const s = mk();
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query: async () => [
      { id: 500, summaryNotes: 'Peer Meeting', internalBillingCodeID: 1, startDateTime: '2026-09-22T16:00:00Z' },
    ] });
    const create = jest.spyOn(s, 'createTimeEntry').mockResolvedValue(999 as any);
    const r = await s.logTimeIdempotent({ resourceID: 1, dateWorked: '2026-09-22', summaryNotes: 'Peer Meeting', internalBillingCodeID: 1, startDateTime: '2026-09-22T18:00:00Z' } as any);
    expect(r.created).toBe(true);
    expect(create).toHaveBeenCalled();
  });
});
