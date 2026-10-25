// Project/task attachment listing (Phase 4 §5.7 read, #45). Mocked http.
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';
const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
function withHttp(fake: any) { const s = new AutotaskService(config, logger); jest.spyOn(s as any, 'ensureClient').mockResolvedValue(fake); return s; }
afterEach(() => jest.restoreAllMocks());
describe('project/task attachments (read)', () => {
  test('project attachments query Projects/Attachments child route', async () => {
    const childQuery = jest.fn().mockResolvedValue([{ id: 1 }]);
    const s = withHttp({ childQuery });
    await s.searchProjectAttachments(152);
    expect(childQuery).toHaveBeenCalledWith('Projects', 152, 'Attachments', expect.anything(), expect.anything());
  });
  test('task attachments query Tasks/Attachments child route', async () => {
    const childQuery = jest.fn().mockResolvedValue([]);
    const s = withHttp({ childQuery });
    await s.searchTaskAttachments(9);
    expect(childQuery).toHaveBeenCalledWith('Tasks', 9, 'Attachments', expect.anything(), expect.anything());
  });
});

describe('project/task attachments (binary get)', () => {
  const smallB64 = Buffer.from('hello').toString('base64');

  test('project includeData=false uses child endpoint (metadata only)', async () => {
    const childGet = jest.fn().mockResolvedValue({ id: 5, projectID: 152, fileName: 'a.pdf' });
    const get = jest.fn();
    const s = withHttp({ childGet, get });
    const r = await s.getProjectAttachment(152, 5);
    expect(r).toEqual({ id: 5, projectID: 152, fileName: 'a.pdf' });
    expect(childGet).toHaveBeenCalledWith('Projects', 152, 'Attachments', 5);
    expect(get).not.toHaveBeenCalled();
  });

  test('project includeData=true uses top-level ProjectAttachments and returns data', async () => {
    const get = jest.fn().mockResolvedValue({ id: 5, projectID: 152, data: smallB64 });
    const s = withHttp({ childGet: jest.fn(), get });
    const r = await s.getProjectAttachment(152, 5, { includeData: true });
    expect(r?.data).toBe(smallB64);
    expect(get).toHaveBeenCalledWith('ProjectAttachments', 5);
  });

  test('project includeData=true returns null when attachment belongs to another project', async () => {
    const get = jest.fn().mockResolvedValue({ id: 5, projectID: 999, data: smallB64 });
    const s = withHttp({ get });
    const r = await s.getProjectAttachment(152, 5, { includeData: true });
    expect(r).toBeNull();
  });

  test('project includeData=true strips oversized data with dataOmittedReason', async () => {
    const big = 'A'.repeat(1_000_000);
    const get = jest.fn().mockResolvedValue({ id: 5, projectID: 152, fileName: 'big.bin', data: big });
    const s = withHttp({ get });
    const r = await s.getProjectAttachment(152, 5, { includeData: true });
    expect(r?.data).toBeUndefined();
    expect(r?.dataOmittedReason).toMatch(/exceeds inline limit/);
    expect(r?.fileName).toBe('big.bin');
  });

  test('task includeData=true uses top-level TaskAttachments and scope-verifies via parentID', async () => {
    const get = jest.fn().mockResolvedValue({ id: 7, parentID: 9, data: smallB64 });
    const s = withHttp({ get });
    const r = await s.getTaskAttachment(9, 7, { includeData: true });
    expect(r?.data).toBe(smallB64);
    expect(get).toHaveBeenCalledWith('TaskAttachments', 7);
  });
});

describe('project/task attachments (create)', () => {
  const validB64 = Buffer.from('hello world').toString('base64');

  test('createProjectAttachment posts to Projects/Attachments child route and returns id', async () => {
    const childCreate = jest.fn().mockResolvedValue(321);
    const s = withHttp({ childCreate });
    const id = await s.createProjectAttachment(152, { title: 'SOW.pdf', fullPath: 'SOW.pdf', data: validB64 });
    expect(id).toBe(321);
    const [parent, pid, child, payload] = childCreate.mock.calls[0];
    expect([parent, pid, child]).toEqual(['Projects', 152, 'Attachments']);
    expect(payload).toMatchObject({ title: 'SOW.pdf', data: validB64, attachmentType: 'FILE_ATTACHMENT', publish: 1 });
    // Parent linkage comes from the URL; no parentId/parentType is sent.
    expect(payload.parentId).toBeUndefined();
    expect(payload.parentType).toBeUndefined();
  });

  test('createTaskAttachment posts to Tasks/Attachments child route', async () => {
    const childCreate = jest.fn().mockResolvedValue(654);
    const s = withHttp({ childCreate });
    const id = await s.createTaskAttachment(9, { title: 'as-built.pdf', fullPath: 'as-built.pdf', data: validB64 });
    expect(id).toBe(654);
    expect(childCreate).toHaveBeenCalledWith('Tasks', 9, 'Attachments', expect.objectContaining({ title: 'as-built.pdf' }));
  });

  test('rejects invalid base64 before any HTTP call', async () => {
    const childCreate = jest.fn();
    const s = withHttp({ childCreate });
    const ensureSpy = jest.spyOn(s as any, 'ensureClient');
    await expect(
      s.createProjectAttachment(152, { title: 'bad.bin', fullPath: 'bad.bin', data: 'not*valid*base64!!!' })
    ).rejects.toThrow(/not valid base64/);
    expect(ensureSpy).not.toHaveBeenCalled();
    expect(childCreate).not.toHaveBeenCalled();
  });

  test('rejects oversized attachments before any HTTP call', async () => {
    const childCreate = jest.fn();
    const s = withHttp({ childCreate });
    const big = Buffer.alloc(4 * 1024 * 1024).toString('base64');
    await expect(
      s.createTaskAttachment(9, { title: 'huge.bin', fullPath: 'huge.bin', data: big })
    ).rejects.toThrow(/exceeds the Autotask 3MB/);
    expect(childCreate).not.toHaveBeenCalled();
  });
});
