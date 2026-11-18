// close_opportunity (#20 §7): status / reasons by label from live picklists, only fields the tenant has and can
// write, dry run by default, rerun safety, and the delivery project (reused when one is already linked).

import { AutotaskService } from '../src/services/autotask.service';
import { TOOL_DEFINITIONS, TOOL_CATEGORIES } from '../src/handlers/tool.definitions';
import { classifyRisk } from '../src/utils/risk';
import { alreadyAt, pickOutcomeStatus } from '../src/utils/opportunity-close';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
afterEach(() => jest.restoreAllMocks());

const STATUS = [{ value: '0', label: 'Not Ready To Buy' }, { value: '1', label: 'Active' }, { value: '2', label: 'Lost' }, { value: '3', label: 'Closed' }, { value: '4', label: 'Implemented' }];
const f = (name: string, extra: Record<string, any> = {}) => ({ name, dataType: 'string', isRequired: false, isReadOnly: false, isQueryable: true, isReference: false, isPickList: false, ...extra });
const FIELDS = [
  f('status', { isPickList: true, picklistValues: STATUS }),
  f('closedDate'), f('lostDate'), f('probability'),
  f('lossReason', { isPickList: true, picklistValues: [{ value: '1', label: 'Price' }, { value: '2', label: 'Competitor' }] }),
  f('lossReasonDetail'),
  // winReason exists but no winReasonDetail in this tenant
  f('winReason', { isPickList: true, picklistValues: [{ value: '7', label: 'Relationship' }] }),
];

function world(opp: Record<string, any>, linkedProjects: Array<Record<string, any>> = []) {
  let stored = { ...opp };
  const http = {
    get: jest.fn(async (e: string, id: number) => (e === 'Opportunities' && id === stored.id ? { ...stored } : null)),
    update: jest.fn(async (_e: string, _id: number, patch: any) => { stored = { ...stored, ...patch }; }),
    query: jest.fn(async (e: string) => (e === 'Projects' ? linkedProjects : [])),
  };
  const svc = new AutotaskService(config, logger);
  jest.spyOn(svc as any, 'ensureClient').mockResolvedValue(http);
  jest.spyOn(svc, 'getFieldInfo').mockResolvedValue(FIELDS as any);
  jest.spyOn(svc, 'getPicklistValues').mockImplementation(async (_e: string, field: string) =>
    (field === 'type' ? [{ value: '5', label: 'Client' }] : [{ value: '1', label: 'New' }]) as any);
  const createProject = jest.spyOn(svc, 'createProject').mockResolvedValue(777);
  return { svc, http, createProject };
}
const OPP = { id: 50, title: 'Firewall refresh', companyID: 0, ownerResourceID: 5, status: 1, probability: 60 };

describe('helpers', () => {
  test('status by stock label; override by label; renamed tenant returns the choices', () => {
    expect(pickOutcomeStatus(STATUS as any, 'won')).toEqual({ ok: true, value: 3, label: 'Closed' });
    expect(pickOutcomeStatus(STATUS as any, 'lost')).toEqual({ ok: true, value: 2, label: 'Lost' });
    expect(pickOutcomeStatus(STATUS as any, 'won', 'implemented')).toMatchObject({ value: 4 });
    expect(pickOutcomeStatus([{ value: '9', label: 'Signed' }] as any, 'won')).toMatchObject({ ok: false, choices: [{ value: 9, label: 'Signed' }] });
  });
  test('Implemented already counts as won', () => {
    expect(alreadyAt(STATUS as any, 4, 'won', 3)).toBe(true);
    expect(alreadyAt(STATUS as any, 4, 'lost', 2)).toBe(false);
    expect(alreadyAt(STATUS as any, 1, 'won', 3)).toBe(false);
  });
});

describe('closeOpportunity', () => {
  test('registered as financial, dry-run first, in the financial category', () => {
    const d = TOOL_DEFINITIONS.find((x) => x.name === 'autotask_close_opportunity')!;
    expect(classifyRisk(d.name, d.annotations as any)).toBe('financial');
    expect((TOOL_CATEGORIES as any).financial.tools).toContain('autotask_close_opportunity');
  });
  test('lost: dry run by default writes nothing; plan has status, dates, probability, reason + detail', async () => {
    const { svc, http } = world(OPP);
    const r = await svc.closeOpportunity({ opportunityID: 50, outcome: 'lost', reason: 'competitor', reasonDetail: 'Went with incumbent', closedDate: '2026-11-17' });
    expect(r).toMatchObject({ status: 'planned', statusLabel: 'Lost', closedDate: '2026-11-17' });
    expect(r.changes).toEqual({
      status: { from: 1, to: 2 }, closedDate: { from: null, to: '2026-11-17T12:00:00Z' }, lostDate: { from: null, to: '2026-11-17T12:00:00Z' },
      probability: { from: 60, to: 0 }, lossReason: { from: null, to: 2 }, lossReasonDetail: { from: null, to: 'Went with incumbent' },
    });
    expect(http.update).not.toHaveBeenCalled();
  });
  test('won with dryRun:false writes the PATCH, reads back; a field the tenant lacks is reported, not sent', async () => {
    const { svc, http } = world(OPP);
    const r = await svc.closeOpportunity({ opportunityID: 50, outcome: 'won', reason: 'Relationship', reasonDetail: 'x', closedDate: '2026-11-17', dryRun: false });
    expect(http.update).toHaveBeenCalledWith('Opportunities', 50, { status: 3, closedDate: '2026-11-17T12:00:00Z', probability: 100, winReason: 7 });
    expect(r).toMatchObject({ status: 'closed', verified: true, notApplied: [], notSent: ['winReasonDetail'] });
    // rerun: already won → nothing written
    const again = await svc.closeOpportunity({ opportunityID: 50, outcome: 'won', closedDate: '2026-11-17', dryRun: false });
    expect(again).toMatchObject({ status: 'unchanged' });
    expect(http.update).toHaveBeenCalledTimes(1);
  });
  test('won + createProject creates the delivery project; an already-linked project is reused', async () => {
    const { svc, createProject } = world(OPP);
    const r = await svc.closeOpportunity({ opportunityID: 50, outcome: 'won', closedDate: '2026-11-17', createProject: true, dryRun: false });
    expect(createProject).toHaveBeenCalledWith({
      projectName: 'Firewall refresh', companyID: 0, type: 5, status: 1, startDateTime: '2026-11-17T00:00:00Z', endDateTime: '2026-12-17T00:00:00Z',
      opportunityID: 50, projectLeadResourceID: 5,
    });
    expect(r.project).toEqual({ status: 'created', projectID: 777, projectName: 'Firewall refresh' });

    const w2 = world({ ...OPP, status: 3 }, [{ id: 31, projectName: 'Existing' }]);
    const r2 = await w2.svc.closeOpportunity({ opportunityID: 50, outcome: 'won', createProject: true, dryRun: false });
    expect(r2).toMatchObject({ status: 'unchanged', project: { status: 'exists', projectID: 31 } });
    expect(w2.createProject).not.toHaveBeenCalled();
  });
  test('project failure after the close is reported as partial', async () => {
    const { svc, createProject } = world(OPP);
    createProject.mockRejectedValue(new Error('HTTP 500 boom'));
    const r = await svc.closeOpportunity({ opportunityID: 50, outcome: 'won', closedDate: '2026-11-17', createProject: true, dryRun: false });
    expect(r).toMatchObject({ status: 'partial', project: { status: 'failed', error: 'HTTP 500 boom' } });
  });
  test('refusals: bad outcome, createProject on lost, unknown reason, bad date, missing opportunity', async () => {
    const { svc, http } = world(OPP);
    expect(await svc.closeOpportunity({ opportunityID: 50, outcome: 'maybe' as any })).toMatchObject({ status: 'invalid' });
    expect(await svc.closeOpportunity({ opportunityID: 50, outcome: 'lost', createProject: true })).toMatchObject({ status: 'invalid' });
    expect(await svc.closeOpportunity({ opportunityID: 50, outcome: 'lost', reason: 'Weather' })).toMatchObject({ status: 'invalid', choices: [{ value: 1, label: 'Price' }, { value: 2, label: 'Competitor' }] });
    expect(await svc.closeOpportunity({ opportunityID: 50, outcome: 'lost', closedDate: '17/11/2026' })).toMatchObject({ status: 'invalid' });
    expect(await svc.closeOpportunity({ opportunityID: 51, outcome: 'lost' })).toMatchObject({ status: 'not_found' });
    expect(http.update).not.toHaveBeenCalled();
  });
});
