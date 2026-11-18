// Resume matching for the project build engine (#46 / #20): which plan phases and tasks already exist in the
// target project, so a re-run (or a clone resumed after a failure) creates only what is missing.
//
// Matching is by title WITHIN the parent: a phase by (parent phase, title), a task by (phase, title). Two tasks
// with the same title in different phases — or twice in one phase (a repeated per-site step) — stay separate:
// each existing record is consumed once, in id order. A task that was moved to another phase after a partial
// build still matches when its title is unique in both the plan and the project (the old title-only rule).
// Pure / HTTP-free.

import type { PlanPhase, PlanTask } from './project-plan.js';

export interface ExistingPhase { id: number; title?: string | null; parentPhaseID?: number | null }
export interface ExistingTask {
  id: number; title?: string | null; phaseID?: number | null;
  assignedResourceID?: number | null; assignedResourceRoleID?: number | null; startDateTime?: string | null; endDateTime?: string | null;
}

const t = (s: unknown) => String(s ?? '').trim();
const key = (parent: number | null | undefined, title: unknown) => `${parent ?? ''}|${t(title)}`;

function pools<T extends { id: number }>(rows: T[], keyOf: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of [...rows].sort((a, b) => a.id - b.id)) { const k = keyOf(r); (m.get(k) ?? m.set(k, []).get(k)!).push(r); }
  return m;
}

/** Plan phase ref → existing phase id, for phases already in the project. A child only matches under a matched parent. */
export function matchPhases(ordered: PlanPhase[], existing: ExistingPhase[]): Map<string, number> {
  const pool = pools(existing.filter((p) => p.id != null), (p) => key(p.parentPhaseID, p.title));
  const out = new Map<string, number>();
  for (const p of ordered) {
    let parent: number | null = null;
    if (p.parentRef) { const pid = out.get(p.parentRef); if (pid == null) continue; parent = pid; }
    const hit = pool.get(key(parent, p.title))?.shift();
    if (hit) out.set(p.ref, hit.id);
  }
  return out;
}

/**
 * Plan task ref → existing task, for tasks already in the project. `phaseIds` maps plan phase refs to the
 * existing phase ids (from matchPhases); a task in a phase that doesn't exist yet can't exist yet either,
 * except through the unique-title fallback.
 */
export function matchTasks(tasks: PlanTask[], phaseIds: Map<string, number>, existing: ExistingTask[]): Map<string, ExistingTask> {
  const rows = existing.filter((x) => x.id != null);
  const pool = pools(rows, (x) => key(x.phaseID, x.title));
  const used = new Set<number>();
  const out = new Map<string, ExistingTask>();
  for (const task of tasks) {
    if (task.phaseRef && !phaseIds.has(task.phaseRef)) continue;
    const list = pool.get(key(task.phaseRef ? phaseIds.get(task.phaseRef) : null, task.title)) ?? [];
    const hit = list.find((x) => !used.has(x.id));
    if (hit) { used.add(hit.id); out.set(task.ref, hit); }
  }
  // Fallback: a title unique in the plan AND in the project matches wherever it now sits.
  const count = <T>(xs: T[], f: (x: T) => string) => xs.reduce((m, x) => m.set(f(x), (m.get(f(x)) ?? 0) + 1), new Map<string, number>());
  const planCount = count(tasks, (x) => t(x.title));
  const projectCount = count(rows, (x) => t(x.title));
  for (const task of tasks) {
    if (out.has(task.ref) || planCount.get(t(task.title)) !== 1 || projectCount.get(t(task.title)) !== 1) continue;
    const hit = rows.find((x) => t(x.title) === t(task.title) && !used.has(x.id));
    if (hit) { used.add(hit.id); out.set(task.ref, hit); }
  }
  return out;
}

/** A plan date (YYYY-MM-DD or ISO) → the datetime Autotask stores; undefined when absent / unparseable. */
export function planDateTime(v: unknown): string | undefined {
  const s = t(v);
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * projectDefaults as callers write them (projectType, startDate, endDate — the tool's documented names) →
 * Autotask's Projects fields (type, startDateTime, endDateTime). They were sent as-is, so a build never got
 * its type or dates.
 */
export function normalizeProjectDefaults(d: Record<string, any> | undefined): Record<string, any> {
  const out: Record<string, any> = { ...(d ?? {}) };
  if (out.projectType != null && out.type == null) out.type = out.projectType;
  delete out.projectType;
  if (out.startDate != null && out.startDateTime == null) out.startDateTime = planDateTime(out.startDate);
  if (out.endDate != null && out.endDateTime == null) out.endDateTime = planDateTime(out.endDate);
  delete out.startDate; delete out.endDate;
  return out;
}

/** Whole days between two dates (b − a). */
export function dayOffset(a: string, b: string): number {
  return Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 864e5);
}

/** A datetime shifted by whole days, as YYYY-MM-DD (undefined in → undefined out). */
export function shiftDay(v: string | null | undefined, days: number): string | undefined {
  if (!v) return undefined;
  const d = new Date(`${String(v).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
