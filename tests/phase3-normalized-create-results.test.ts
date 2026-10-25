// Normalized create-result contract (brief §5 / §7.1): every create tool returns
// { id, entityType, parentType?, parentId? } as `data`, so callers never
// special-case itemId vs item.

import {
  normalizeCreateResult,
  normalizeCreateToolResult,
  CREATE_TOOL_META,
} from '../src/utils/create-result';
import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

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

/** Parse the JSON envelope a tool emits: { message, data }. */
function toolData(result: { content: Array<{ text: string }> }): any {
  return JSON.parse(result.content[0].text).data;
}

describe('normalizeCreateResult (pure)', () => {
  test('id-only result omits optional keys', () => {
    expect(normalizeCreateResult('Companies', 42)).toEqual({ id: 42, entityType: 'Companies' });
  });

  test('carries parentType/parentId/item when provided', () => {
    expect(
      normalizeCreateResult('Contacts', 5, { parentType: 'Companies', parentId: 777, item: { firstName: 'Joan' } })
    ).toEqual({ id: 5, entityType: 'Contacts', parentType: 'Companies', parentId: 777, item: { firstName: 'Joan' } });
  });

  test('does not add undefined optional keys', () => {
    // Cast to exercise runtime behavior — exactOptionalPropertyTypes forbids
    // passing explicit undefined through the typed signature.
    const out = normalizeCreateResult('Tickets', 1, { parentType: undefined, parentId: undefined } as any);
    expect('parentType' in out).toBe(false);
    expect('parentId' in out).toBe(false);
  });
});

describe('normalizeCreateToolResult', () => {
  test('maps a child create id to the normalized shape with parent', () => {
    const out = normalizeCreateToolResult('autotask_create_contact', { companyID: 777 }, 555);
    expect(out).toEqual({ id: 555, entityType: 'Contacts', parentType: 'Companies', parentId: 777 });
  });

  test('tolerates parent-id arg casing (companyId vs companyID)', () => {
    const note = normalizeCreateToolResult('autotask_create_company_note', { companyId: 9 }, 3);
    expect(note).toEqual({ id: 3, entityType: 'CompanyNotes', parentType: 'Companies', parentId: 9 });
  });

  test('omits parentId when no parent arg is present', () => {
    const out = normalizeCreateToolResult('autotask_create_contact', {}, 555);
    expect(out).toEqual({ id: 555, entityType: 'Contacts', parentType: 'Companies' });
  });

  test('top-level create has entityType only', () => {
    expect(normalizeCreateToolResult('autotask_create_company', {}, 42)).toEqual({
      id: 42,
      entityType: 'Companies',
    });
  });

  test('passes through non-create tools unchanged', () => {
    expect(normalizeCreateToolResult('autotask_search_tickets', {}, [1, 2, 3])).toEqual([1, 2, 3]);
  });

  test('passes through when result is not a numeric id', () => {
    const already = { id: 1, entityType: 'Companies' };
    expect(normalizeCreateToolResult('autotask_create_company', {}, already)).toBe(already);
  });

  test('every mapped tool has a non-empty entityType', () => {
    for (const [tool, meta] of Object.entries(CREATE_TOOL_META)) {
      expect(typeof meta.entityType).toBe('string');
      expect(meta.entityType.length).toBeGreaterThan(0);
      expect(tool.startsWith('autotask_create')).toBe(true);
    }
  });
});

describe('create tools emit the normalized contract end-to-end', () => {
  test('autotask_create_contact -> data is the normalized object', async () => {
    const service = new AutotaskService(config, logger);
    jest.spyOn(service, 'createContact').mockResolvedValue(555 as any);
    const handler = new AutotaskToolHandler(service, logger);

    const result = await handler.callTool('autotask_create_contact', {
      companyID: 777,
      firstName: 'Joan',
      lastName: 'Eberly',
    });

    expect(toolData(result)).toEqual({
      id: 555,
      entityType: 'Contacts',
      parentType: 'Companies',
      parentId: 777,
    });
  });

  test('autotask_create_company -> data has entityType, no parent', async () => {
    const service = new AutotaskService(config, logger);
    jest.spyOn(service, 'createCompany').mockResolvedValue(42 as any);
    const handler = new AutotaskToolHandler(service, logger);

    const result = await handler.callTool('autotask_create_company', { companyName: 'Acme Technology' });

    expect(toolData(result)).toEqual({ id: 42, entityType: 'Companies' });
  });

  afterEach(() => jest.restoreAllMocks());
});
