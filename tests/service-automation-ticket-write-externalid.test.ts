// Revenue-First Service Automation — PR B (issue #61): ticket write + externalID
// idempotency + TicketAdditionalConfigurationItems. Field names verified against
// the live Tickets and TicketAdditionalConfigurationItems ({id, ticketID,
// configurationItemID}) schemas. Mocked http / mocked service.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { TOOL_DEFINITIONS } from '../src/handlers/tool.definitions';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };

function withHttp(fake: any) {
  const service = new AutotaskService(config, logger);
  jest.spyOn(service as any, 'ensureClient').mockResolvedValue(fake);
  return service;
}
const toolData = (result: { content: Array<{ text: string }> }): any => JSON.parse(result.content[0].text).data;
const findTool = (name: string) => TOOL_DEFINITIONS.find((t) => t.name === name);
afterEach(() => jest.restoreAllMocks());

describe('externalID idempotency (§9)', () => {
  test('searchTickets adds an externalID eq filter and preserves externalID in output', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 1, ticketNumber: 'T1', externalID: 'CS-1:LOC-2:FW:2026-09' }]);
    const svc = withHttp({ query });
    const { items: rows } = await svc.searchTickets({ externalID: 'CS-1:LOC-2:FW:2026-09' } as any);
    const filters = query.mock.calls[0][1] as any[];
    expect(filters).toContainEqual({ op: 'eq', field: 'externalID', value: 'CS-1:LOC-2:FW:2026-09' });
    expect(rows[0].externalID).toBe('CS-1:LOC-2:FW:2026-09'); // survives the aggressive optimizer
  });

  test('findTicketByExternalId queries Tickets by externalID (un-optimized)', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 9, externalID: 'KEY', status: 1, description: 'x'.repeat(400) }]);
    const svc = withHttp({ query });
    const rows = await svc.findTicketByExternalId('KEY');
    expect(query).toHaveBeenCalledWith('Tickets', [{ op: 'eq', field: 'externalID', value: 'KEY' }], expect.objectContaining({ maxRecords: 25 }));
    expect(rows[0]).toMatchObject({ id: 9, externalID: 'KEY' });
    expect(rows[0].description).toHaveLength(400); // not truncated by the optimizer
  });
});

describe('TicketAdditionalConfigurationItems (§8)', () => {
  test('searchTicketConfigurationItems filters by ticketID (+ optional CI)', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 1, ticketID: 19502, configurationItemID: 100 }]);
    const svc = withHttp({ query });
    await svc.searchTicketConfigurationItems(19502, 100);
    expect(query).toHaveBeenCalledWith(
      'TicketAdditionalConfigurationItems',
      [{ op: 'eq', field: 'ticketID', value: 19502 }, { op: 'eq', field: 'configurationItemID', value: 100 }],
      expect.anything()
    );
  });

  test('addTicketConfigurationItem creates {ticketID, configurationItemID}', async () => {
    const create = jest.fn().mockResolvedValue(555);
    const svc = withHttp({ create });
    const id = await svc.addTicketConfigurationItem(19502, 100);
    expect(id).toBe(555);
    expect(create).toHaveBeenCalledWith('TicketAdditionalConfigurationItems', { ticketID: 19502, configurationItemID: 100 });
  });

  test('removeTicketConfigurationItem deletes by association id', async () => {
    const del = jest.fn().mockResolvedValue(undefined);
    const svc = withHttp({ delete: del });
    await svc.removeTicketConfigurationItem(555);
    expect(del).toHaveBeenCalledWith('TicketAdditionalConfigurationItems', 555);
  });
});

describe('createTicketWithConfigurationItems convenience (§7/§12)', () => {
  test('creates ticket, links CIs, reads back; ticket id authoritative when a link fails', async () => {
    const svc = withHttp({});
    jest.spyOn(svc, 'createTicket').mockResolvedValue(19502);
    const add = jest.spyOn(svc, 'addTicketConfigurationItem')
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('CI 200 not in company'));
    jest.spyOn(svc, 'getTicket').mockResolvedValue({ id: 19502, title: 'Maint' } as any);
    jest.spyOn(svc, 'searchTicketConfigurationItems').mockResolvedValue([{ id: 1, ticketID: 19502, configurationItemID: 100 }]);

    const r = await svc.createTicketWithConfigurationItems({ title: 'Maint' } as any, [100, 200]);
    expect(add).toHaveBeenCalledTimes(2);
    expect(r.id).toBe(19502);
    expect(r.item).toMatchObject({ id: 19502 });
    expect(r.additionalConfigurationItems).toHaveLength(1);
    expect(r.linkErrors).toEqual([{ configurationItemID: 200, error: 'CI 200 not in company' }]);
  });
});

describe('create_ticket handler wiring (§7)', () => {
  test('passes contract/externalID/problem fields into the create payload', async () => {
    const service = new AutotaskService(config, logger);
    const spy = jest.spyOn(service, 'createTicket').mockResolvedValue(1);
    const handler = new AutotaskToolHandler(service, logger);
    await handler.callTool('autotask_create_ticket', {
      companyID: 1, title: 'T', description: 'D',
      contractID: 100, contractServiceID: 200, contractServiceBundleID: 300,
      externalID: 'OCC-1', problemTicketId: 42, configurationItemID: 9,
    });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      contractID: 100, contractServiceID: 200, contractServiceBundleID: 300,
      externalID: 'OCC-1', problemTicketId: 42, configurationItemID: 9,
    }));
  });

  test('additionalConfigurationItemIDs routes through the convenience flow', async () => {
    const service = new AutotaskService(config, logger);
    const conv = jest.spyOn(service, 'createTicketWithConfigurationItems').mockResolvedValue({
      id: 19502, item: { id: 19502 } as any, additionalConfigurationItems: [{ id: 1 }], linkErrors: [],
    });
    const plain = jest.spyOn(service, 'createTicket').mockResolvedValue(1);
    const handler = new AutotaskToolHandler(service, logger);
    const result = await handler.callTool('autotask_create_ticket', {
      companyID: 1, title: 'T', description: 'D', additionalConfigurationItemIDs: [100, 101],
    });
    expect(conv).toHaveBeenCalledWith(expect.objectContaining({ companyID: 1, title: 'T' }), [100, 101]);
    expect(plain).not.toHaveBeenCalled();
    expect(toolData(result)).toMatchObject({ id: 19502 });
  });
});

describe('remove_ticket_configuration_item is confirmation-gated (destructive)', () => {
  test('without confirm → confirmation_required, service not called', async () => {
    const service = new AutotaskService(config, logger);
    const spy = jest.spyOn(service, 'removeTicketConfigurationItem').mockResolvedValue(undefined);
    const handler = new AutotaskToolHandler(service, logger);
    const result = await handler.callTool('autotask_remove_ticket_configuration_item', { ticketID: 1, associationID: 555 });
    expect(toolData(result)).toMatchObject({ status: 'confirmation_required', riskLevel: 'destructive' });
    expect(spy).not.toHaveBeenCalled();
  });

  test('with confirm:true proceeds', async () => {
    const service = new AutotaskService(config, logger);
    const spy = jest.spyOn(service, 'removeTicketConfigurationItem').mockResolvedValue(undefined);
    const handler = new AutotaskToolHandler(service, logger);
    await handler.callTool('autotask_remove_ticket_configuration_item', { associationID: 555, confirm: true });
    expect(spy).toHaveBeenCalledWith(555);
  });
});

describe('tool definitions (issue #61)', () => {
  test('create_ticket exposes the new §7 fields', () => {
    const props = findTool('autotask_create_ticket')!.inputSchema.properties as Record<string, any>;
    expect(props.contractID.type).toBe('number');
    expect(props.contractServiceID.type).toBe('number');
    expect(props.contractServiceBundleID.type).toBe('number');
    expect(props.externalID.type).toBe('string');
    expect(props.problemTicketId.type).toBe('number');
    expect(props.additionalConfigurationItemIDs.type).toBe('array');
  });

  test('search_tickets exposes externalID; find_ticket_by_external_id exists and is read-only', () => {
    expect((findTool('autotask_search_tickets')!.inputSchema.properties as any).externalID.type).toBe('string');
    const find = findTool('autotask_find_ticket_by_external_id');
    expect(find!.inputSchema.required).toEqual(['externalID']);
    expect((find as any).annotations.readOnlyHint).toBe(true);
  });

  test('ticket-CI tools exist; remove is destructive', () => {
    expect(findTool('autotask_search_ticket_configuration_items')).toBeDefined();
    expect(findTool('autotask_add_ticket_configuration_item')!.inputSchema.required).toEqual(['ticketID', 'configurationItemID']);
    const remove = findTool('autotask_remove_ticket_configuration_item');
    expect((remove as any).annotations.destructiveHint).toBe(true);
    expect(remove!.inputSchema.required).toEqual(['associationID']);
  });
});
