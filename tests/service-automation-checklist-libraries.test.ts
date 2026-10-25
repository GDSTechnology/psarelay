// Revenue-First Service Automation — PR C (issue #62): checklist library
// application. Field names verified live: ChecklistLibraries {id, name,
// description, isActive, entityType}; ChecklistLibraryChecklistItems {id,
// checklistLibraryID, itemName, isImportant, knowledgebaseArticleID, position}.

import { AutotaskService } from '../src/services/autotask.service';
import { TOOL_DEFINITIONS, TOOL_CATEGORIES } from '../src/handlers/tool.definitions';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };

function withHttp(fake: any) {
  const service = new AutotaskService(config, logger);
  jest.spyOn(service as any, 'ensureClient').mockResolvedValue(fake);
  return service;
}
const findTool = (name: string) => TOOL_DEFINITIONS.find((t) => t.name === name);
afterEach(() => jest.restoreAllMocks());

describe('searchChecklistLibraries (§10)', () => {
  test('filters by isActive + entityType, name searchTerm uses contains', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 4 }]);
    const svc = withHttp({ query });
    await svc.searchChecklistLibraries({ isActive: true, entityType: 0, searchTerm: 'Firmware' });
    const filters = query.mock.calls[0][1] as any[];
    expect(filters).toContainEqual({ op: 'eq', field: 'isActive', value: true });
    expect(filters).toContainEqual({ op: 'eq', field: 'entityType', value: 0 });
    expect(filters).toContainEqual({ op: 'contains', field: 'name', value: 'Firmware' });
  });

  test('no filter → MATCH_ALL', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const svc = withHttp({ query });
    await svc.searchChecklistLibraries({});
    expect(query.mock.calls[0][1]).toEqual([{ op: 'gte', field: 'id', value: 0 }]);
  });
});

describe('getChecklistLibrary (§10)', () => {
  test('returns the library with its items sorted by position', async () => {
    const get = jest.fn().mockResolvedValue({ id: 4, name: 'Sample Onboarding Checklist' });
    const query = jest.fn().mockResolvedValue([
      { id: 2, itemName: 'B', position: 2 },
      { id: 1, itemName: 'A', position: 1 },
    ]);
    const svc = withHttp({ get, query });
    const lib = await svc.getChecklistLibrary(4);
    expect(get).toHaveBeenCalledWith('ChecklistLibraries', 4);
    expect(query).toHaveBeenCalledWith('ChecklistLibraryChecklistItems', [{ op: 'eq', field: 'checklistLibraryID', value: 4 }], expect.anything());
    expect(lib!.items.map((i: any) => i.itemName)).toEqual(['A', 'B']);
  });

  test('returns null when the library is missing', async () => {
    const svc = withHttp({ get: jest.fn().mockResolvedValue(null), query: jest.fn() });
    expect(await svc.getChecklistLibrary(999)).toBeNull();
  });
});

describe('applyChecklistLibraryToTicket (§10)', () => {
  test('expands library items into TicketChecklistItems, carrying fields', async () => {
    const svc = withHttp({});
    jest.spyOn(svc, 'getChecklistLibraryItems').mockResolvedValue([
      { id: 1, itemName: 'Step 1', isImportant: true, position: 1, knowledgebaseArticleID: 77 },
      { id: 2, itemName: 'Step 2', isImportant: false, position: 2 },
    ]);
    const create = jest.spyOn(svc, 'createTicketChecklistItem').mockResolvedValueOnce(11).mockResolvedValueOnce(12);

    const r = await svc.applyChecklistLibraryToTicket(19502, 4);
    expect(r.created).toEqual([11, 12]);
    expect(r.itemErrors).toEqual([]);
    expect(create).toHaveBeenNthCalledWith(1, 19502, { itemName: 'Step 1', isImportant: true, position: 1, knowledgebaseArticleID: 77 });
    expect(create).toHaveBeenNthCalledWith(2, 19502, { itemName: 'Step 2', isImportant: false, position: 2 });
  });

  test('a failed item is reported without aborting the rest', async () => {
    const svc = withHttp({});
    jest.spyOn(svc, 'getChecklistLibraryItems').mockResolvedValue([
      { id: 1, itemName: 'ok', position: 1 },
      { id: 2, itemName: 'bad', position: 2 },
    ]);
    jest.spyOn(svc, 'createTicketChecklistItem').mockResolvedValueOnce(11).mockRejectedValueOnce(new Error('nope'));
    const r = await svc.applyChecklistLibraryToTicket(19502, 4);
    expect(r.created).toEqual([11]);
    expect(r.itemErrors).toEqual([{ itemName: 'bad', error: 'nope' }]);
  });
});

describe('tool definitions (issue #62)', () => {
  test('all three checklist library tools exist with expected shapes', () => {
    expect((findTool('autotask_search_checklist_libraries') as any).annotations.readOnlyHint).toBe(true);
    expect(findTool('autotask_get_checklist_library')!.inputSchema.required).toEqual(['id']);
    expect(findTool('autotask_apply_checklist_library_to_ticket')!.inputSchema.required).toEqual(['ticketID', 'checklistLibraryID']);
  });

  test('registered in TOOL_CATEGORIES', () => {
    const categorized = new Set(Object.values(TOOL_CATEGORIES).flatMap((c: any) => c.tools));
    for (const n of ['autotask_search_checklist_libraries', 'autotask_get_checklist_library', 'autotask_apply_checklist_library_to_ticket']) {
      expect(categorized.has(n)).toBe(true);
    }
  });
});
