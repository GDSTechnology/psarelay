// Appointments (#21 §5): local time ↔ UTC, overlap refusal, rerun safety, PATCH-only updates,
// delete reads first, free-time slots, and the filters sent upstream (a dropped filter looks like a broad search).

import { AutotaskService } from '../src/services/autotask.service';
import { TOOL_DEFINITIONS, TOOL_CATEGORIES } from '../src/handlers/tool.definitions';
import { ACTING_RESOURCE_TOOLS, CURRENT_USER_DEFAULT_TOOLS } from '../src/utils/caller-resolution';
import { freeSlots, localWallClock, resolveTimes, withLocalTimes, conflictsWith } from '../src/utils/appointments';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
const NY = 'America/New_York';
afterEach(() => jest.restoreAllMocks());

function world(appts: Array<Record<string, any>> = [], extra: Record<string, any> = {}) {
  const store = new Map(appts.map((a) => [Number(a.id), { ...a }]));
  const http = {
    query: jest.fn(async (entity: string, filters: any[]) => {
      if (entity !== 'Appointments') return [];
      const lt = filters.find((f) => f.op === 'lt')?.value; const gt = filters.find((f) => f.op === 'gt')?.value;
      const rid = filters.find((f) => f.field === 'resourceID');
      return [...store.values()].filter((a) => (!lt || a.startDateTime < lt) && (!gt || a.endDateTime > gt)
        && (!rid || (rid.op === 'eq' ? a.resourceID === rid.value : rid.value.includes(a.resourceID))));
    }),
    get: jest.fn(async (_e: string, id: number) => store.get(Number(id)) ?? null),
    create: jest.fn(async (_e: string, body: any) => { const id = 900 + store.size; store.set(id, { id, ...body }); return id; }),
    update: jest.fn(async (_e: string, id: number, patch: any) => { store.set(id, { ...store.get(id), ...patch }); }),
    delete: jest.fn(async (_e: string, id: number) => { store.delete(id); }),
    ...extra,
  };
  const svc = new AutotaskService(config, logger);
  jest.spyOn(svc as any, 'ensureClient').mockResolvedValue(http);
  jest.spyOn(svc, 'getResourceNames').mockResolvedValue(new Map([[5, 'Tech Five'], [6, 'Tech Six']]));
  return { svc, http, store };
}

describe('time helpers', () => {
  test('local wall-clock + zone → UTC, DST-aware; offset ISO used as-is', () => {
    expect(resolveTimes({ startDateTime: '2026-11-20T14:00', durationMinutes: 30, timeZone: NY })).toEqual({ ok: true, start: '2026-11-20T19:00:00Z', end: '2026-11-20T19:30:00Z' });
    expect(resolveTimes({ startDateTime: '2026-07-20T14:00', endDateTime: '2026-07-20T15:00', timeZone: NY })).toEqual({ ok: true, start: '2026-07-20T18:00:00Z', end: '2026-07-20T19:00:00Z' });
    expect(resolveTimes({ startDateTime: '2026-11-20T14:00:00-08:00', durationMinutes: 60, timeZone: NY })).toMatchObject({ start: '2026-11-20T22:00:00Z' });
    expect(localWallClock('2026-11-20T19:00:00Z', NY)).toBe('2026-11-20T14:00:00');
  });
  test('refuses end before start, no end, and absurd lengths', () => {
    expect(resolveTimes({ startDateTime: '2026-11-20T14:00', endDateTime: '2026-11-20T13:00', timeZone: NY }).ok).toBe(false);
    expect(resolveTimes({ startDateTime: '2026-11-20T14:00', timeZone: NY }).ok).toBe(false);
    expect(resolveTimes({ startDateTime: '2026-11-01T14:00', endDateTime: '2026-12-01T14:00', timeZone: NY }).ok).toBe(false);
  });
  test('withLocalTimes adds local times and minutes; touching ends do not conflict', () => {
    expect(withLocalTimes({ startDateTime: '2026-11-20T19:00:00Z', endDateTime: '2026-11-20T20:30:00Z' }, NY)).toMatchObject({ startLocal: '2026-11-20T14:00:00', endLocal: '2026-11-20T15:30:00', durationMinutes: 90, timeZone: NY });
    const busy = [{ kind: 'appointment' as const, id: 1, start: '2026-11-20T19:00:00Z', end: '2026-11-20T20:00:00Z' }];
    expect(conflictsWith(busy, '2026-11-20T20:00:00Z', '2026-11-20T21:00:00Z')).toHaveLength(0);
    expect(conflictsWith(busy, '2026-11-20T19:30:00Z', '2026-11-20T21:00:00Z')).toHaveLength(1);
    expect(conflictsWith(busy, '2026-11-20T19:30:00Z', '2026-11-20T21:00:00Z', 1)).toHaveLength(0);
  });
  test('freeSlots: working hours minus busy, weekends skipped, short gaps dropped, nothing before now', () => {
    const busy = [
      { kind: 'appointment' as const, id: 1, start: '2026-11-20T15:00:00Z', end: '2026-11-20T16:00:00Z' }, // 10–11 local
      { kind: 'service_call' as const, id: 2, start: '2026-11-20T16:10:00Z', end: '2026-11-20T18:00:00Z' }, // 11:10–13 local
    ];
    const slots = freeSlots({ busy, days: ['2026-11-20', '2026-11-21'], timeZone: NY, workdayStart: '09:00', workdayEnd: '17:00', minMinutes: 30, now: new Date('2026-11-01T00:00:00Z') });
    expect(slots.map((s) => [s.startLocal, s.endLocal])).toEqual([
      ['2026-11-20T09:00:00', '2026-11-20T10:00:00'],
      ['2026-11-20T13:00:00', '2026-11-20T17:00:00'], // 11:00–11:10 is too short; Saturday 21st skipped
    ]);
    const later = freeSlots({ busy: [], days: ['2026-11-20'], timeZone: NY, workdayStart: '09:00', workdayEnd: '17:00', minMinutes: 30, now: new Date('2026-11-20T20:00:00Z') });
    expect(later[0]!.startLocal).toBe('2026-11-20T15:00:00');
  });
});

describe('searchAppointments', () => {
  test('overlap window for a local day + resource filter sent upstream; rows sorted with local times', async () => {
    const { svc, http } = world([
      { id: 2, resourceID: 5, title: 'B', startDateTime: '2026-11-20T18:00:00Z', endDateTime: '2026-11-20T19:00:00Z' },
      { id: 1, resourceID: 5, title: 'A', startDateTime: '2026-11-20T14:00:00Z', endDateTime: '2026-11-20T15:00:00Z' },
    ]);
    const r = await svc.searchAppointments({ resourceIDs: [5], date: '2026-11-20', timeZone: NY, titleContains: 'x ' });
    expect(http.query.mock.calls[0]![1]).toEqual([
      { op: 'lt', field: 'startDateTime', value: '2026-11-21T04:59:59Z' },
      { op: 'gt', field: 'endDateTime', value: '2026-11-20T05:00:00Z' },
      { op: 'eq', field: 'resourceID', value: 5 },
      { op: 'contains', field: 'title', value: 'x' },
    ]);
    expect(r.items.map((a: any) => a.id)).toEqual([1, 2]);
    expect(r.items[0].startLocal).toBe('2026-11-20T09:00:00');
  });
  test('several resources → in; bare-day from/to cover whole local days; > 62 days refused', async () => {
    const { svc, http } = world();
    await svc.searchAppointments({ resourceIDs: [5, 6], from: '2026-11-20', to: '2026-11-22', timeZone: NY });
    expect(http.query.mock.calls[0]![1]).toEqual([
      { op: 'lt', field: 'startDateTime', value: '2026-11-23T04:59:59Z' },
      { op: 'gt', field: 'endDateTime', value: '2026-11-20T05:00:00Z' },
      { op: 'in', field: 'resourceID', value: [5, 6] },
    ]);
    await expect(svc.searchAppointments({ from: '2026-01-01', to: '2026-06-01', timeZone: NY })).rejects.toThrow(/62 days/);
  });
});

describe('createAppointment', () => {
  test('books in UTC from local time; checks overlaps first', async () => {
    const { svc, http } = world();
    const r = await svc.createAppointment({ resourceID: 5, title: 'Onsite visit', startDateTime: '2026-11-20T14:00', durationMinutes: 90, timeZone: NY, checkServiceCalls: false });
    expect(r.status).toBe('created');
    expect(http.create).toHaveBeenCalledWith('Appointments', { resourceID: 5, title: 'Onsite visit', startDateTime: '2026-11-20T19:00:00Z', endDateTime: '2026-11-20T20:30:00Z' });
    expect(r.appointment).toMatchObject({ id: r.appointmentID, startLocal: '2026-11-20T14:00:00', endLocal: '2026-11-20T15:30:00' });
  });
  test('an overlap writes nothing unless allowOverlap', async () => {
    const { svc, http } = world([{ id: 1, resourceID: 5, title: 'Busy', startDateTime: '2026-11-20T19:30:00Z', endDateTime: '2026-11-20T20:00:00Z' }]);
    const r = await svc.createAppointment({ resourceID: 5, title: 'New', startDateTime: '2026-11-20T14:00', durationMinutes: 60, timeZone: NY, checkServiceCalls: false });
    expect(r.status).toBe('conflict');
    expect(r.conflicts).toEqual([expect.objectContaining({ kind: 'appointment', id: 1, startLocal: '2026-11-20T14:30:00' })]);
    expect(http.create).not.toHaveBeenCalled();
    const ok = await svc.createAppointment({ resourceID: 5, title: 'New', startDateTime: '2026-11-20T14:00', durationMinutes: 60, timeZone: NY, allowOverlap: true, checkServiceCalls: false });
    expect(ok.status).toBe('created');
  });
  test('rerun-safe: same resource + title + start + end returns the existing one', async () => {
    const { svc, http } = world([{ id: 7, resourceID: 5, title: 'Onsite visit', startDateTime: '2026-11-20T19:00:00Z', endDateTime: '2026-11-20T20:30:00Z' }]);
    const r = await svc.createAppointment({ resourceID: 5, title: 'Onsite visit', startDateTime: '2026-11-20T14:00', endDateTime: '2026-11-20T15:30', timeZone: NY, checkServiceCalls: false });
    expect(r).toMatchObject({ status: 'exists', appointmentID: 7 });
    expect(http.create).not.toHaveBeenCalled();
  });
  test('service calls the resource is on count as busy; canceled ones do not', async () => {
    const query = jest.fn(async (entity: string) => {
      if (entity === 'ServiceCalls') return [
        { id: 30, startDateTime: '2026-11-20T19:00:00Z', endDateTime: '2026-11-20T21:00:00Z' },
        { id: 31, startDateTime: '2026-11-20T19:00:00Z', endDateTime: '2026-11-20T21:00:00Z', canceledDateTime: '2026-11-19T00:00:00Z' },
      ];
      if (entity === 'ServiceCallTickets') return [{ id: 300, serviceCallID: 30, ticketID: 77 }, { id: 301, serviceCallID: 31, ticketID: 78 }];
      if (entity === 'ServiceCallTicketResources') return [{ serviceCallTicketID: 300 }, { serviceCallTicketID: 301 }];
      return [];
    });
    const { svc, http } = world([], { query });
    const r = await svc.createAppointment({ resourceID: 5, title: 'X', startDateTime: '2026-11-20T15:00', durationMinutes: 60, timeZone: NY });
    expect(r.status).toBe('conflict');
    expect(r.conflicts.map((c: any) => [c.kind, c.id])).toEqual([['service_call', 30]]);
    expect(http.create).not.toHaveBeenCalled();
  });
  test('invalid input and dryRun write nothing', async () => {
    const { svc, http } = world();
    expect((await svc.createAppointment({ resourceID: 5, title: ' ', startDateTime: '2026-11-20T14:00', durationMinutes: 30, timeZone: NY })).status).toBe('invalid');
    expect((await svc.createAppointment({ resourceID: 5, title: 'T', startDateTime: '2026-11-20T14:00', timeZone: NY })).status).toBe('invalid');
    expect((await svc.createAppointment({ resourceID: 5, title: 'T', startDateTime: '2026-11-20T14:00', durationMinutes: 30, timeZone: NY, dryRun: true, checkServiceCalls: false })).status).toBe('planned');
    expect(http.create).not.toHaveBeenCalled();
  });
});

describe('updateAppointment / deleteAppointment', () => {
  const base = { id: 1, resourceID: 5, title: 'Visit', description: 'd', startDateTime: '2026-11-20T19:00:00Z', endDateTime: '2026-11-20T20:00:00Z' };
  test('moving the start keeps the length; PATCH carries only what changed', async () => {
    const { svc, http } = world([base]);
    const r = await svc.updateAppointment(1, { startDateTime: '2026-11-20T16:00', timeZone: NY, checkServiceCalls: false });
    expect(r.status).toBe('updated');
    expect(http.update).toHaveBeenCalledWith('Appointments', 1, { startDateTime: '2026-11-20T21:00:00Z', endDateTime: '2026-11-20T22:00:00Z' });
    expect(r.after).toMatchObject({ startLocal: '2026-11-20T16:00:00', endLocal: '2026-11-20T17:00:00' });
  });
  test('the appointment itself is not a conflict; another one is', async () => {
    const other = { id: 2, resourceID: 5, title: 'Other', startDateTime: '2026-11-20T21:30:00Z', endDateTime: '2026-11-20T22:30:00Z' };
    const { svc, http } = world([base, other]);
    expect((await svc.updateAppointment(1, { durationMinutes: 90, timeZone: NY, checkServiceCalls: false })).status).toBe('updated');
    const r = await svc.updateAppointment(1, { startDateTime: '2026-11-20T16:00', timeZone: NY, checkServiceCalls: false });
    expect(r.status).toBe('conflict');
    expect(http.update).toHaveBeenCalledTimes(1);
  });
  test('same values → unchanged, no write; missing → not_found', async () => {
    const { svc, http } = world([base]);
    expect((await svc.updateAppointment(1, { title: 'Visit', timeZone: NY })).status).toBe('unchanged');
    expect((await svc.updateAppointment(99, { title: 'x' })).status).toBe('not_found');
    expect(http.update).not.toHaveBeenCalled();
  });
  test('delete reads first and returns what was removed', async () => {
    const { svc, http } = world([base]);
    const r = await svc.deleteAppointment(1, NY);
    expect(r).toMatchObject({ status: 'deleted', deleted: { title: 'Visit', startLocal: '2026-11-20T14:00:00' } });
    expect(http.delete).toHaveBeenCalledWith('Appointments', 1);
    expect((await svc.deleteAppointment(1, NY)).status).toBe('not_found');
    expect(http.delete).toHaveBeenCalledTimes(1);
  });
});

describe('getResourceAvailability', () => {
  test('per-resource free slots and the slots when all are free', async () => {
    const { svc } = world([
      { id: 1, resourceID: 5, title: 'A', startDateTime: '2026-11-20T14:00:00Z', endDateTime: '2026-11-20T16:00:00Z' }, // 9–11
      { id: 2, resourceID: 6, title: 'B', startDateTime: '2026-11-20T18:00:00Z', endDateTime: '2026-11-20T19:00:00Z' }, // 13–14
    ]);
    const r = await svc.getResourceAvailability({ resourceIDs: [5, 6], date: '2026-11-20', days: 1, timeZone: NY, workdayStart: '09:00', workdayEnd: '17:00', includeServiceCalls: false, now: new Date('2026-11-01T00:00:00Z') });
    expect(r.resources.map((x: any) => [x.resourceName, x.free.length, x.busy.length])).toEqual([['Tech Five', 1, 1], ['Tech Six', 2, 1]]);
    expect(r.allFree.map((s: any) => [s.startLocal, s.endLocal])).toEqual([
      ['2026-11-20T11:00:00', '2026-11-20T13:00:00'],
      ['2026-11-20T14:00:00', '2026-11-20T17:00:00'],
    ]);
  });
  test('needs 1–10 resources', async () => {
    const { svc } = world();
    await expect(svc.getResourceAvailability({ resourceIDs: [] })).rejects.toThrow(/resourceIDs/);
    await expect(svc.getResourceAvailability({ resourceIDs: Array.from({ length: 11 }, (_, i) => i + 1) })).rejects.toThrow(/10/);
  });
});

describe('catalog', () => {
  const names = ['autotask_get_appointment', 'autotask_search_appointments', 'autotask_create_appointment', 'autotask_update_appointment', 'autotask_delete_appointment', 'autotask_get_resource_availability'];
  test('six tools, in the appointments category; delete is destructive; create acts as the caller', () => {
    for (const n of names) expect(TOOL_DEFINITIONS.find((t) => t.name === n)).toBeDefined();
    expect(TOOL_CATEGORIES.appointments!.tools).toEqual(names);
    expect(TOOL_DEFINITIONS.find((t) => t.name === 'autotask_delete_appointment')!.annotations).toMatchObject({ destructiveHint: true });
    expect(ACTING_RESOURCE_TOOLS.autotask_create_appointment).toBe('resourceID');
    expect(CURRENT_USER_DEFAULT_TOOLS.autotask_create_appointment).toBe('resourceID');
  });
});
