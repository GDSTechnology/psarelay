// Time-entry hardening from the live closeout test:
//  - timezone-aware timestamps (offset ISO passthrough; local + IANA -> UTC, DST-correct)
//  - billingTreatment abstraction (non-billable needs isNonBillable + showOnInvoice=false)
//  - expanded update_time_entry passes the new billing/time fields through
//  - duration-vs-hoursWorked mismatch warns

import { hasOffset, zonedLocalToUTC, normalizeTimestamp, durationHours } from '../src/utils/timezone';
import { billingTreatmentFields, applyBillingTreatment } from '../src/utils/billing-treatment';
import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = {
  name: 'test-server', version: '0.0.0',
  autotask: { username: 'user@example.com', secret: 'secret', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' },
};

// Keep handler-dispatch tests OFFLINE: the MappingService enrichment would
// otherwise fire real /Resources and /Companies queries. Stub every request to
// an empty 200 so nothing touches the network.
function res(status: number, body?: any): Response {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => (body !== undefined ? JSON.stringify(body) : '') } as unknown as Response;
}
beforeEach(() => {
  jest.spyOn(global, 'fetch' as any).mockImplementation(() => Promise.resolve(res(200, { items: [] })));
});
afterEach(() => jest.restoreAllMocks());

describe('timezone util', () => {
  test('hasOffset detects Z and ±HH:MM', () => {
    expect(hasOffset('2026-09-23T14:00:00.000Z')).toBe(true);
    expect(hasOffset('2026-09-23T10:00:00-04:00')).toBe(true);
    expect(hasOffset('2026-09-23T10:00:00')).toBe(false);
  });

  test('EDT local 10:00 -> 14:00Z (daylight time, UTC-4)', () => {
    expect(zonedLocalToUTC('2026-09-23T10:00:00', 'America/New_York').toISOString()).toBe('2026-09-23T14:00:00.000Z');
  });

  test('EST local 10:00 -> 15:00Z (standard time, UTC-5)', () => {
    // January = standard time; proves DST is handled, not a fixed offset.
    expect(zonedLocalToUTC('2026-01-15T10:00:00', 'America/New_York').toISOString()).toBe('2026-01-15T15:00:00.000Z');
  });

  test('normalizeTimestamp: offset ISO -> exact UTC; local+tz -> converted; local alone -> unchanged', () => {
    expect(normalizeTimestamp('2026-09-23T10:00:00-04:00')).toBe('2026-09-23T14:00:00.000Z');
    expect(normalizeTimestamp('2026-09-23T10:00:00', 'America/New_York')).toBe('2026-09-23T14:00:00.000Z');
    expect(normalizeTimestamp('2026-09-23T10:00:00')).toBe('2026-09-23T10:00:00');
  });

  test('durationHours', () => {
    expect(durationHours('2026-09-23T14:00:00Z', '2026-09-23T14:30:00Z')).toBeCloseTo(0.5, 5);
    expect(durationHours('2026-09-23T14:00:00Z', '2026-09-23T14:52:00Z')).toBeCloseTo(0.8667, 3);
  });
});

describe('billingTreatment', () => {
  test('non_billable needs isNonBillable + showOnInvoice=false', () => {
    expect(billingTreatmentFields('non_billable')).toEqual({ isNonBillable: true, showOnInvoice: false });
  });
  test('billable clears isNonBillable', () => {
    expect(billingTreatmentFields('billable')).toEqual({ isNonBillable: false });
  });
  test('explicit fields win over the abstraction', () => {
    const out = applyBillingTreatment({ isNonBillable: false }, 'non_billable');
    expect(out.isNonBillable).toBe(false); // caller's explicit value preserved
    expect(out.showOnInvoice).toBe(false); // filled from abstraction
  });
});

describe('autotask_update_time_entry (expanded)', () => {
  test('billingTreatment:non_billable is translated; billingTreatment/timeZone are not sent as fields', async () => {
    const svc = new AutotaskService(config, logger);
    const upd = jest.spyOn(svc, 'updateTimeEntry').mockResolvedValue();
    jest.spyOn(svc, 'validateWorkType').mockResolvedValue({ ok: true, name: 'Remote Support' }); // work type is pre-flighted
    const handler = new AutotaskToolHandler(svc, logger);

    await handler.callTool('autotask_update_time_entry', { id: 55371, billingCodeID: 29682860, billingTreatment: 'non_billable' });

    const sent = upd.mock.calls[0][1] as any;
    expect(sent).toMatchObject({ billingCodeID: 29682860, isNonBillable: true, showOnInvoice: false });
    expect(sent.billingTreatment).toBeUndefined();
    expect(sent.timeZone).toBeUndefined();
  });

  test('local start/end + timeZone are normalized to UTC before update', async () => {
    const svc = new AutotaskService(config, logger);
    const upd = jest.spyOn(svc, 'updateTimeEntry').mockResolvedValue();
    const handler = new AutotaskToolHandler(svc, logger);

    await handler.callTool('autotask_update_time_entry', {
      id: 1, startDateTime: '2026-09-23T10:00:00', endDateTime: '2026-09-23T10:30:00', timeZone: 'America/New_York',
    });

    const sent = upd.mock.calls[0][1] as any;
    expect(sent.startDateTime).toBe('2026-09-23T14:00:00.000Z');
    expect(sent.endDateTime).toBe('2026-09-23T14:30:00.000Z');
  });

  test('duration mismatch surfaces a warning (does not block)', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'updateTimeEntry').mockResolvedValue();
    const handler = new AutotaskToolHandler(svc, logger);

    const r = await handler.callTool('autotask_update_time_entry', {
      id: 1, startDateTime: '2026-09-23T14:00:00Z', endDateTime: '2026-09-23T14:30:00Z', hoursWorked: 1.0,
    });
    expect(r.content[0].text).toMatch(/does not match/);
  });
});
