// #46 — SOW→project build engine. Pure blueprint ordering + the idempotent,
// resumable, dry-run-first build orchestrator. Service methods are mocked; no I/O.

import { orderPhasesForCreate, planProjectBuild, buildMarker, hasBuildMarker } from '../src/utils/project-build';
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';
import type { ProjectBuildPlan } from '../src/utils/project-plan';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' } };

const plan: ProjectBuildPlan = {
  name: 'Deploy',
  phases: [{ ref: 'p1', title: 'Plan' }, { ref: 'p2', title: 'Exec', parentRef: 'p1' }],
  tasks: [
    { ref: 't1', title: 'Survey', estimatedHours: 4, phaseRef: 'p1' },
    { ref: 't2', title: 'Install', estimatedHours: 8, phaseRef: 'p2', predecessors: ['t1'], lagDays: 1 },
  ],
};

describe('project-build (pure)', () => {
  test('orderPhasesForCreate: parent precedes child', () => {
    const ordered = orderPhasesForCreate([
      { ref: 'c', title: 'C', parentRef: 'b' },
      { ref: 'b', title: 'B', parentRef: 'a' },
      { ref: 'a', title: 'A' },
    ]).map((p) => p.ref);
    expect(ordered.indexOf('a')).toBeLessThan(ordered.indexOf('b'));
    expect(ordered.indexOf('b')).toBeLessThan(ordered.indexOf('c'));
    expect(ordered).toHaveLength(3);
  });

  test('orderPhasesForCreate: unresolvable parent kept as root, no dups', () => {
    const ordered = orderPhasesForCreate([{ ref: 'x', title: 'X', parentRef: 'ghost' }]).map((p) => p.ref);
    expect(ordered).toEqual(['x']);
  });

  test('planProjectBuild: counts + dependency edges with lag', () => {
    const bp = planProjectBuild(plan);
    expect(bp.counts).toEqual({ phases: 2, tasks: 2, dependencies: 1 });
    expect(bp.dependencies[0]).toEqual({ taskRef: 't2', predecessorRef: 't1', lagDays: 1 });
    expect(bp.orderedPhases[0].ref).toBe('p1'); // parent first
  });

  test('build marker round-trips', () => {
    const m = buildMarker('10:Deploy');
    expect(hasBuildMarker(`notes\n${m}`, '10:Deploy')).toBe(true);
    expect(hasBuildMarker('notes', '10:Deploy')).toBe(false);
  });
});

describe('buildProjectFromPlan (orchestrator)', () => {
  const svc = () => new AutotaskService(config, logger);

  test('invalid plan → validation_failed, nothing written', async () => {
    const s = svc();
    const create = jest.spyOn(s, 'createProject').mockResolvedValue(1);
    const r = await s.buildProjectFromPlan({ plan: { name: '', tasks: [] } as any, companyID: 10, dryRun: false });
    expect(r.status).toBe('validation_failed');
    expect(create).not.toHaveBeenCalled();
  });

  test('missing company → validation_failed', async () => {
    const s = svc();
    jest.spyOn(s, 'getCompany').mockResolvedValue(null);
    const create = jest.spyOn(s, 'createProject').mockResolvedValue(1);
    const r = await s.buildProjectFromPlan({ plan, companyID: 10, dryRun: false });
    expect(r.status).toBe('validation_failed');
    expect(r.step).toBe('company');
    expect(create).not.toHaveBeenCalled();
  });

  test('dry run (default): no writes, reports planned counts', async () => {
    const s = svc();
    jest.spyOn(s, 'getCompany').mockResolvedValue({ id: 10 } as any);
    jest.spyOn(s, 'searchProjects').mockResolvedValue({ items: [] } as any);
    const create = jest.spyOn(s, 'createProject').mockResolvedValue(500);
    const r = await s.buildProjectFromPlan({ plan, companyID: 10 }); // dryRun defaults true
    expect(r.status).toBe('dry_run');
    expect(r).toMatchObject({ plannedPhases: 2, plannedTasks: 2, plannedDependencies: 1 });
    expect(create).not.toHaveBeenCalled();
  });

  test('build: creates project → phases (parent-first) → tasks → dependency', async () => {
    const s = svc();
    jest.spyOn(s, 'getCompany').mockResolvedValue({ id: 10 } as any);
    jest.spyOn(s, 'searchProjects').mockResolvedValue({ items: [] } as any);
    jest.spyOn(s, 'createProject').mockResolvedValue(500);
    const phaseIds = [601, 602];
    const createPhase = jest.spyOn(s, 'createPhase').mockImplementation(async () => phaseIds.shift()!);
    const taskIds = [701, 702];
    const createTask = jest.spyOn(s, 'createTask').mockImplementation(async () => taskIds.shift()!);
    const addPred = jest.spyOn(s, 'addTaskPredecessor').mockResolvedValue(9);

    const r = await s.buildProjectFromPlan({ plan, companyID: 10, dryRun: false });

    expect(r.status).toBe('built');
    expect(r.projectId).toBe(500);
    // child phase created with the parent's real id
    expect((createPhase.mock.calls[1][0] as any).parentPhaseID).toBe(601);
    // t2 created under phase p2's real id (602)
    expect((createTask.mock.calls[1][0] as any).phaseID).toBe(602);
    // dependency uses mapped ids + lag
    expect(addPred).toHaveBeenCalledWith(702, 701, 1);
    expect(r.summary).toMatchObject({ phasesCreated: 2, tasksCreated: 2, dependenciesCreated: 1 });
  });

  test('resume: existing project reused; only missing records created; existing predecessor skipped', async () => {
    const s = svc();
    jest.spyOn(s, 'getCompany').mockResolvedValue({ id: 10 } as any);
    jest.spyOn(s, 'searchProjects').mockResolvedValue({
      items: [{ id: 500, projectName: 'Deploy', description: `x\n${buildMarker('10:Deploy')}` }],
    } as any);
    jest.spyOn(s, 'searchPhases').mockResolvedValue({ items: [{ id: 601, title: 'Plan' }] } as any);
    jest.spyOn(s, 'searchTasks').mockResolvedValue({ items: [{ id: 701, title: 'Survey' }] } as any);
    jest.spyOn(s, 'listTaskPredecessors').mockResolvedValue([]);
    const createProject = jest.spyOn(s, 'createProject').mockResolvedValue(999);
    jest.spyOn(s, 'createPhase').mockResolvedValue(602); // only p2 is missing
    jest.spyOn(s, 'createTask').mockResolvedValue(702);  // only t2 is missing
    const addPred = jest.spyOn(s, 'addTaskPredecessor').mockResolvedValue(9);

    const r = await s.buildProjectFromPlan({ plan, companyID: 10, dryRun: false });

    expect(createProject).not.toHaveBeenCalled();       // reused existing 500
    expect(r.projectId).toBe(500);
    expect(r.resumed).toBe(true);
    expect(r.summary).toMatchObject({ phasesReused: 1, phasesCreated: 1, tasksReused: 1, tasksCreated: 1, dependenciesCreated: 1 });
    expect(addPred).toHaveBeenCalledWith(702, 701, 1);
  });

  test('resume: dependency already present is not re-added', async () => {
    const s = svc();
    jest.spyOn(s, 'getCompany').mockResolvedValue({ id: 10 } as any);
    jest.spyOn(s, 'searchProjects').mockResolvedValue({
      items: [{ id: 500, projectName: 'Deploy', description: buildMarker('10:Deploy') }],
    } as any);
    jest.spyOn(s, 'searchPhases').mockResolvedValue({ items: [{ id: 601, title: 'Plan' }, { id: 602, title: 'Exec' }] } as any);
    jest.spyOn(s, 'searchTasks').mockResolvedValue({ items: [{ id: 701, title: 'Survey' }, { id: 702, title: 'Install' }] } as any);
    jest.spyOn(s, 'listTaskPredecessors').mockResolvedValue([{ predecessorTaskID: 701 }] as any);
    const addPred = jest.spyOn(s, 'addTaskPredecessor').mockResolvedValue(9);

    const r = await s.buildProjectFromPlan({ plan, companyID: 10, dryRun: false });
    expect(addPred).not.toHaveBeenCalled();
    expect(r.summary).toMatchObject({ dependenciesReused: 1, dependenciesCreated: 0 });
  });

  test('partial failure: a task error is reported, build continues, status built_with_errors', async () => {
    const s = svc();
    jest.spyOn(s, 'getCompany').mockResolvedValue({ id: 10 } as any);
    jest.spyOn(s, 'searchProjects').mockResolvedValue({ items: [] } as any);
    jest.spyOn(s, 'createProject').mockResolvedValue(500);
    const pids = [601, 602];
    jest.spyOn(s, 'createPhase').mockImplementation(async () => pids.shift()!);
    let n = 0;
    jest.spyOn(s, 'createTask').mockImplementation(async () => { n++; if (n === 2) throw new Error('boom'); return 701; });
    const addPred = jest.spyOn(s, 'addTaskPredecessor').mockResolvedValue(9);

    const r = await s.buildProjectFromPlan({ plan, companyID: 10, dryRun: false });
    expect(r.status).toBe('built_with_errors');
    expect((r.errors as any[]).some((e) => e.step === 'task' && e.ref === 't2')).toBe(true);
    // t2 never got an id, so its dependency edge is skipped (not applied)
    expect(addPred).not.toHaveBeenCalled();
    expect(r.summary).toMatchObject({ tasksCreated: 1 });
  });
});
