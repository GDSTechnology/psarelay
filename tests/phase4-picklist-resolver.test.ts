// Picklist label→value resolver (Phase 4 §4.4, #45). Mocked getFieldInfo.

import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
const statusField = {
  name: 'status', dataType: 'integer', isRequired: false, isReadOnly: false, isQueryable: true, isReference: false, isPickList: true,
  picklistValues: [
    { value: '1', label: 'New', isActive: true },
    { value: '5', label: 'Complete', isActive: true },
    { value: '8', label: 'Waiting Materials', isActive: true },
    { value: '99', label: 'Old', isActive: false },
  ],
};
function svcWith(fi: any[]) {
  const s = new AutotaskService(config, logger);
  jest.spyOn(s, 'getFieldInfo').mockResolvedValue(fi as any);
  return s;
}
afterEach(() => jest.restoreAllMocks());

describe('resolvePicklistValue', () => {
  test('exact case-insensitive match', async () => {
    const s = svcWith([statusField]);
    expect(await s.resolvePicklistValue('Tasks', 'status', 'complete')).toMatchObject({ status: 'matched', value: '5', label: 'Complete' });
  });
  test('not-found returns suggestions + full value list (active only)', async () => {
    const s = svcWith([statusField]);
    const r = await s.resolvePicklistValue('Tasks', 'status', 'wait');
    expect(r.status).toBe('not-found');
    expect(r.suggestions).toEqual([{ value: '8', label: 'Waiting Materials' }]);
    expect(r.values.map((v: any) => v.label)).not.toContain('Old'); // inactive excluded
  });
  test('field-not-found', async () => {
    const s = svcWith([statusField]);
    expect(await s.resolvePicklistValue('Tasks', 'nope', 'x')).toMatchObject({ status: 'field-not-found' });
  });
  test('not-a-picklist', async () => {
    const s = svcWith([{ name: 'title', picklistValues: [] }]);
    expect(await s.resolvePicklistValue('Tasks', 'title', 'x')).toMatchObject({ status: 'not-a-picklist' });
  });
});
