// #46 §2.4 — extend_project: add phases/tasks/deps to an EXISTING project by id,
// idempotent (title-matched reuse), dry-run-first. Service mocked; no I/O.

import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';
import type { ProjectBuildPlan } from '../src/utils/project-plan';

const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' } };
const svc = () => new AutotaskService(config, new Logger('error'));

// Plan adds phase "Exec" + task "Install"; the project already has "Plan"/"Survey".
const plan: ProjectBuildPlan = {
  name: 'Change Order 1',
  phases: [{ ref: 'p1', title: 'Plan' }, { ref: 'p2', title: 'Exec', parentRef: 'p1' }],
  tasks: [
    { ref: 't1', title: 'Survey', estimatedHours: 4, phaseRef: 'p1' },
    { ref: 't2', title: 'Install', estimatedHours: 8, phaseRef: 'p2', predecessors: ['t1'], lagDays: 1 },
  ],
};

describe('extendProject', () => {
  test('missing project → validation_failed, nothing written', async () => {
    const s = svc();
    jest.spyOn(s, 'getProject').mockResolvedValue(null);
    const createTask = jest.spyOn(s, 'createTask').mockResolvedValue(1);
    const r = await s.extendProject({ projectID: 500, plan, dryRun: false });
    expect(r.status).toBe('validation_failed');
    expect(r.step).toBe('project');
    expect(createTask).not.toHaveBeenCalled();
  });

  test('invalid plan → validation_failed', async () => {
    const s = svc();
    jest.spyOn(s, 'getProject').mockResolvedValue({ id: 500 } as any);
    const r = await s.extendProject({ projectID: 500, plan: { name: '', tasks: [] } as any, dryRun: false });
    expect(r.status).toBe('validation_failed');
  });

  test('dry run (default): reports only the NEW phases/tasks, writes nothing', async () => {
    const s = svc();
    jest.spyOn(s, 'getProject').mockResolvedValue({ id: 500, projectName: 'Site A' } as any);
    jest.spyOn(s, 'searchPhases').mockResolvedValue({ items: [{ id: 601, title: 'Plan' }] } as any);
    jest.spyOn(s, 'searchTasks').mockResolvedValue({ items: [{ id: 701, title: 'Survey' }] } as any);
    const createPhase = jest.spyOn(s, 'createPhase').mockResolvedValue(602);
    const createTask = jest.spyOn(s, 'createTask').mockResolvedValue(702);
    const r = await s.extendProject({ projectID: 500, plan }); // dryRun defaults true
    expect(r.status).toBe('dry_run');
    expect(r.wouldAddPhases).toEqual(['Exec']);            // "Plan" already present
    expect((r.wouldAddTasks as any[]).map((t) => t.title)).toEqual(['Install']); // "Survey" present
    expect(createPhase).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
  });

  test('execute: adds only missing phase/task + dependency; reuses existing', async () => {
    const s = svc();
    jest.spyOn(s, 'getProject').mockResolvedValue({ id: 500, projectName: 'Site A' } as any);
    jest.spyOn(s, 'searchPhases').mockResolvedValue({ items: [{ id: 601, title: 'Plan' }] } as any);
    jest.spyOn(s, 'searchTasks').mockResolvedValue({ items: [{ id: 701, title: 'Survey' }] } as any);
    jest.spyOn(s, 'listTaskPredecessors').mockResolvedValue([]);
    const createPhase = jest.spyOn(s, 'createPhase').mockResolvedValue(602);
    const createTask = jest.spyOn(s, 'createTask').mockResolvedValue(702);
    const addPred = jest.spyOn(s, 'addTaskPredecessor').mockResolvedValue(9);

    const r = await s.extendProject({ projectID: 500, plan, dryRun: false });

    expect(r.status).toBe('extended');
    expect(r.projectId).toBe(500);
    expect(createPhase).toHaveBeenCalledTimes(1);          // only "Exec"
    expect(createTask).toHaveBeenCalledTimes(1);           // only "Install"
    // new task "Install" (702) depends on existing "Survey" (701) with lag 1
    expect(addPred).toHaveBeenCalledWith(702, 701, 1);
    expect(r.summary).toMatchObject({ phasesCreated: 1, phasesReused: 1, tasksCreated: 1, tasksReused: 1, dependenciesCreated: 1 });
  });

  test('execute: an existing dependency is not re-added', async () => {
    const s = svc();
    jest.spyOn(s, 'getProject').mockResolvedValue({ id: 500 } as any);
    jest.spyOn(s, 'searchPhases').mockResolvedValue({ items: [{ id: 601, title: 'Plan' }, { id: 602, title: 'Exec' }] } as any);
    jest.spyOn(s, 'searchTasks').mockResolvedValue({ items: [{ id: 701, title: 'Survey' }, { id: 702, title: 'Install' }] } as any);
    jest.spyOn(s, 'listTaskPredecessors').mockResolvedValue([{ predecessorTaskID: 701 } as any]);
    const addPred = jest.spyOn(s, 'addTaskPredecessor').mockResolvedValue(9);

    const r = await s.extendProject({ projectID: 500, plan, dryRun: false });

    expect(addPred).not.toHaveBeenCalled();                // dependency already there
    expect(r.summary).toMatchObject({ phasesReused: 2, tasksReused: 2, dependenciesReused: 1, dependenciesCreated: 0 });
  });
});
