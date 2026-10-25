// update_ticket: queue moves (by id or name), picklists by label, the
// contract/company side doors closed, and read-back verification. Live case:
// T20261007.0010 sat in "Purchasing", belonged in "Tier 1 Support", and the
// agent couldn't move it — queueID was writable but not in the tool schema.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { TOOL_DEFINITIONS } from '../src/handlers/tool.definitions';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
const pv = (pairs: Array<[number, string]>) => pairs.map(([value, label]) => ({ value: String(value), label, isDefaultValue: false, sortOrder: 0, isActive: true, isSystem: false }));
const FIELDS: any[] = [
  { name: 'queueID', isPickList: true, picklistValues: pv([[29683418, 'Tier 1 Support'], [29683421, 'Purchasing'], [29683416, 'Tier 2 Support']]) },
  { name: 'status', isPickList: true, picklistValues: pv([[1, 'New'], [8, 'In Progress']]) },
];
afterEach(() => jest.restoreAllMocks());

function mk(after: Record<string, unknown> = { id: 210669, ticketNumber: 'T20261007.0010', queueID: 29683418 }) {
  const s = new AutotaskService(config, logger);
  jest.spyOn(s, 'getFieldInfo').mockResolvedValue(FIELDS);
  const update = jest.spyOn(s, 'updateTicket').mockResolvedValue(undefined);
  jest.spyOn(s, 'getTicket').mockResolvedValue(after as any);
  const call = async (args: Record<string, unknown>) => JSON.parse((await new AutotaskToolHandler(s, logger).callTool('autotask_update_ticket', { ticketId: 210669, ...args })).content[0].text);
  return { call, update };
}

describe('update_ticket', () => {
  test('schema advertises queueID / queue and the other writable fields', () => {
    const props = Object.keys(TOOL_DEFINITIONS.find((t) => t.name === 'autotask_update_ticket')!.inputSchema.properties);
    for (const f of ['queueID', 'queue', 'source', 'ticketType', 'ticketCategory', 'serviceLevelAgreementID', 'estimatedHours', 'billingCodeID', 'resolution', 'purchaseOrderNumber', 'opportunityID', 'problemTicketId', 'externalID']) expect(props).toContain(f);
  });

  test('move queue by NAME → the queue id is written; read-back reports it', async () => {
    const { call, update } = mk();
    const r = await call({ queue: 'Tier 1 Support' });
    expect(update).toHaveBeenCalledWith(210669, { queueID: 29683418 });
    expect(r.data.changes).toEqual([{ field: 'queueID', to: 'Tier 1 Support', applied: true }]);
    expect(r.message).toMatch(/^Updated T20261007\.0010: queueID → Tier 1 Support\.$/);
  });

  test('queueID by id, and a label string in queueID, both work', async () => {
    const a = mk(); await a.call({ queueID: 29683418 });
    expect(a.update).toHaveBeenCalledWith(210669, { queueID: 29683418 });
    const b = mk(); await b.call({ queueID: 'tier 1' });
    expect(b.update).toHaveBeenCalledWith(210669, { queueID: 29683418 });
  });

  test('unknown queue → choices, nothing written', async () => {
    const { call, update } = mk();
    const r = await call({ queue: 'Tier 9' });
    expect(update).not.toHaveBeenCalled();
    expect(r.message).toMatch(/Nothing written: queueID "Tier 9" is not an active choice\. Choices: 29683418 = Tier 1 Support/);
  });

  test('contract / company changes are refused here (no side door around the financial gate)', async () => {
    const { call, update } = mk();
    expect((await call({ contractID: 29685345 })).message).toMatch(/use autotask_set_ticket_contract/);
    expect((await call({ companyID: 5, title: 'x' })).message).toMatch(/use autotask_move_ticket_to_company/);
    expect(update).not.toHaveBeenCalled();
  });

  test('Autotask silently not applying a value is reported', async () => {
    const { call } = mk({ id: 210669, ticketNumber: 'T20261007.0010', queueID: 29683421 });
    const r = await call({ queue: 'Tier 1 Support' });
    expect(r.data.verified).toBe(false);
    expect(r.message).toMatch(/WARNING — Autotask did not apply: queueID \(now Purchasing\)/);
  });
});
