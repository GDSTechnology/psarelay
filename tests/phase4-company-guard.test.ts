// Protected-company and unsafe-name hard gates (brief §7.31).

import {
  getProtectedCompanyIds,
  isProtectedCompanyId,
  checkProtectedCompanyMutation,
  isUnsafeCompanyName,
} from '../src/utils/company-guard';
import { AutotaskService } from '../src/services/autotask.service';
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

function mockAny(status: number, body?: any): jest.SpyInstance {
  return jest.spyOn(global, 'fetch' as any).mockResolvedValue(res(status, body));
}

beforeEach(() => _resetZoneUrlCache());
afterEach(() => jest.restoreAllMocks());

describe('protected company ids', () => {
  test('company 0 is always protected; env extends the set', () => {
    expect(getProtectedCompanyIds({} as NodeJS.ProcessEnv)).toEqual(new Set([0]));
    expect(getProtectedCompanyIds({ AUTOTASK_PROTECTED_COMPANY_IDS: '5, 9 ,x' } as any)).toEqual(
      new Set([0, 5, 9])
    );
    expect(isProtectedCompanyId(0, {} as any)).toBe(true);
    expect(isProtectedCompanyId(123, {} as any)).toBe(false);
  });
});

describe('checkProtectedCompanyMutation', () => {
  const env = {} as NodeJS.ProcessEnv; // only company 0 protected

  test('blocks rename of a protected company', () => {
    const r = checkProtectedCompanyMutation(0, { companyName: 'Junk Co' }, env);
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/companyName/);
  });

  test('blocks reclassify and deactivate', () => {
    expect(checkProtectedCompanyMutation(0, { classification: 7 }, env).blocked).toBe(true);
    expect(checkProtectedCompanyMutation(0, { isActive: false }, env).blocked).toBe(true);
    expect(checkProtectedCompanyMutation(0, { isActive: 0 }, env).blocked).toBe(true);
  });

  test('allows a benign update to a protected company', () => {
    expect(checkProtectedCompanyMutation(0, { phone: '555-1212' }, env).blocked).toBe(false);
  });

  test('never blocks a normal company', () => {
    expect(checkProtectedCompanyMutation(123, { companyName: 'Acme', isActive: false }, env).blocked).toBe(false);
  });
});

describe('isUnsafeCompanyName', () => {
  test.each([
    'Acme Technology',
    'Mail Boxes Etc',       // contains "mail" but not a bare provider
    'Zoho-Powered LLC',
    'GDS Technology, Inc.',
  ])('accepts real name: %s', (name) => {
    expect(isUnsafeCompanyName(name).safe).toBe(true);
  });

  test.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['gmail.com', 'webmail'],
    ['Yahoo', 'webmail'],
    ['Hi there, do you have pricing?', 'greeting'],
    ['Click here to unsubscribe', 'CTA'],
    ['We are a small and medium business owner looking for services.', 'sentence'],
  ])('rejects %s', (name) => {
    expect(isUnsafeCompanyName(name).safe).toBe(false);
  });

  test('rejects non-string and over-long input', () => {
    expect(isUnsafeCompanyName(undefined).safe).toBe(false);
    expect(isUnsafeCompanyName(123 as unknown).safe).toBe(false);
    expect(isUnsafeCompanyName('x'.repeat(101)).safe).toBe(false);
  });
});

describe('AutotaskService company gates (wiring)', () => {
  test('createCompany rejects an unsafe name without calling the API', async () => {
    const fetchMock = mockAny(200, { itemId: 1 });
    const service = new AutotaskService(config, logger);
    await expect(service.createCompany({ companyName: 'Click here to buy now' })).rejects.toThrow(
      /manual review/i
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('createCompany proceeds for a real name', async () => {
    const fetchMock = mockAny(200, { itemId: 42 });
    const service = new AutotaskService(config, logger);
    const id = await service.createCompany({ companyName: 'Acme Technology', ownerResourceID: 30683829 });
    expect(id).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('updateCompany refuses to rename company 0 without calling the API', async () => {
    const fetchMock = mockAny(200, { itemId: 0 });
    const service = new AutotaskService(config, logger);
    await expect(service.updateCompany(0, { companyName: 'Junk Source Co' })).rejects.toThrow(
      /protected internal account/i
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('updateCompany allows a benign change to company 0', async () => {
    const fetchMock = mockAny(200, { itemId: 0 });
    const service = new AutotaskService(config, logger);
    await expect(service.updateCompany(0, { phone: '555-1212' })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('raw_request writes to Companies pass the same name gate', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { rawCompanyWriteProblem } = require('../src/utils/company-guard');
  test('a create named after a webmail provider is refused; a real name, a query or another entity is not', () => {
    expect(rawCompanyWriteProblem('POST', '/Companies', { companyName: 'Gmail', companyType: 1 })).toMatch(/webmail provider/);
    expect(rawCompanyWriteProblem('post', 'Companies/', { companyName: 'gmail.com' })).toMatch(/webmail provider/);
    expect(rawCompanyWriteProblem('POST', '/Companies', {})).toMatch(/missing/);
    expect(rawCompanyWriteProblem('POST', '/Companies', { companyName: 'Contoso Office Centers' })).toBeNull();
    expect(rawCompanyWriteProblem('POST', '/Companies/query', { filter: [] })).toBeNull();
    expect(rawCompanyWriteProblem('POST', '/Companies/123/Contacts', { firstName: 'Unknown' })).toBeNull();
    expect(rawCompanyWriteProblem('GET', '/Companies', null)).toBeNull();
  });
  test('a PATCH / PUT that renames to a junk name is refused; one that leaves the name alone is not', () => {
    expect(rawCompanyWriteProblem('PATCH', '/Companies', { id: 5, companyName: 'Hello there' })).toMatch(/rename/);
    expect(rawCompanyWriteProblem('PUT', '/Companies/5', { companyName: 'Yahoo' })).toMatch(/webmail/);
    expect(rawCompanyWriteProblem('PATCH', '/Companies', { id: 5, isActive: false })).toBeNull();
  });
});
