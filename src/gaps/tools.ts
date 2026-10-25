// autotask_report_gap — an agent says what it couldn't do with the MCP's tools,
// so it lands on the console's Requests page to be built. Plus automatic
// capture by the server (captureGap) for an unknown tool name.

import type { Pool } from 'pg';
import type { CallerContext } from '../types/context.js';
import { GAP_PRIORITIES, GAP_STATUSES, GapStore, type GapInput, type GapPriority } from './store.js';

type Result = { result: unknown; message: string };
type H = (a: Record<string, any>, ctx: CallerContext) => Promise<Result>;
const who = (ctx: CallerContext) => ctx.requestingUserEmail ?? (ctx.source !== 'unknown' ? ctx.source : ctx.origin?.userAgent ?? null);

export function gapToolHandlers(getPool: () => Pool | null): Array<[string, H]> {
  return [
    ['autotask_report_gap', async (a, ctx) => {
      const p = getPool();
      if (!p) return { result: { status: 'unavailable' }, message: 'Needs the Postgres store (MCP_PG_ENABLED=true, migration 0014). Tell the user what was missing instead.' };
      const st = new GapStore(p);
      if (String(a.action ?? 'report') === 'list') {
        const status = Array.isArray(a.status) ? a.status.map(String) : a.status ? [String(a.status)] : ['open', 'planned'];
        const gaps = await st.list({ status, limit: Number(a.limit) || 50, ...(a.search ? { search: String(a.search) } : {}) });
        return { result: { gaps: gaps.map((g) => ({ id: g.id, title: g.title, status: g.status, priority: g.priority, occurrences: g.occurrences, lastSeen: g.lastSeen, toolTried: g.toolTried, resolution: g.resolution })) }, message: `${gaps.length} request(s) (${status.join(' / ')}). Check here before reporting the same gap again.` };
      }
      const title = String(a.title ?? '').trim();
      if (title.length < 8) return { result: { status: 'invalid_value', field: 'title' }, message: 'title: one line saying what you needed and could not do, e.g. "Delete a contract charge" or "Search tickets by a UDF value".' };
      const priority = (GAP_PRIORITIES as readonly string[]).includes(String(a.priority)) ? String(a.priority) as GapPriority : 'normal';
      const { gap, created } = await st.report({ title, detail: a.detail ? String(a.detail) : null, source: 'agent', reporter: who(ctx), toolTried: a.toolsTried ? String(Array.isArray(a.toolsTried) ? a.toolsTried.join(', ') : a.toolsTried) : null, example: a.example ?? null, priority });
      return { result: { id: gap.id, created, occurrences: gap.occurrences, status: gap.status }, message: created ? `Recorded request #${gap.id} "${gap.title}" — it shows on the console's Requests page. Tell the user it was logged; do not work around it with raw_request writes.` : `Already requested as #${gap.id} ("${gap.title}", ${gap.status}) — counted another occurrence (${gap.occurrences}).` };
    }],
  ];
}

/** Statuses a console user may set. */
export { GAP_STATUSES, GAP_PRIORITIES };

const recent = new Map<string, number>();
/** Best-effort server-side capture (an unknown tool was called). Never throws; the same key at most every 10 minutes. */
export function captureGap(getPool: () => Pool | null, g: Omit<GapInput, 'source'> & { dedupeKey: string }): void {
  const now = Date.now();
  if ((recent.get(g.dedupeKey) ?? 0) > now - 600_000) return;
  recent.set(g.dedupeKey, now);
  if (recent.size > 500) for (const [k, t] of recent) if (t < now - 600_000) recent.delete(k);
  const p = getPool(); if (!p) return;
  void new GapStore(p).report({ ...g, source: 'auto' }).catch(() => undefined);
}
