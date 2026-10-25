// currentUser proxy data input (Expansion Spec §4.1/§9): "act as me" resolves the
// caller to their Autotask resource and writes it into the tool's resource field.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = {
  name: 'test-server', version: '0.0.0',
  autotask: { username: 'user@example.com', secret: 'secret', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' },
};
const META = { source: 'hermes-teams', requestingUserEmail: 'jf@gds.com' };
const RESOURCE = { id: 30683829, firstName: 'Jonathan', lastName: 'Fitzgerald', email: 'jf@gds.com' };

function toolData(result: { content: Array<{ text: string }> }): any {
  return JSON.parse(result.content[0].text).data;
}

afterEach(() => jest.restoreAllMocks());

describe('currentUser proxy input', () => {
  test('create_time_entry: currentUser resolves to the caller resourceID; currentUser is stripped', async () => {
    const service = new AutotaskService(config, logger);
    jest.spyOn(service, 'searchResourcesByEmail').mockResolvedValue([RESOURCE]);
    const createSpy = jest.spyOn(service, 'createTimeEntry').mockResolvedValue(700 as any);
    const handler = new AutotaskToolHandler(service, logger);

    await handler.callTool(
      'autotask_create_time_entry',
      { ticketID: 204722, hoursWorked: 0.1, dateWorked: '2026-08-26', summaryNotes: 'work', currentUser: true },
      META
    );

    const payload = createSpy.mock.calls[0][0] as Record<string, any>;
    expect(payload.resourceID).toBe(30683829);
    expect(payload).not.toHaveProperty('currentUser');
  });

  test('create_company_todo: currentUser resolves to assignedToResourceID', async () => {
    const service = new AutotaskService(config, logger);
    jest.spyOn(service, 'searchResourcesByEmail').mockResolvedValue([RESOURCE]);
    const createSpy = jest.spyOn(service, 'createCompanyToDo').mockResolvedValue(1 as any);
    const handler = new AutotaskToolHandler(service, logger);

    await handler.callTool(
      'autotask_create_company_todo',
      { companyID: 29684773, actionType: 3, startDateTime: 'a', endDateTime: 'b', currentUser: true },
      META
    );

    const payload = createSpy.mock.calls[0][0] as Record<string, any>;
    expect(payload.assignedToResourceID).toBe(30683829);
    expect(payload).not.toHaveProperty('currentUser');
  });

  test('currentUser but caller unmapped → identity prompt, no create', async () => {
    const service = new AutotaskService(config, logger);
    jest.spyOn(service, 'searchResourcesByEmail').mockResolvedValue([]);
    const createSpy = jest.spyOn(service, 'createCompanyToDo').mockResolvedValue(1 as any);
    const handler = new AutotaskToolHandler(service, logger);

    const result = await handler.callTool(
      'autotask_create_company_todo',
      { companyID: 29684773, actionType: 3, startDateTime: 'a', endDateTime: 'b', currentUser: true },
      { source: 'hermes-teams', requestingUserEmail: 'ghost@x.com' }
    );

    expect(toolData(result)).toMatchObject({ status: 'user_identification_required', reason: 'not-found' });
    expect(createSpy).not.toHaveBeenCalled();
  });

  test('explicit resource field wins over currentUser (no resolution call)', async () => {
    const service = new AutotaskService(config, logger);
    const emailSpy = jest.spyOn(service, 'searchResourcesByEmail').mockResolvedValue([RESOURCE]);
    const createSpy = jest.spyOn(service, 'createCompanyToDo').mockResolvedValue(1 as any);
    const handler = new AutotaskToolHandler(service, logger);

    await handler.callTool(
      'autotask_create_company_todo',
      { companyID: 1, actionType: 3, startDateTime: 'a', endDateTime: 'b', assignedToResourceID: 777, currentUser: true },
      META
    );

    const payload = createSpy.mock.calls[0][0] as Record<string, any>;
    expect(payload.assignedToResourceID).toBe(777);
    expect(payload).not.toHaveProperty('currentUser');
    expect(emailSpy).not.toHaveBeenCalled();
  });
});
