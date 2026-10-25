// Idempotent ticket notes: a re-run of a closeout that adds touch-point notes
// must not create duplicates. createTicketNoteIdempotent embeds a deterministic
// [MCP-ID:<key>] marker in the note body and returns the prior note when the
// marker is already present on the ticket.

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

const KEY = 'RPO-MTG:T20260922.0189:PARKWOOD-IPAD';
const MARKER = `[MCP-ID:${KEY}]`;

describe('AutotaskService.createTicketNoteIdempotent', () => {
  afterEach(() => jest.restoreAllMocks());

  test('first run: no marker present -> creates, appends the marker to the body', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'searchTicketNotes').mockResolvedValue([]);
    const create = jest.spyOn(svc, 'createTicketNote').mockResolvedValue(9001);

    const out = await svc.createTicketNoteIdempotent(204722, { description: 'Parkwood iPad touch point', noteType: 1, publish: 1 }, KEY);

    expect(out).toEqual({ created: true, noteId: 9001, idempotencyKey: KEY });
    const passed = create.mock.calls[0][1] as any;
    expect(passed.description).toContain('Parkwood iPad touch point');
    expect(passed.description).toContain(MARKER);
  });

  test('second run: marker already on a note -> returns it, does NOT create', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'searchTicketNotes').mockResolvedValue([
      { id: 42, description: `Parkwood iPad touch point\n\n${MARKER}` } as any,
    ]);
    const create = jest.spyOn(svc, 'createTicketNote').mockResolvedValue(9999);

    const out = await svc.createTicketNoteIdempotent(204722, { description: 'Parkwood iPad touch point', noteType: 1, publish: 1 }, KEY);

    expect(out).toEqual({ created: false, noteId: 42, idempotencyKey: KEY });
    expect(create).not.toHaveBeenCalled();
  });

  test('blank key -> plain create, no marker, no dedup search', async () => {
    const svc = new AutotaskService(config, logger);
    const search = jest.spyOn(svc, 'searchTicketNotes').mockResolvedValue([]);
    const create = jest.spyOn(svc, 'createTicketNote').mockResolvedValue(7);

    const out = await svc.createTicketNoteIdempotent(204722, { description: 'x', noteType: 1, publish: 1 }, '   ');

    expect(out).toEqual({ created: true, noteId: 7 });
    expect(search).not.toHaveBeenCalled();
    const passed = create.mock.calls[0][1] as any;
    expect(passed.description).toBe('x');
  });
});

describe('autotask_create_ticket_note tool with idempotencyKey', () => {
  afterEach(() => jest.restoreAllMocks());

  test('routes through the idempotent path and reports "not duplicated" on a hit', async () => {
    const svc = new AutotaskService(config, logger);
    const idem = jest.spyOn(svc, 'createTicketNoteIdempotent').mockResolvedValue({ created: false, noteId: 42, idempotencyKey: KEY });
    const plain = jest.spyOn(svc, 'createTicketNote').mockResolvedValue(1);
    const handler = new AutotaskToolHandler(svc, logger);

    const result = await handler.callTool('autotask_create_ticket_note', {
      ticketId: 204722, description: 'x', noteType: 1, publish: 1, idempotencyKey: KEY,
    });

    expect(idem).toHaveBeenCalled();
    expect(plain).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('not duplicated');
    expect(result.content[0].text).toContain('42');
  });

  test('without idempotencyKey uses the plain create path', async () => {
    const svc = new AutotaskService(config, logger);
    const idem = jest.spyOn(svc, 'createTicketNoteIdempotent').mockResolvedValue({ created: true, noteId: 5 });
    const plain = jest.spyOn(svc, 'createTicketNote').mockResolvedValue(5);
    const handler = new AutotaskToolHandler(svc, logger);

    await handler.callTool('autotask_create_ticket_note', { ticketId: 204722, description: 'x', noteType: 1, publish: 1 });

    expect(plain).toHaveBeenCalled();
    expect(idem).not.toHaveBeenCalled();
  });
});
