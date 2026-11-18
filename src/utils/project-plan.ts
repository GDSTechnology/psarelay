// Normalized project build plan (Expansion Spec §Phase 4, #46 Layer 2).
//
// The shared, reviewable data model the SOW→project pipeline produces and the
// build engine consumes. Every planning stage (scope extraction, labor plan,
// scheduling, classification) reads/writes this shape; nothing writes to
// Autotask until a plan has been reviewed and approved. Pure/HTTP-free.
//
// Tasks and phases carry client-side string `ref`s (NOT Autotask object ids) so
// dependencies and phase nesting can be expressed before anything exists in the
// tenant. The build engine maps refs → real ids as it creates records.

export interface PlanPhase {
  /** Stable client-side id, unique within the plan. */
  ref: string;
  title: string;
  /** Parent phase ref for nested phases (Autotask parentPhaseID). */
  parentRef?: string;
  description?: string;
}

export interface PlanTask {
  /** Stable client-side id, unique within the plan; referenced by predecessors. */
  ref: string;
  title: string;
  /** Planned effort in hours. 0 is allowed (e.g. a milestone marker). */
  estimatedHours: number;
  /** Phase this task belongs to (ref into plan.phases); omit for unphased. */
  phaseRef?: string;
  /** Parallel resources assumed on this task; falls back to the plan/global default. */
  crewSize?: number;
  /** Refs of tasks that must finish before this one can start. */
  predecessors?: string[];
  /** Working-day lag applied after predecessors finish (default 0). */
  lagDays?: number;
  /** Autotask taskType id (tenant-specific; resolved elsewhere). */
  taskType?: number;
  /** Zero-duration schedule marker (no effort, pins a date). */
  milestone?: boolean;
  description?: string;
  /** Resource to assign (build step "resources"). The role defaults to the resource's default role. */
  assignedResourceID?: number;
  assignedResourceRoleID?: number;
  /** Task dates, YYYY-MM-DD or ISO (build step "dates"; e.g. from autotask_calculate_project_schedule). */
  startDate?: string;
  endDate?: string;
}

/** A project note written by the build (build step "notes"); a note with the same title is never written twice. */
export interface PlanNote {
  title: string;
  description: string;
}

export interface ProjectBuildPlan {
  name: string;
  /** GDS archetype classification (§7), when known. */
  archetype?: string;
  /** Optional free-form provenance (source SOW/quote id, notes) — not built. */
  source?: string;
  phases: PlanPhase[];
  tasks: PlanTask[];
  /** Project notes to write after the tasks (optional). */
  notes?: PlanNote[];
}

export interface PlanValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Structural validation of a build plan: unique refs, resolvable phase parents
 * and task phase refs, resolvable predecessor refs, and acyclic dependencies.
 * Pure — no scheduling or Autotask work. Returns all problems found (does not
 * throw), so callers can surface a complete list before a build.
 */
export function validateBuildPlan(plan: ProjectBuildPlan): PlanValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!plan || typeof plan !== 'object') {
    return { valid: false, errors: ['plan is required'], warnings };
  }
  if (!plan.name || !String(plan.name).trim()) {
    errors.push('plan.name is required');
  }

  const phases = Array.isArray(plan.phases) ? plan.phases : [];
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];

  // Unique phase refs
  const phaseRefs = new Set<string>();
  for (const p of phases) {
    if (!p.ref) { errors.push('every phase needs a ref'); continue; }
    if (phaseRefs.has(p.ref)) errors.push(`duplicate phase ref "${p.ref}"`);
    phaseRefs.add(p.ref);
  }
  // Phase parents resolve, and don't cycle
  for (const p of phases) {
    if (p.parentRef != null && !phaseRefs.has(p.parentRef)) {
      errors.push(`phase "${p.ref}" has unknown parentRef "${p.parentRef}"`);
    }
    if (p.parentRef === p.ref) errors.push(`phase "${p.ref}" is its own parent`);
  }
  detectRefCycle(
    phases.filter((p) => p.parentRef && phaseRefs.has(p.parentRef)).map((p) => [p.ref, [p.parentRef as string]]),
    (ref) => errors.push(`phase parent cycle involving "${ref}"`)
  );

  // Unique task refs
  const taskRefs = new Set<string>();
  for (const t of tasks) {
    if (!t.ref) { errors.push('every task needs a ref'); continue; }
    if (taskRefs.has(t.ref)) errors.push(`duplicate task ref "${t.ref}"`);
    taskRefs.add(t.ref);
  }
  if (tasks.length === 0) warnings.push('plan has no tasks');

  // Task phase refs + predecessors resolve
  for (const t of tasks) {
    if (t.phaseRef != null && !phaseRefs.has(t.phaseRef)) {
      errors.push(`task "${t.ref}" references unknown phaseRef "${t.phaseRef}"`);
    }
    for (const pre of t.predecessors ?? []) {
      if (!taskRefs.has(pre)) errors.push(`task "${t.ref}" has unknown predecessor "${pre}"`);
      if (pre === t.ref) errors.push(`task "${t.ref}" lists itself as a predecessor`);
    }
    if ((t.estimatedHours ?? 0) < 0) errors.push(`task "${t.ref}" has negative estimatedHours`);
    if (t.crewSize != null && t.crewSize <= 0) errors.push(`task "${t.ref}" has crewSize <= 0`);
    const okDate = (v: unknown) => v == null || v === '' || !Number.isNaN(Date.parse(String(v)));
    if (!okDate(t.startDate)) errors.push(`task "${t.ref}" has an unparseable startDate "${t.startDate}"`);
    if (!okDate(t.endDate)) errors.push(`task "${t.ref}" has an unparseable endDate "${t.endDate}"`);
    if (t.startDate && t.endDate && okDate(t.startDate) && okDate(t.endDate) && Date.parse(String(t.endDate)) < Date.parse(String(t.startDate))) {
      errors.push(`task "${t.ref}" ends before it starts`);
    }
    if (t.assignedResourceRoleID != null && t.assignedResourceID == null) warnings.push(`task "${t.ref}" has a role but no resource — the role is ignored`);
  }

  const notes = Array.isArray(plan.notes) ? plan.notes : [];
  notes.forEach((n, i) => {
    if (!n || !String(n.title ?? '').trim() || !String(n.description ?? '').trim()) errors.push(`note ${i + 1} needs a title and a description`);
  });

  // Dependency cycle detection over resolvable predecessors
  detectRefCycle(
    tasks.map((t) => [t.ref, (t.predecessors ?? []).filter((p) => taskRefs.has(p))]),
    (ref) => errors.push(`dependency cycle involving task "${ref}"`)
  );

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Report refs that participate in a cycle over a directed graph given as
 * [node, outgoing-edges] pairs. Calls `onCycle` once per node found on a cycle.
 */
function detectRefCycle(edges: Array<[string, string[]]>, onCycle: (ref: string) => void): void {
  const adj = new Map<string, string[]>(edges);
  const state = new Map<string, 0 | 1 | 2>(); // 0=unseen,1=in-stack,2=done
  const reported = new Set<string>();

  const visit = (node: string): boolean => {
    state.set(node, 1);
    for (const next of adj.get(node) ?? []) {
      const s = state.get(next) ?? 0;
      if (s === 1) { if (!reported.has(next)) { reported.add(next); onCycle(next); } return true; }
      if (s === 0 && visit(next)) return true;
    }
    state.set(node, 2);
    return false;
  };

  for (const [node] of edges) {
    if ((state.get(node) ?? 0) === 0) visit(node);
  }
}
