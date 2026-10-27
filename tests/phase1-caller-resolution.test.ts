// Caller → Autotask resource resolution + identity prompt (Expansion Spec §4.1).

import {
  parseUserMap,
  callerMapKeys,
  classifyEmailMatch,
  identificationRequired,
} from '../src/utils/caller-resolution';
import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';
import type { CallerContext } from '../src/types/context';

const logger = new Logger('error');
const config: McpServerConfig = {
  name: 'test-server', version: '0.0.0',
  autotask: { username: 'user@example.com', secret: 'secret', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' },
};

function ctxOf(over: Partial<CallerContext> = {}): CallerContext {
  return { source: 'chatgpt', correlationId: 'c1', timestamp: '2026-08-26T00:00:00Z', ...over };
}

afterEach(() => jest.restoreAllMocks());

describe('parseUserMap', () => {
  test('parses JSON, lowercases keys, coerces ids, ignores junk', () => {
    const m = parseUserMap('{"Jane@X.com": 123, "telegram:JDoe": "456", "bad": "nope"}');
    expect(m.get('jane@x.com')).toBe(123);
    expect(m.get('telegram:jdoe')).toBe(456);
    expect(m.has('bad')).toBe(false);
  });
  test('empty/malformed → empty map', () => {
    expect(parseUserMap(undefined).size).toBe(0);
    expect(parseUserMap('{not json').size).toBe(0);
  });
});

describe('callerMapKeys', () => {
  test('email + source:objectId', () => {
    expect(callerMapKeys(ctxOf({ requestingUserEmail: 'A@B.com', source: 'telegram', teamsObjectId: 'JDoe' })))
      .toEqual(['a@b.com', 'telegram:jdoe']);
  });
});

describe('classifyEmailMatch', () => {
  test('no email → no-identity', () => {
    expect(classifyEmailMatch(undefined, [])).toMatchObject({ status: 'user_identification_required', reason: 'no-identity' });
  });
  test('one → resolved', () => {
    expect(classifyEmailMatch('j@x.com', [{ id: 7, name: 'Joan', email: 'j@x.com' }]))
      .toMatchObject({ status: 'resolved', via: 'email-match', resource: { id: 7 } });
  });
  test('zero → not-found; many → ambiguous with candidates', () => {
    expect(classifyEmailMatch('j@x.com', [])).toMatchObject({ status: 'user_identification_required', reason: 'not-found' });
    const amb = classifyEmailMatch('j@x.com', [{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);
    expect(amb).toMatchObject({ status: 'user_identification_required', reason: 'ambiguous' });
    expect((amb as any).candidates).toHaveLength(2);
  });
});

describe('identificationRequired messages', () => {
  test('each reason has a human message', () => {
    expect(identificationRequired('no-identity').message).toMatch(/who you are/i);
    expect(identificationRequired('ambiguous', { providedEmail: 'j@x.com' }).message).toMatch(/more than one/i);
    expect(identificationRequired('not-found', { providedEmail: 'j@x.com' }).message).toMatch(/couldn't match/i);
  });
});

describe('AutotaskToolHandler.resolveCaller', () => {
  test('explicit resourceId resolves and caches', async () => {
    const handler = new AutotaskToolHandler(new AutotaskService(config, logger), logger);
    const r = await handler.resolveCaller(ctxOf({ requestingUserEmail: 'a@b.com' }), { resourceId: 99 });
    expect(r).toMatchObject({ status: 'resolved', via: 'explicit-id', resource: { id: 99 } });
  });

  test('live email match resolves, then a second call is served from cache (no re-query)', async () => {
    const service = new AutotaskService(config, logger);
    const spy = jest.spyOn(service, 'searchResourcesByEmail').mockResolvedValue([{ id: 30683829, firstName: 'Jonathan', lastName: 'Fitzgerald', email: 'jf@gds.com' }]);
    const handler = new AutotaskToolHandler(service, logger);
    const ctx = ctxOf({ requestingUserEmail: 'jf@gds.com' });

    const r1 = await handler.resolveCaller(ctx);
    expect(r1).toMatchObject({ status: 'resolved', via: 'email-match', resource: { id: 30683829, name: 'Jonathan Fitzgerald' } });

    const r2 = await handler.resolveCaller(ctx);
    expect(r2).toMatchObject({ status: 'resolved', via: 'cache' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('no email match → identification required', async () => {
    const service = new AutotaskService(config, logger);
    jest.spyOn(service, 'searchResourcesByEmail').mockResolvedValue([]);
    const handler = new AutotaskToolHandler(service, logger);
    const r = await handler.resolveCaller(ctxOf({ requestingUserEmail: 'ghost@x.com' }));
    expect(r).toMatchObject({ status: 'user_identification_required', reason: 'not-found' });
  });

  test('a verified token (person sign-in / Microsoft 365) says who the caller is — no "who are you?", no lookup', async () => {
    const service = new AutotaskService(config, logger);
    const spy = jest.spyOn(service, 'searchResourcesByEmail').mockResolvedValue([]);
    const handler = new AutotaskToolHandler(service, logger);
    const r = await handler.resolveCaller(ctxOf({ source: 'unknown', autotaskResourceId: 4242, autotaskResourceName: 'Jane Doe', identityVerified: true }));
    expect(r).toEqual({ status: 'resolved', via: 'token', resource: { id: 4242, name: 'Jane Doe' } });
    expect(spy).not.toHaveBeenCalled();
    // A declared (unverified) resource id is not trusted this way.
    expect(await handler.resolveCaller(ctxOf({ source: 'unknown', autotaskResourceId: 4242 }))).toMatchObject({ status: 'user_identification_required' });
  });

  test('no identity at all → identification required (no-identity)', async () => {
    const handler = new AutotaskToolHandler(new AutotaskService(config, logger), logger);
    expect(await handler.resolveCaller(ctxOf({ source: 'unknown' }))).toMatchObject({ status: 'user_identification_required', reason: 'no-identity' });
  });

  test('static AUTOTASK_USER_MAP resolves a non-email handle', async () => {
    const prev = process.env.AUTOTASK_USER_MAP;
    process.env.AUTOTASK_USER_MAP = '{"telegram:jdoe": 555}';
    try {
      const handler = new AutotaskToolHandler(new AutotaskService(config, logger), logger);
      const r = await handler.resolveCaller(ctxOf({ source: 'telegram', teamsObjectId: 'jdoe' }));
      expect(r).toMatchObject({ status: 'resolved', via: 'static-map', resource: { id: 555 } });
    } finally {
      if (prev === undefined) delete process.env.AUTOTASK_USER_MAP; else process.env.AUTOTASK_USER_MAP = prev;
    }
  });
});

describe('autotask_whoami tool threads context', () => {
  test('unmapped caller returns the identification prompt', async () => {
    const service = new AutotaskService(config, logger);
    jest.spyOn(service, 'searchResourcesByEmail').mockResolvedValue([]);
    const handler = new AutotaskToolHandler(service, logger);
    const result = await handler.callTool('autotask_whoami', {}, { source: 'hermes-teams', requestingUserEmail: 'ghost@x.com' });
    const data = JSON.parse(result.content[0].text).data;
    expect(data).toMatchObject({ status: 'user_identification_required', reason: 'not-found' });
  });
});
