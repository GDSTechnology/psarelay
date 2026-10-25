// Risk classification + confirmation policy (Expansion Spec §4.3, issue #13).
// Destructive/financial mutations require an explicit confirm:true; read-only and
// routine reversible updates pass through untouched.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { TOOL_DEFINITIONS } from '../src/handlers/tool.definitions';
import { Logger } from '../src/utils/logger';
import {
  classifyRisk,
  requiresExplicitConfirmation,
  FINANCIAL_TOOLS,
} from '../src/utils/risk';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = {
  name: 'test-server', version: '0.0.0',
  autotask: { username: 'user@example.com', secret: 'secret', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' },
};

function toolData(result: { content: Array<{ text: string }> }): any {
  return JSON.parse(result.content[0].text).data;
}

describe('risk classification', () => {
  test('readOnlyHint → read-only (no confirmation)', () => {
    expect(classifyRisk('autotask_get_contract', { readOnlyHint: true })).toBe('read-only');
    expect(requiresExplicitConfirmation('read-only')).toBe(false);
  });

  test('destructiveHint → destructive (confirmation required)', () => {
    expect(classifyRisk('autotask_delete_quote_item', { destructiveHint: true })).toBe('destructive');
    expect(requiresExplicitConfirmation('destructive')).toBe(true);
  });

  test('financial registry → financial (confirmation required)', () => {
    expect(classifyRisk('autotask_create_contract')).toBe('financial');
    expect(requiresExplicitConfirmation('financial')).toBe(true);
  });

  test('read-only annotation wins over financial registry membership', () => {
    // A tool marked read-only must never be reclassified as financial.
    expect(classifyRisk('autotask_create_contract', { readOnlyHint: true })).toBe('read-only');
  });

  test('unclassified mutation → reversible-update (no hard gate)', () => {
    expect(classifyRisk('autotask_update_ticket')).toBe('reversible-update');
    expect(requiresExplicitConfirmation('reversible-update')).toBe(false);
  });

  test('every financial tool exists in the tool catalog', () => {
    const names = new Set(TOOL_DEFINITIONS.map(t => t.name));
    for (const tool of FINANCIAL_TOOLS) {
      expect(names.has(tool)).toBe(true);
    }
  });
});

describe('confirmation gate in callTool', () => {
  test('financial tool without confirm → confirmation_required, service not called', async () => {
    const service = new AutotaskService(config, logger);
    const spy = jest.spyOn(service as any, 'createContracts').mockResolvedValue([{ index: 0, success: true, id: 1 }]);
    const handler = new AutotaskToolHandler(service, logger);

    const result = await handler.callTool('autotask_create_contracts_bulk', { contracts: [{ companyID: 1 }] });

    expect(toolData(result)).toMatchObject({ status: 'confirmation_required', riskLevel: 'financial', tool: 'autotask_create_contracts_bulk' });
    expect(spy).not.toHaveBeenCalled();
  });

  test('financial tool with confirm:true proceeds; confirm is stripped before dispatch', async () => {
    const service = new AutotaskService(config, logger);
    const spy = jest.spyOn(service as any, 'createContracts').mockResolvedValue([{ index: 0, success: true, id: 1 }]);
    const handler = new AutotaskToolHandler(service, logger);

    await handler.callTool('autotask_create_contracts_bulk', { contracts: [{ companyID: 1 }], confirm: true });

    expect(spy).toHaveBeenCalledTimes(1);
    // confirm is a control flag; it must not reach the service payload.
    const forwarded = spy.mock.calls[0][0];
    expect(JSON.stringify(forwarded)).not.toContain('confirm');
  });

  test('read-only tool runs without confirm', async () => {
    const service = new AutotaskService(config, logger);
    const spy = jest.spyOn(service, 'getContract').mockResolvedValue({ id: 55 } as any);
    const handler = new AutotaskToolHandler(service, logger);

    const result = await handler.callTool('autotask_get_contract', { id: 55 });

    expect(spy).toHaveBeenCalledWith(55);
    expect(result.isError).toBeFalsy();
  });
});
