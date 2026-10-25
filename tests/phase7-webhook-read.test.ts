// #23 §16 — webhook management (read/discovery). Entity catalog (pure) +
// search/get through the service (mocked HTTP).

import { resolveWebhookEntity, WEBHOOK_ENTITIES, WEBHOOK_ENTITY_KEYS } from '../src/utils/webhook-entities';
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

describe('webhook entity catalog (pure)', () => {
  test('maps the five webhook-capable entities to their REST entity names', () => {
    expect(WEBHOOK_ENTITY_KEYS.sort()).toEqual(['companies', 'configurationItems', 'contacts', 'ticketNotes', 'tickets']);
    expect(WEBHOOK_ENTITIES.tickets).toMatchObject({
      parent: 'TicketWebhooks', fields: 'TicketWebhookFields',
      udfFields: 'TicketWebhookUdfFields', excludedResources: 'TicketWebhookExcludedResources',
    });
  });

  test('resolves aliases case-insensitively', () => {
    expect(resolveWebhookEntity('Tickets')!.parent).toBe('TicketWebhooks');
    expect(resolveWebhookEntity('ci')!.parent).toBe('ConfigurationItemWebhooks');
    expect(resolveWebhookEntity('account')!.parent).toBe('CompanyWebhooks');
    expect(resolveWebhookEntity('ticket note')!.parent).toBe('TicketNoteWebhooks');
    expect(resolveWebhookEntity('nope')).toBeNull();
    expect(resolveWebhookEntity(undefined)).toBeNull();
  });
});

describe('service webhook reads', () => {
  const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' } };
  const mk = () => new AutotaskService(config, new Logger('error'));

  test('searchWebhooks queries the parent entity; activeOnly filters', async () => {
    const s = mk();
    const query = jest.fn().mockResolvedValue([{ id: 1, name: 'W1', isActive: true }, { id: 2, name: 'W2', isActive: false }]);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query });
    const r = await s.searchWebhooks('tickets');
    expect(query.mock.calls[0][0]).toBe('TicketWebhooks');
    expect(r.webhooks).toHaveLength(2);

    await s.searchWebhooks('tickets', { activeOnly: true });
    expect(query.mock.calls[1][1]).toEqual([{ op: 'eq', field: 'isActive', value: true }]);
  });

  test('unsupported entity throws with the supported list', async () => {
    const s = mk();
    await expect(s.searchWebhooks('invoices')).rejects.toThrow(/Unsupported webhook entity|Unknown/);
  });

  test('getWebhook fetches parent + fields + udf + excluded resources by webhookID', async () => {
    const s = mk();
    const get = jest.fn().mockResolvedValue({ id: 7, name: 'Ticket hook', webhookUrl: 'https://n8n/x' });
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 11, webhookID: 7, fieldID: 3 }])          // fields
      .mockResolvedValueOnce([])                                              // udf
      .mockResolvedValueOnce([{ id: 21, webhookID: 7, resourceID: 30683829 }]); // excluded
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ get, query });
    const r = await s.getWebhook('tickets', 7);
    expect(get).toHaveBeenCalledWith('TicketWebhooks', 7);
    expect(query.mock.calls[0]).toEqual(['TicketWebhookFields', [{ op: 'eq', field: 'webhookID', value: 7 }], expect.anything()]);
    expect(r!.fields).toHaveLength(1);
    expect(r!.excludedResources[0].resourceID).toBe(30683829);
  });

  test('getWebhook returns null when the parent is missing', async () => {
    const s = mk();
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ get: async () => null, query: async () => [] });
    expect(await s.getWebhook('tickets', 999)).toBeNull();
  });
});
