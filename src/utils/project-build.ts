// Deterministic build blueprint for the SOW→project build engine (#46, §8/§14).
//
// Turns a VALIDATED ProjectBuildPlan into the ordered set of mutations the build
// engine will apply: phases in parent-before-child order, tasks, and the
// task-dependency edges. Pure/HTTP-free so the ordering and edge extraction are
// unit-testable without a tenant. The engine (autotask.service) maps the plan's
// client-side `ref`s to real Autotask ids as it creates records, and uses the
// build marker below to find a prior partial build and resume it idempotently.

import { PlanPhase, PlanTask, ProjectBuildPlan } from './project-plan.js';

export interface DependencyEdge {
  /** task that must wait */
  taskRef: string;
  /** task that must finish first */
  predecessorRef: string;
  lagDays: number;
}

export interface BuildBlueprint {
  /** Phases in an order where every parent precedes its children. */
  orderedPhases: PlanPhase[];
  /** Tasks in stable plan order. */
  tasks: PlanTask[];
  /** Flattened predecessor edges across all tasks. */
  dependencies: DependencyEdge[];
  counts: { phases: number; tasks: number; dependencies: number };
}

/**
 * Order phases so a parent is always created before its children (Autotask needs
 * the parent's id to set parentPhaseID). Stable: roots and siblings keep their
 * input order. Assumes an acyclic parent graph (validateBuildPlan enforces it);
 * any phase whose parentRef doesn't resolve is treated as a root so it is never
 * dropped.
 */
export function orderPhasesForCreate(phases: PlanPhase[]): PlanPhase[] {
  const byRef = new Map<string, PlanPhase>(phases.map((p) => [p.ref, p]));
  const ordered: PlanPhase[] = [];
  const placed = new Set<string>();

  const place = (p: PlanPhase, guard: Set<string>): void => {
    if (placed.has(p.ref) || guard.has(p.ref)) return;
    guard.add(p.ref);
    if (p.parentRef != null && byRef.has(p.parentRef)) {
      place(byRef.get(p.parentRef)!, guard);
    }
    if (!placed.has(p.ref)) {
      ordered.push(p);
      placed.add(p.ref);
    }
  };

  for (const p of phases) place(p, new Set());
  return ordered;
}

/** Turn a validated plan into the ordered mutation blueprint. */
export function planProjectBuild(plan: ProjectBuildPlan): BuildBlueprint {
  const orderedPhases = orderPhasesForCreate(plan.phases ?? []);
  const tasks = [...(plan.tasks ?? [])];
  const dependencies: DependencyEdge[] = [];
  for (const t of tasks) {
    for (const pre of t.predecessors ?? []) {
      dependencies.push({ taskRef: t.ref, predecessorRef: pre, lagDays: t.lagDays ?? 0 });
    }
  }
  return {
    orderedPhases,
    tasks,
    dependencies,
    counts: { phases: orderedPhases.length, tasks: tasks.length, dependencies: dependencies.length },
  };
}

/**
 * Deterministic marker embedded in a built project's description so a re-run
 * finds the same project and resumes instead of creating a duplicate. The
 * buildKey is caller-supplied or derived (company + plan name).
 */
export function buildMarker(buildKey: string): string {
  return `[psarelay-build-key:${buildKey}]`;
}

/** The marker written before the rename — projects built then must still be found. */
const legacyBuildMarker = (buildKey: string) => `[atmcp-build-key:${buildKey}]`;

/** Whether `text` carries the marker for `buildKey`. */
export function hasBuildMarker(text: string | undefined | null, buildKey: string): boolean {
  return typeof text === 'string' && (text.includes(buildMarker(buildKey)) || text.includes(legacyBuildMarker(buildKey)));
}
