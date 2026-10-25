// autotask_get_complete_project_context (plan §10) — read-only composite that
// assembles project + hierarchy + dependencies + labor + notes/attachments +
// company + commercial linkage. Best-effort: a failing section is recorded under
// `errors`, never fails the whole call. Composed methods are mocked.

import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };

/** Structure with a root phase (1 task) → child phase (1 task), plus 1 unphased task. */
function structure(project: Record<string, any> | null) {
  return {
    project,
    phases: [
      { id: 10, title: 'Root', tasks: [{ id: 101 }], children: [{ id: 11, title: 'Child', tasks: [{ id: 111 }], children: [] }] },
    ],
    unphasedTasks: [{ id: 999 }],
    summary: { phaseCount: 2, taskCount: 3, unphasedTaskCount: 1, maxPhaseDepth: 2, estimatedHours: 40 },
  };
}

function fullyMockedService(project: Record<string, any> | null) {
  const svc = new AutotaskService(config, logger);
  jest.spyOn(svc, 'getProjectStructure').mockResolvedValue(structure(project) as any);
  jest.spyOn(svc, 'getProjectLaborSummary').mockResolvedValue({ estimatedHours: 40, actualHours: 12 } as any);
  jest.spyOn(svc, 'getProjectTaskPredecessors').mockResolvedValue({ items: [{ id: 4, predecessorTaskID: 101, successorTaskID: 111, lagDays: 0 }], failedChunks: [] });
  jest.spyOn(svc, 'searchProjectNotes').mockResolvedValue([{ id: 1, description: 'kickoff' }] as any);
  jest.spyOn(svc, 'searchProjectAttachments').mockResolvedValue([{ id: 7, title: 'SOW.pdf' }] as any);
  jest.spyOn(svc, 'getCompany').mockResolvedValue({ id: 29684006, companyName: 'Sanctuary' } as any);
  jest.spyOn(svc, 'getContract').mockResolvedValue({ id: 29685498, contractName: 'Camera Upgrades' } as any);
  jest.spyOn(svc, 'searchContractMilestones').mockResolvedValue([{ id: 913 }, { id: 914 }] as any);
  jest.spyOn(svc, 'getOpportunity').mockResolvedValue({ id: 2522, title: 'Opp' } as any);
  jest.spyOn(svc, 'searchConfigurationItems').mockResolvedValue([{ id: 1 }] as any);
  return svc;
}
afterEach(() => jest.restoreAllMocks());

const PROJECT = { id: 177, projectName: 'Camera Server Upgrades', companyID: 29684006, contractID: 29685498, opportunityID: 2522 };

describe('assembly (happy path)', () => {
  test('collects the full nested + unphased task set for the dependency query', async () => {
    const svc = fullyMockedService(PROJECT);
    const predSpy = svc.getProjectTaskPredecessors as jest.Mock;
    await svc.getCompleteProjectContext(177);
    expect(predSpy).toHaveBeenCalledTimes(1);
    expect((predSpy.mock.calls[0][0] as number[]).sort()).toEqual([101, 111, 999]);
  });

  test('assembles every section with correct summary counts and no errors', async () => {
    const ctx = await fullyMockedService(PROJECT).getCompleteProjectContext(177);
    expect(ctx.found).toBe(true);
    expect(ctx.project.id).toBe(177);
    expect(ctx.dependencies).toHaveLength(1);
    expect(ctx.commercial.contract.id).toBe(29685498);
    expect(ctx.commercial.contractMilestones).toHaveLength(2);
    expect(ctx.commercial.opportunity.id).toBe(2522);
    expect(ctx.company.id).toBe(29684006);
    expect(ctx.summary).toMatchObject({ phaseCount: 2, taskCount: 3, dependencyCount: 1, milestoneCount: 2, hasContract: true, hasOpportunity: true });
    expect(ctx.errors).toEqual([]);
  });

  test('configuration items are opt-in (default off)', async () => {
    const svc = fullyMockedService(PROJECT);
    const ciSpy = svc.searchConfigurationItems as jest.Mock;
    const off = await svc.getCompleteProjectContext(177);
    expect(off.configurationItems).toEqual([]);
    expect(ciSpy).not.toHaveBeenCalled();

    const svc2 = fullyMockedService(PROJECT);
    const on = await svc2.getCompleteProjectContext(177, { includeConfigurationItems: true });
    expect(on.configurationItems).toHaveLength(1);
    expect(svc2.searchConfigurationItems as jest.Mock).toHaveBeenCalledWith({ companyID: 29684006 });
  });
});

describe('fail-soft + guards', () => {
  test('a failing section is recorded under errors, the rest still assemble', async () => {
    const svc = fullyMockedService(PROJECT);
    jest.spyOn(svc, 'searchProjectNotes').mockRejectedValue(new Error('boom: notes read failed'));
    const ctx = await svc.getCompleteProjectContext(177);
    expect(ctx.found).toBe(true);
    expect(ctx.notes).toEqual([]);
    expect(ctx.errors).toEqual([{ section: 'notes', error: 'boom: notes read failed' }]);
    // other sections unaffected
    expect(ctx.commercial.contract.id).toBe(29685498);
  });

  test('failed dependency chunks surface as errors but do not fail the call', async () => {
    const svc = fullyMockedService(PROJECT);
    jest.spyOn(svc, 'getProjectTaskPredecessors').mockResolvedValue({ items: [], failedChunks: [{ ids: [111], error: 'HTTP 429' }] });
    const ctx = await svc.getCompleteProjectContext(177);
    expect(ctx.dependencies).toEqual([]);
    expect(ctx.errors.some((e: any) => e.section === 'predecessors' && /429/.test(e.error))).toBe(true);
  });

  test('not-found project returns { found:false } without fetching sections', async () => {
    const svc = fullyMockedService(null);
    const laborSpy = svc.getProjectLaborSummary as jest.Mock;
    const ctx = await svc.getCompleteProjectContext(177);
    expect(ctx.found).toBe(false);
    expect(ctx.message).toMatch(/not found/i);
    expect(laborSpy).not.toHaveBeenCalled();
  });

  test('includeCommercial:false skips contract/opportunity and nulls commercial', async () => {
    const svc = fullyMockedService(PROJECT);
    const contractSpy = svc.getContract as jest.Mock;
    const oppSpy = svc.getOpportunity as jest.Mock;
    const ctx = await svc.getCompleteProjectContext(177, { includeCommercial: false });
    expect(ctx.commercial).toBeNull();
    expect(contractSpy).not.toHaveBeenCalled();
    expect(oppSpy).not.toHaveBeenCalled();
  });
});
