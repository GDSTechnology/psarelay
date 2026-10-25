// Create-side timezone correctness: resolve the resource's location timezone
// (Windows name from Autotask -> IANA), convert local start/end to the right UTC
// instant, apply billingTreatment, and read the stored entry back.

import { windowsToIana } from '../src/utils/windows-timezones';
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

beforeEach(() => _resetZoneUrlCache());
afterEach(() => jest.restoreAllMocks());

describe('windowsToIana', () => {
  test('maps the Autotask Windows names GDS uses', () => {
    expect(windowsToIana('Eastern Standard Time')).toBe('America/New_York');
    expect(windowsToIana('Central Standard Time')).toBe('America/Chicago');
    expect(windowsToIana('US Mountain Standard Time')).toBe('America/Phoenix');
  });
  test('passes through IANA and handles UTC / unknown', () => {
    expect(windowsToIana('America/New_York')).toBe('America/New_York');
    expect(windowsToIana('UTC')).toBe('Etc/UTC');
    expect(windowsToIana('Nonsense Zone')).toBeNull();
    expect(windowsToIana(undefined)).toBeNull();
  });
});

describe('resolveResourceTimeZone', () => {
  test('Resource.locationID -> InternalLocation.timeZone(Windows) -> IANA, cached', async () => {
    const svc = new AutotaskService(config, logger);
    const fetchMock = jest.spyOn(global, 'fetch' as any).mockImplementation((...args: any[]) => {
      const url = args[0] as string;
      if (/\/Resources\/30683829$/.test(url)) return Promise.resolve(res(200, { item: { id: 30683829, locationID: 29683388 } }));
      if (/\/InternalLocations\/query$/.test(url)) return Promise.resolve(res(200, { items: [{ id: 29683388, timeZone: 'Eastern Standard Time' }] }));
      return Promise.resolve(res(200, { items: [] }));
    });
    const tz1 = await svc.resolveResourceTimeZone(30683829);
    const tz2 = await svc.resolveResourceTimeZone(30683829); // cached
    expect(tz1).toBe('America/New_York');
    expect(tz2).toBe('America/New_York');
    const resourceGets = fetchMock.mock.calls.filter((c: any[]) => /\/Resources\/30683829$/.test(c[0] as string));
    expect(resourceGets).toHaveLength(1); // cache prevents a second lookup
  });
});

describe('createTimeEntry timezone normalization', () => {
  // Capture the body POSTed to /TimeEntries and route the tz lookups.
  function mockCreate(locationTz: string | null) {
    const posted: any[] = [];
    jest.spyOn(global, 'fetch' as any).mockImplementation((...args: any[]) => {
      const url = args[0] as string; const init = (args[1] || {}) as RequestInit;
      if (/\/Resources\/\d+$/.test(url)) return Promise.resolve(res(200, { item: { id: 1, locationID: 55 } }));
      if (/\/InternalLocations\/query$/.test(url)) return Promise.resolve(res(200, { items: locationTz ? [{ id: 55, timeZone: locationTz }] : [] }));
      if (/\/TimeEntries$/.test(url) && init.method === 'POST') { posted.push(JSON.parse(String(init.body))); return Promise.resolve(res(200, { itemId: 999 })); }
      return Promise.resolve(res(200, { items: [] }));
    });
    return posted;
  }

  test('local start/end + resource Eastern tz -> stored as UTC (10:00 EDT -> 14:00Z)', async () => {
    const svc = new AutotaskService(config, logger);
    const posted = mockCreate('Eastern Standard Time');
    await svc.createTimeEntry({ taskID: 208749, resourceID: 1, roleID: 7, dateWorked: '2026-09-23', startDateTime: '2026-09-23T10:00:00', endDateTime: '2026-09-23T10:30:00', summaryNotes: 'x' } as any);
    expect(posted[0].startDateTime).toBe('2026-09-23T14:00:00.000Z');
    expect(posted[0].endDateTime).toBe('2026-09-23T14:30:00.000Z');
    expect(posted[0].timeZone).toBeUndefined(); // never sent as a field
  });

  test('offset-aware input is converted regardless of resource tz', async () => {
    const svc = new AutotaskService(config, logger);
    const posted = mockCreate(null); // no resolvable resource tz
    await svc.createTimeEntry({ taskID: 1, resourceID: 1, roleID: 7, dateWorked: '2026-09-23', startDateTime: '2026-09-23T10:00:00-04:00', endDateTime: '2026-09-23T10:52:00-04:00', summaryNotes: 'y' } as any);
    expect(posted[0].startDateTime).toBe('2026-09-23T14:00:00.000Z');
    expect(posted[0].endDateTime).toBe('2026-09-23T14:52:00.000Z');
  });

  test('no offset and no resolvable tz -> left naive (legacy behavior)', async () => {
    const svc = new AutotaskService(config, logger);
    const posted = mockCreate(null);
    await svc.createTimeEntry({ taskID: 1, resourceID: 1, roleID: 7, dateWorked: '2026-09-23', hoursWorked: 0.5, summaryNotes: 'z' } as any);
    // derived 09:00 span, unchanged (no tz)
    expect(posted[0].startDateTime).toBe('2026-09-23T09:00:00');
    expect(posted[0].endDateTime).toBe('2026-09-23T09:30:00');
  });

  test('explicit timeZone overrides resource lookup', async () => {
    const svc = new AutotaskService(config, logger);
    const posted = mockCreate('Eastern Standard Time');
    await svc.createTimeEntry({ taskID: 1, resourceID: 1, roleID: 7, dateWorked: '2026-01-15', startDateTime: '2026-01-15T09:00:00', endDateTime: '2026-01-15T09:30:00', timeZone: 'America/Chicago', summaryNotes: 'c' } as any);
    // Central standard (Jan) = UTC-6 -> 15:00Z, proving the explicit tz (not Eastern) was used
    expect(posted[0].startDateTime).toBe('2026-01-15T15:00:00.000Z');
  });
});

describe('autotask_create_time_entry tool (billing + readback)', () => {
  test('billingTreatment translated; rich readback returned', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'resolveResourceByName').mockResolvedValue({ id: 1, firstName: 'A', lastName: 'B' });
    jest.spyOn(svc, 'resolveWorkTimeEntryRole').mockResolvedValue({ roleID: 7 } as any);
    const create = jest.spyOn(svc, 'createTimeEntry').mockResolvedValue(999);
    const readback = jest.spyOn(svc, 'getTimeEntry').mockResolvedValue({ id: 999, dateWorked: '2026-09-23', startDateTime: '2026-09-23T14:00:00.000Z', endDateTime: '2026-09-23T14:30:00.000Z', hoursWorked: 0.5, isNonBillable: true, showOnInvoice: false } as any);
    // keep enrichment offline
    jest.spyOn(global, 'fetch' as any).mockImplementation(() => Promise.resolve(res(200, { items: [] })));
    const handler = new AutotaskToolHandler(svc, logger);

    const r = await handler.callTool('autotask_create_time_entry', { taskID: 1, resourceID: 1, dateWorked: '2026-09-23', hoursWorked: 0.5, summaryNotes: 'x', billingTreatment: 'non_billable' });

    // billingTreatment translated to the field combo, not sent as a raw field
    const sent = create.mock.calls[0][0] as any;
    expect(sent.isNonBillable).toBe(true);
    expect(sent.showOnInvoice).toBe(false);
    expect(sent.billingTreatment).toBeUndefined();
    // rich readback happened
    expect(readback).toHaveBeenCalledWith(999);
    expect(r.content[0].text).toContain('999');
  });
});
