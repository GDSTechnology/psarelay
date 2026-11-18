// Project build engine, round 2 (#46 / #20): resume matching by (parent, title) so repeated titles stay separate,
// resources / dates / notes as build steps (filled in on resume), projectDefaults mapped to Autotask's fields,
// a failed resume read creates nothing, and clone_project (structure + dependencies + shifted dates).

import { AutotaskService } from '../src/services/autotask.service';
import { TOOL_DEFINITIONS, TOOL_CATEGORIES } from '../src/handlers/tool.definitions';
import { dayOffset, matchPhases, matchTasks, normalizeProjectDefaults, planDateTime, shiftDay } from '../src/utils/project-build-match';
import { buildMarker } from '../src/utils/project-build';
import { validateBuildPlan, type ProjectBuildPlan } from '../src/utils/project-plan';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
afterEach(() => jest.restoreAllMocks());

describe('resume matching (pure)', () => {
  const phases = [{ ref: 'a', title: 'Site A' }, { ref: 'b', title: 'Site B' }, { ref: 'a1', title: 'Cabling', parentRef: 'a' }];
  test('phases match by (parent, title); a child only under a matched parent', () => {
    const m = matchPhases(phases, [{ id: 1, title: 'Site A' }, { id: 3, title: 'Cabling', parentPhaseID: 1 }, { id: 9, title: 'Cabling' }]);
    expect([...m]).toEqual([['a', 1], ['a1', 3]]);
    expect(matchPhases(phases, [{ id: 3, title: 'Cabling', parentPhaseID: 1 }]).size).toBe(0);
  });
  test('the same task title in two phases, and twice in one phase, stays separate', () => {
    const tasks = [
      { ref: 'x1', title: 'Install AP', estimatedHours: 1, phaseRef: 'a' },
      { ref: 'x2', title: 'Install AP', estimatedHours: 1, phaseRef: 'a' },
      { ref: 'y1', title: 'Install AP', estimatedHours: 1, phaseRef: 'b' },
    ];
    const ph = new Map([['a', 1], ['b', 2]]);
    const m = matchTasks(tasks, ph, [{ id: 11, title: 'Install AP', phaseID: 1 }, { id: 21, title: 'Install AP', phaseID: 2 }]);
    expect(m.get('x1')?.id).toBe(11);
    expect(m.has('x2')).toBe(false); // only one exists in phase a → the second is still missing
    expect(m.get('y1')?.id).toBe(21);
  });
  test('a task moved to another phase still matches when its title is unique on both sides', () => {
    const tasks = [{ ref: 't', title: 'Survey', estimatedHours: 1, phaseRef: 'a' }, { ref: 'u', title: 'Dup', estimatedHours: 1, phaseRef: 'a' }];
    const m = matchTasks(tasks, new Map([['a', 1]]), [{ id: 5, title: 'Survey', phaseID: 7 }, { id: 6, title: 'Dup', phaseID: 7 }, { id: 8, title: 'Dup', phaseID: 9 }]);
    expect(m.get('t')?.id).toBe(5);
    expect(m.has('u')).toBe(false); // "Dup" is not unique in the project
  });
  test('date helpers and projectDefaults mapping', () => {
    expect(planDateTime('2026-12-01')).toBe('2026-12-01T00:00:00Z');
    expect(planDateTime('nope')).toBeUndefined();
    expect(normalizeProjectDefaults({ projectType: 5, startDate: '2026-12-01', endDate: '2026-12-31', status: 1 }))
      .toEqual({ type: 5, status: 1, startDateTime: '2026-12-01T00:00:00Z', endDateTime: '2026-12-31T00:00:00Z' });
    expect(dayOffset('2026-01-10T00:00:00Z', '2026-12-01')).toBe(325);
    expect(shiftDay('2026-01-12T15:00:00Z', 325)).toBe('2026-12-03');
  });
  test('validation: bad dates, end before start, notes need text', () => {
    const v = validateBuildPlan({ name: 'x', phases: [], tasks: [{ ref: 't', title: 'T', estimatedHours: 1, startDate: '2026-12-05', endDate: '2026-12-01' }], notes: [{ title: 'N', description: '' }] });
    expect(v.errors).toEqual(expect.arrayContaining(['task "t" ends before it starts', 'note 1 needs a title and a description']));
  });
});

const plan: ProjectBuildPlan = {
  name: 'Wifi rollout',
  phases: [{ ref: 'a', title: 'Site A' }],
  tasks: [
    { ref: 't1', title: 'Install AP', estimatedHours: 2, phaseRef: 'a', assignedResourceID: 5, startDate: '2026-12-01', endDate: '2026-12-01' },
    { ref: 't2', title: 'Install AP', estimatedHours: 2, phaseRef: 'a', predecessors: ['t1'] },
  ],
  notes: [{ title: 'Scope', description: 'Two APs' }],
};

function svc() {
  const s = new AutotaskService(config, logger);
  jest.spyOn(s, 'getCompany').mockResolvedValue({ id: 0 } as any);
  jest.spyOn(s, 'resolveResourceDefaultRole').mockResolvedValue(29);
  jest.spyOn(s, 'listTaskPredecessors').mockResolvedValue([]);
  jest.spyOn(s, 'addTaskPredecessor').mockResolvedValue(9);
  return s;
}

describe('buildProjectFromPlan with resources, dates and notes', () => {
  test('new project: required fields defaulted and listed; tasks get resource + role + dates; notes written', async () => {
    const s = svc();
    jest.spyOn(s, 'searchProjects').mockResolvedValue({ items: [] } as any);
    const createProject = jest.spyOn(s, 'createProject').mockResolvedValue(500);
    jest.spyOn(s, 'createPhase').mockResolvedValue(601);
    const ids = [701, 702];
    const createTask = jest.spyOn(s, 'createTask').mockImplementation(async () => ids.shift()!);
    const createNote = jest.spyOn(s, 'createProjectNote').mockResolvedValue(1);
    const r = await s.buildProjectFromPlan({ plan, companyID: 0, projectDefaults: { projectType: 5 }, dryRun: false });
    expect(r.status).toBe('built');
    expect(createProject.mock.calls[0]![0]).toMatchObject({ companyID: 0, type: 5, status: 1, startDateTime: '2026-12-01T00:00:00Z', endDateTime: '2026-12-31T00:00:00Z' });
    expect(createProject.mock.calls[0]![0]).not.toHaveProperty('projectType');
    expect(r.defaultsApplied).toEqual(['status 1 (New)', 'start 2026-12-01', 'end 2026-12-31']);
    expect(createTask.mock.calls[0]![0]).toMatchObject({ phaseID: 601, assignedResourceID: 5, assignedResourceRoleID: 29, startDateTime: '2026-12-01T00:00:00Z', endDateTime: '2026-12-01T00:00:00Z' });
    expect(createTask).toHaveBeenCalledTimes(2); // both "Install AP" tasks
    expect(createNote).toHaveBeenCalledWith(500, expect.objectContaining({ title: 'Scope', description: 'Two APs' }));
    expect(r.summary).toMatchObject({ tasksCreated: 2, notesCreated: 1, dependenciesCreated: 1 });
  });

  test('resume: dry run says what is missing; execute fills the reused task and skips the existing note', async () => {
    const s = svc();
    jest.spyOn(s, 'searchProjects').mockResolvedValue({ items: [{ id: 500, projectName: 'Wifi rollout', description: buildMarker('0:Wifi rollout') }] } as any);
    jest.spyOn(s, 'getProjectBuildState').mockResolvedValue({
      phases: [{ id: 601, title: 'Site A' }], tasks: [{ id: 701, title: 'Install AP', phaseID: 601 }], noteTitles: ['Scope'],
    });
    const createProject = jest.spyOn(s, 'createProject').mockResolvedValue(999);
    const createTask = jest.spyOn(s, 'createTask').mockResolvedValue(702);
    const updateTask = jest.spyOn(s, 'updateTask').mockResolvedValue();
    const createNote = jest.spyOn(s, 'createProjectNote').mockResolvedValue(1);

    const dry = await s.buildProjectFromPlan({ plan, companyID: 0 });
    expect(dry).toMatchObject({ status: 'dry_run', existingProjectId: 500, stillMissing: { phases: 0, tasks: 1, notes: 0 } });

    const r = await s.buildProjectFromPlan({ plan, companyID: 0, dryRun: false });
    expect(createProject).not.toHaveBeenCalled();
    expect(updateTask).toHaveBeenCalledWith(701, { projectID: 500, assignedResourceID: 5, assignedResourceRoleID: 29, startDateTime: '2026-12-01T00:00:00Z', endDateTime: '2026-12-01T00:00:00Z' });
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createNote).not.toHaveBeenCalled();
    expect(r.summary).toMatchObject({ tasksReused: 1, tasksCreated: 1, tasksUpdated: 1, notesReused: 1 });
  });

  test('a resource without a default role: task created unassigned, error reported', async () => {
    const s = svc();
    (s.resolveResourceDefaultRole as jest.Mock).mockResolvedValue(null);
    jest.spyOn(s, 'searchProjects').mockResolvedValue({ items: [] } as any);
    jest.spyOn(s, 'createProject').mockResolvedValue(500);
    jest.spyOn(s, 'createPhase').mockResolvedValue(601);
    const createTask = jest.spyOn(s, 'createTask').mockResolvedValue(701);
    jest.spyOn(s, 'createProjectNote').mockResolvedValue(1);
    const r = await s.buildProjectFromPlan({ plan, companyID: 0, dryRun: false });
    expect(createTask.mock.calls[0]![0]).not.toHaveProperty('assignedResourceID');
    expect(r.status).toBe('built_with_errors');
    expect((r.errors as any[])[0]).toMatchObject({ step: 'resource', ref: 't1' });
  });

  test('resume read fails → nothing created', async () => {
    const s = svc();
    jest.spyOn(s, 'searchProjects').mockResolvedValue({ items: [{ id: 500, projectName: 'Wifi rollout', description: buildMarker('0:Wifi rollout') }] } as any);
    jest.spyOn(s, 'getProjectBuildState').mockRejectedValue(new Error('HTTP 500'));
    const createPhase = jest.spyOn(s, 'createPhase').mockResolvedValue(601);
    const createTask = jest.spyOn(s, 'createTask').mockResolvedValue(701);
    const r = await s.buildProjectFromPlan({ plan, companyID: 0, dryRun: false });
    expect(r.status).toBe('built_with_errors');
    expect((r.errors as any[])[0]).toMatchObject({ step: 'load-existing' });
    expect(createPhase).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
  });
});

describe('cloneProject', () => {
  const structure = {
    project: { id: 40, projectName: 'Template rollout', type: 5, startDateTime: '2026-01-10T00:00:00Z', endDateTime: '2026-02-09T00:00:00Z', projectLeadResourceID: 8 },
    phases: [{ id: 1, title: 'Site', description: 'per site', tasks: [{ id: 10, title: 'Survey', estimatedHours: 2, startDateTime: '2026-01-12T00:00:00Z', endDateTime: '2026-01-12T00:00:00Z', assignedResourceID: 5, assignedResourceRoleID: 29 }],
      children: [{ id: 2, title: 'Cabling', parentPhaseID: 1, tasks: [{ id: 11, title: 'Pull cable', estimatedHours: 6, taskType: 1 }], children: [] }] }],
    unphasedTasks: [{ id: 12, title: 'Handover', estimatedHours: 1 }],
  };
  test('registered, dry-run-first, in the projects category', () => {
    expect(TOOL_DEFINITIONS.map((d) => d.name)).toContain('autotask_clone_project');
    expect((TOOL_CATEGORIES as any).projects.tools).toContain('autotask_clone_project');
  });
  test('builds a plan from the structure + dependencies, shifts dates, resources only when asked', async () => {
    const s = svc();
    jest.spyOn(s, 'getProjectStructure').mockResolvedValue(structure as any);
    jest.spyOn(s, 'getProjectTaskPredecessors').mockResolvedValue({ items: [{ successorTaskID: 11, predecessorTaskID: 10, lagDays: 2 }, { successorTaskID: 12, predecessorTaskID: 999 }], failedChunks: [] });
    const build = jest.spyOn(s, 'buildProjectFromPlan').mockResolvedValue({ status: 'dry_run' } as any);

    const r = await s.cloneProject({ sourceProjectID: 40, companyID: 3, startDate: '2026-12-01' });
    const call = build.mock.calls[0]![0];
    expect(call).toMatchObject({ companyID: 3, buildKey: 'clone:40:3:Template rollout', projectDefaults: { type: 5, status: 1, startDate: '2026-12-01', endDate: '2026-12-31' } });
    expect(call.projectDefaults).not.toHaveProperty('projectLeadResourceID');
    expect(call.plan.phases).toEqual([{ ref: 'p1', title: 'Site', description: 'per site' }, { ref: 'p2', title: 'Cabling', parentRef: 'p1' }]);
    expect(call.plan.tasks).toEqual([
      { ref: 't10', title: 'Survey', estimatedHours: 2, phaseRef: 'p1', startDate: '2026-12-03', endDate: '2026-12-03' },
      { ref: 't11', title: 'Pull cable', estimatedHours: 6, phaseRef: 'p2', taskType: 1, predecessors: ['t10'], lagDays: 2 },
      { ref: 't12', title: 'Handover', estimatedHours: 1 }, // its predecessor is outside the project → dropped
    ]);
    expect(r.clonedFrom).toMatchObject({ projectID: 40, phases: 2, tasks: 3, dependencies: 1, shiftDays: 325, resourcesCopied: false });

    await s.cloneProject({ sourceProjectID: 40, companyID: 3, startDate: '2026-12-01', includeResources: true, projectName: 'Acme rollout' });
    const c2 = build.mock.calls[1]![0];
    expect(c2.plan.tasks[0]).toMatchObject({ assignedResourceID: 5, assignedResourceRoleID: 29 });
    expect(c2).toMatchObject({ buildKey: 'clone:40:3:Acme rollout', projectDefaults: { projectLeadResourceID: 8 } });
  });
  test('missing source, bad date, unreadable dependencies → nothing built', async () => {
    const s = svc();
    const build = jest.spyOn(s, 'buildProjectFromPlan').mockResolvedValue({ status: 'dry_run' } as any);
    jest.spyOn(s, 'getProjectStructure').mockResolvedValueOnce({ project: null } as any);
    expect(await s.cloneProject({ sourceProjectID: 41, companyID: 3 })).toMatchObject({ status: 'validation_failed', step: 'source' });
    jest.spyOn(s, 'getProjectStructure').mockResolvedValue(structure as any);
    expect(await s.cloneProject({ sourceProjectID: 40, companyID: 3, startDate: '12/01/2026' })).toMatchObject({ status: 'validation_failed', step: 'startDate' });
    jest.spyOn(s, 'getProjectTaskPredecessors').mockResolvedValue({ items: [], failedChunks: [{ ids: [10], error: 'HTTP 500' }] });
    expect(await s.cloneProject({ sourceProjectID: 40, companyID: 3 })).toMatchObject({ status: 'validation_failed', step: 'dependencies' });
    expect(build).not.toHaveBeenCalled();
  });
});
