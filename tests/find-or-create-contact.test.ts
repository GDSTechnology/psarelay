// find-or-create contact — idempotent contact resolution (n8n contact-race fix).

import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = {
  name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' },
};

afterEach(() => jest.restoreAllMocks());

describe('findOrCreateContact', () => {
  test('existing email → returns match, does not create', async () => {
    const service = new AutotaskService(config, logger);
    const fakeHttp = { query: jest.fn().mockResolvedValue([{ id: 42 }]) };
    jest.spyOn(service as any, 'ensureClient').mockResolvedValue(fakeHttp);
    const createSpy = jest.spyOn(service, 'createContact').mockResolvedValue(999);

    const r = await service.findOrCreateContact(1, { emailAddress: 'x@y.com' });
    expect(r).toEqual({ id: 42, created: false, matchedBy: 'email', reactivated: false });
    expect(createSpy).not.toHaveBeenCalled();
    expect(fakeHttp.query).toHaveBeenCalledTimes(1);
  });

  test('an INACTIVE email match is reactivated, not duplicated', async () => {
    const service = new AutotaskService(config, logger);
    jest.spyOn(service as any, 'ensureClient').mockResolvedValue({ query: jest.fn().mockResolvedValue([{ id: 42, isActive: false }]) });
    const updateSpy = jest.spyOn(service, 'updateContact').mockResolvedValue(undefined);
    const createSpy = jest.spyOn(service, 'createContact').mockResolvedValue(999);

    const r = await service.findOrCreateContact(1, { emailAddress: 'x@y.com' });
    expect(r).toEqual({ id: 42, created: false, matchedBy: 'email', reactivated: true });
    expect(updateSpy).toHaveBeenCalledWith(42, expect.objectContaining({ isActive: 1, companyID: 1 }));
    expect(createSpy).not.toHaveBeenCalled();
  });

  test('reactivate:false leaves an inactive match alone', async () => {
    const service = new AutotaskService(config, logger);
    jest.spyOn(service as any, 'ensureClient').mockResolvedValue({ query: jest.fn().mockResolvedValue([{ id: 42, isActive: 0 }]) });
    const updateSpy = jest.spyOn(service, 'updateContact').mockResolvedValue(undefined);

    const r = await service.findOrCreateContact(1, { emailAddress: 'x@y.com', reactivate: false });
    expect(r).toMatchObject({ id: 42, created: false, reactivated: false });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  test('two active matches → ambiguous, nothing created', async () => {
    const service = new AutotaskService(config, logger);
    jest.spyOn(service as any, 'ensureClient').mockResolvedValue({ query: jest.fn().mockResolvedValue([{ id: 1, isActive: true }, { id: 2, isActive: true }, { id: 3, isActive: false }]) });
    const createSpy = jest.spyOn(service, 'createContact').mockResolvedValue(999);

    const r = await service.findOrCreateContact(1, { emailAddress: 'x@y.com' });
    expect(r).toEqual({ id: null, created: false, status: 'ambiguous', matchedBy: 'email', candidates: [1, 2] });
    expect(createSpy).not.toHaveBeenCalled();
  });

  test('no match → creates with companyID', async () => {
    const service = new AutotaskService(config, logger);
    jest.spyOn(service as any, 'ensureClient').mockResolvedValue({ query: jest.fn().mockResolvedValue([]) });
    const createSpy = jest.spyOn(service, 'createContact').mockResolvedValue(999);

    const r = await service.findOrCreateContact(7, { emailAddress: 'new@y.com', firstName: 'A', lastName: 'B' });
    expect(r).toEqual({ id: 999, created: true });
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ companyID: 7, emailAddress: 'new@y.com' }));
  });

  test('no email → matches by exact first + last name (case/space-insensitive)', async () => {
    const service = new AutotaskService(config, logger);
    const fakeHttp = { query: jest.fn().mockResolvedValue([{ id: 8, isActive: true, firstName: 'Ann', lastName: 'Lee' }, { id: 9, isActive: true, firstName: 'Annie', lastName: 'Lee' }]) };
    jest.spyOn(service as any, 'ensureClient').mockResolvedValue(fakeHttp);
    const createSpy = jest.spyOn(service, 'createContact').mockResolvedValue(555);

    const r = await service.findOrCreateContact(3, { firstName: ' ann ', lastName: 'LEE' });
    expect(r).toMatchObject({ id: 8, created: false, matchedBy: 'name' });
    expect(fakeHttp.query.mock.calls[0][1]).toEqual([{ op: 'eq', field: 'companyID', value: 3 }, { op: 'eq', field: 'lastName', value: 'LEE' }]);
    expect(createSpy).not.toHaveBeenCalled();
  });

  test('no email, no name match → creates', async () => {
    const service = new AutotaskService(config, logger);
    jest.spyOn(service as any, 'ensureClient').mockResolvedValue({ query: jest.fn().mockResolvedValue([]) });
    jest.spyOn(service, 'createContact').mockResolvedValue(555);

    const r = await service.findOrCreateContact(3, { firstName: 'A', lastName: 'B' });
    expect(r).toEqual({ id: 555, created: true });
  });

  test('no email and no full name → creates without a lookup', async () => {
    const service = new AutotaskService(config, logger);
    const fakeHttp = { query: jest.fn() };
    jest.spyOn(service as any, 'ensureClient').mockResolvedValue(fakeHttp);
    jest.spyOn(service, 'createContact').mockResolvedValue(556);

    const r = await service.findOrCreateContact(3, { firstName: 'A' });
    expect(r).toEqual({ id: 556, created: true });
    expect(fakeHttp.query).not.toHaveBeenCalled();
  });

  test('missing companyID throws', async () => {
    const service = new AutotaskService(config, logger);
    await expect(service.findOrCreateContact(undefined as any, { emailAddress: 'x@y.com' })).rejects.toThrow(/companyID/);
  });
});
