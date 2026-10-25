// #42 native Autotask impersonation + prompt-and-bind identity.
// Resolves the CALLER (best-effort) and tunnels writes via the
// ImpersonationResourceId header (AsyncLocalStorage, per-request). Off unless
// AUTOTASK_IMPERSONATION is enabled; unidentified callers (e.g. n8n) run as the
// integration user. Prompt-and-bind elicits the Autotask username when the app
// didn't identify the user. Mocked http / service.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { AutotaskHttpClient } from '../src/services/autotask-http';
import {
  runWithRequestContext, getImpersonationResourceId, isImpersonationEnabled,
} from '../src/utils/request-context';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' } };
const svcWith = (fake: any) => { const s = new AutotaskService(config, logger); jest.spyOn(s as any, 'ensureClient').mockResolvedValue(fake); return s; };

afterEach(() => { jest.restoreAllMocks(); delete process.env.AUTOTASK_IMPERSONATION; });

describe('request-context (AsyncLocalStorage)', () => {
  test('impersonation id is scoped to the run and absent outside it', async () => {
    expect(getImpersonationResourceId()).toBeUndefined();
    await runWithRequestContext({ impersonationResourceId: 7 }, async () => {
      expect(getImpersonationResourceId()).toBe(7);
      await Promise.resolve();
      expect(getImpersonationResourceId()).toBe(7); // survives awaits
    });
    expect(getImpersonationResourceId()).toBeUndefined();
  });

  test('isImpersonationEnabled reads the env flag', () => {
    delete process.env.AUTOTASK_IMPERSONATION; expect(isImpersonationEnabled()).toBe(false);
    process.env.AUTOTASK_IMPERSONATION = 'on'; expect(isImpersonationEnabled()).toBe(true);
    process.env.AUTOTASK_IMPERSONATION = 'off'; expect(isImpersonationEnabled()).toBe(false);
  });
});

describe('AutotaskHttpClient sends ImpersonationResourceId only when in context', () => {
  const mkClient = () => new AutotaskHttpClient('u@e.com', 's', 'ic', 'https://webservices2.autotask.net/ATServicesRest/', logger);
  const okRes = () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ items: [] }) } as any);

  test('header present inside runWithRequestContext', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch' as any).mockResolvedValue(okRes());
    await runWithRequestContext({ impersonationResourceId: 42 }, () =>
      mkClient().query('Tickets', [{ op: 'gte', field: 'id', value: 0 }], { maxRecords: 1 })
    );
    const headers = (fetchSpy.mock.calls[0][1] as any).headers;
    expect(headers.ImpersonationResourceId).toBe('42');
  });

  test('no header outside a context', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch' as any).mockResolvedValue(okRes());
    await mkClient().query('Tickets', [{ op: 'gte', field: 'id', value: 0 }], { maxRecords: 1 });
    const headers = (fetchSpy.mock.calls[0][1] as any).headers;
    expect(headers.ImpersonationResourceId).toBeUndefined();
  });
});

describe('handler wires impersonation for the resolved caller (#42)', () => {
  test('flag on + mutating tool → caller id reaches the outbound call', async () => {
    process.env.AUTOTASK_IMPERSONATION = 'on';
    const service = svcWith({});
    const handler = new AutotaskToolHandler(service, logger);
    jest.spyOn(handler as any, 'resolveCaller').mockResolvedValue({ status: 'resolved', resource: { id: 5, name: 'Me' } });
    let seen: number | undefined = -1;
    jest.spyOn(service, 'createTicket').mockImplementation(async () => { seen = getImpersonationResourceId(); return 1; });
    await handler.callTool('autotask_create_ticket', { companyID: 1, title: 'T', description: 'D' });
    expect(seen).toBe(5); // impersonated as the caller during the write
  });

  test('flag off → no impersonation', async () => {
    delete process.env.AUTOTASK_IMPERSONATION;
    const service = svcWith({});
    const handler = new AutotaskToolHandler(service, logger);
    jest.spyOn(handler as any, 'resolveCaller').mockResolvedValue({ status: 'resolved', resource: { id: 5, name: 'Me' } });
    let seen: number | undefined = -1;
    jest.spyOn(service, 'createTicket').mockImplementation(async () => { seen = getImpersonationResourceId(); return 1; });
    await handler.callTool('autotask_create_ticket', { companyID: 1, title: 'T', description: 'D' });
    expect(seen).toBeUndefined();
  });

  test('flag on but caller unidentified → runs as integration user (no impersonation, not blocked)', async () => {
    process.env.AUTOTASK_IMPERSONATION = 'on';
    const service = svcWith({});
    const handler = new AutotaskToolHandler(service, logger);
    jest.spyOn(handler as any, 'resolveCaller').mockResolvedValue({ status: 'user_identification_required', message: '?' } as any);
    let seen: number | undefined = -1;
    const create = jest.spyOn(service, 'createTicket').mockImplementation(async () => { seen = getImpersonationResourceId(); return 1; });
    await handler.callTool('autotask_create_ticket', { companyID: 1, title: 'T', description: 'D' });
    expect(create).toHaveBeenCalled();      // write still happened
    expect(seen).toBeUndefined();           // as the integration user
  });

  test('read tool never impersonates even with the flag on', async () => {
    process.env.AUTOTASK_IMPERSONATION = 'on';
    const service = svcWith({});
    const handler = new AutotaskToolHandler(service, logger);
    const resolveSpy = jest.spyOn(handler as any, 'resolveCaller');
    jest.spyOn(service, 'getConfigurationItem').mockImplementation(async () => { expect(getImpersonationResourceId()).toBeUndefined(); return { id: 9 } as any; });
    await handler.callTool('autotask_get_configuration_item', { configurationItemId: 9 });
    expect(resolveSpy).not.toHaveBeenCalled(); // no caller resolution on reads
  });
});

describe('prompt-and-bind identity (#42)', () => {
  test('currentUser with no identity → elicits Autotask username, resolves, and proceeds', async () => {
    const service = svcWith({});
    jest.spyOn(service, 'searchResourcesByEmail').mockResolvedValue([{ id: 9, firstName: 'A', lastName: 'B', email: 'me@x.com' } as any]);
    const log = jest.spyOn(service, 'logTimeIdempotent').mockResolvedValue({ created: true, id: 5 });
    const handler = new AutotaskToolHandler(service, logger);
    handler.setServer({ elicitInput: jest.fn().mockResolvedValue({ action: 'accept', content: { autotaskUsername: 'me@x.com' } }) } as any);
    await handler.callTool('autotask_log_my_time', { ticketID: 10, hoursWorked: 1, summaryNotes: 'work' });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ resourceID: 9 }));
  });

  test('elicitation declined → identification_required is returned (graceful)', async () => {
    const service = svcWith({});
    const log = jest.spyOn(service, 'logTimeIdempotent').mockResolvedValue({ created: true, id: 5 });
    const handler = new AutotaskToolHandler(service, logger);
    handler.setServer({ elicitInput: jest.fn().mockResolvedValue({ action: 'decline' }) } as any);
    const result = await handler.callTool('autotask_log_my_time', { ticketID: 10, hoursWorked: 1, summaryNotes: 'work' });
    expect(log).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text).data).toMatchObject({ status: 'user_identification_required' });
  });
});
