// Tools: safe company / contact merges (phase 1 — read-only toward Autotask).
//   autotask_merge_discover              candidate duplicates (all 3 email fields, every page)
//   autotask_merge_dependency_inventory  what points at each company / contact, and what blocks
//   autotask_merge_build_plan            an ID-only work list of Autotask UI steps (one pair, or a CSV)
//   autotask_merge_verify                after the UI merges: re-read everything, mark the steps done
// The merge itself is Autotask's native UI merge (then delete in Admin); the MCP never imitates it.

import type { Pool } from 'pg';
import type { AutotaskService } from '../services/autotask.service.js';
import type { CallerContext } from '../types/context.js';
import { PlanStore } from '../change-plans/store.js';
import { planView } from '../vendors/catalog-tools.js';
import { MERGE_PLAN_KINDS, buildMergeRows, evaluateMerge, parseMergeMappings, validateMergeIds, type MergeEntity, type MergeGroup, type MergeRecord, type RecordInventory, type SourceState } from './model.js';
import { companyRecord, contactRecord, discover, inventory, loadCompanies, loadContactsById, type MergeDeps } from './data.js';

type Result = { result: unknown; message: string };
type H = (a: Record<string, any>, ctx: CallerContext) => Promise<Result>;
const who = (ctx: CallerContext) => ctx.requestingUserEmail ?? (ctx.source !== 'unknown' ? ctx.source : null);
const ids = (v: unknown): number[] => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);

export function mergeToolHandlers(s: AutotaskService, getPool: () => Pool | null): Array<[string, H]> {
  const deps = async (): Promise<MergeDeps> => {
    const http = await s.httpClient();
    const fieldCache = new Map<string, Promise<Array<{ name: string; isReadOnly: boolean }> | null>>();
    const fields = (entity: string) => { if (!fieldCache.has(entity)) fieldCache.set(entity, s.getFieldInfo(entity).catch(() => null)); return fieldCache.get(entity)!; };
    return {
      q: (entity, filters, opts) => http.query(entity, filters as never, opts),
      link: (kind, id) => s.getRecordWebUrl(kind, id),
      resourceNames: (rids) => s.getResourceNames(rids),
      writable: async (entity, field) => { const f = (await fields(entity))?.find((x) => x.name === field); return f ? !f.isReadOnly : null; },
      fieldNames: async (entity) => { const f = await fields(entity); return f ? new Set(f.map((x) => x.name)) : null; },
    };
  };
  const entityOf = (a: Record<string, any>): MergeEntity | null => (a.entityType === 'company' || a.entityType === 'contact' ? a.entityType : null);

  /** Load and check every id of a plan: it exists (as THIS entity), the survivor is real and active. */
  const loadRecords = async (d: MergeDeps, entity: MergeEntity, all: number[]): Promise<Map<number, MergeRecord>> => {
    if (entity === 'company') {
      const rows = await loadCompanies(d, all);
      const creators = await d.resourceNames([...new Set(rows.map((c) => Number(c.createdByResourceID)).filter(Number.isFinite))]).catch(() => new Map<number, string>());
      return new Map(rows.map((c) => [Number(c.id), companyRecord(d, c, creators)]));
    }
    const rows = await loadContactsById(d, all);
    const cos = await loadCompanies(d, [...new Set(rows.map((c) => Number(c.companyID)).filter(Number.isFinite))]);
    const names = new Map(cos.map((c) => [Number(c.id), String(c.companyName ?? '')]));
    return new Map(rows.map((c) => [Number(c.id), contactRecord(d, c, names)]));
  };

  return [
    ['autotask_merge_discover', async (a) => {
      const companyIds = ids(a.companyIds), contactIds = ids(a.contactIds);
      if (!a.email && !a.name && !companyIds.length && !contactIds.length) return { result: { status: 'invalid_value' }, message: 'Give email, name, companyIds or contactIds.' };
      const r = await discover(await deps(), { ...(a.email ? { email: String(a.email) } : {}), ...(a.name ? { name: String(a.name) } : {}), companyIds, contactIds, includeInactive: a.includeInactive !== false, ...(a.limit ? { limit: Number(a.limit) } : {}) }) as { totals: Record<string, number>; created: { first: string | null; latest: string | null }; capped: boolean };
      const t = r.totals;
      return { result: r, message: `READ-ONLY. ${t.contacts} contact(s) (${t.activeContacts} active, ${t.placeholderContacts} placeholder) on ${t.companies} compan(ies) (${t.activeCompanies} active, ${t.placeholderCompanies} placeholder)${r.created.first ? `, created ${r.created.first.slice(0, 10)} – ${r.created.latest?.slice(0, 10)}` : ''}.${r.capped ? ' A query hit the read cap — narrow it.' : ''} Survivor hints are for a person to decide; nothing is chosen.` };
    }],

    ['autotask_merge_dependency_inventory', async (a) => {
      const companyIds = ids(a.companyIds), contactIds = ids(a.contactIds);
      if (!companyIds.length && !contactIds.length) return { result: { status: 'invalid_value' }, message: 'Give companyIds and / or contactIds (Autotask ID numbers).' };
      if (companyIds.length + contactIds.length > 500) return { result: { status: 'invalid_value' }, message: 'At most 500 ids per call.' };
      const d = await deps();
      const companies = companyIds.length ? [...(await inventory(d, 'company', companyIds)).values()] : [];
      const contacts = contactIds.length ? [...(await inventory(d, 'contact', contactIds)).values()] : [];
      const blocked = [...companies, ...contacts].filter((x) => x.blockers.length).length;
      return { result: { companies, contacts }, message: `READ-ONLY. ${companies.length} compan(ies), ${contacts.length} contact(s) inventoried; ${blocked} need a decision before merging (see blockers).` };
    }],

    ['autotask_merge_build_plan', async (a, ctx) => {
      const p = getPool(); if (!p) return { result: { status: 'unavailable' }, message: 'Needs the Postgres store (plans are kept there).' };
      const entity = entityOf(a);
      if (!entity) return { result: { status: 'invalid_value', field: 'entityType' }, message: 'entityType: "company" or "contact" — one kind per plan; a company merge never merges contacts.' };
      for (const legacy of ['duplicateCompanyIds', 'duplicateContactIds', 'name', 'email', 'companyName']) if (a[legacy] != null) return { result: { status: 'invalid_value', field: legacy }, message: `${legacy} is not accepted — merges are addressed only by numeric ids (${entity === 'company' ? 'survivorCompanyId + sourceCompanyIds' : 'survivorContactId + sourceContactIds'}), or a csv / mappings of old id → correct id.` };
      if (entity === 'company' && (a.survivorContactId != null || a.sourceContactIds != null)) return { result: { status: 'invalid_value' }, message: 'A company plan takes company ids only (survivorCompanyId, sourceCompanyIds).' };
      if (entity === 'contact' && (a.survivorCompanyId != null || a.sourceCompanyIds != null)) return { result: { status: 'invalid_value' }, message: 'A contact plan takes contact ids only (survivorContactId, sourceContactIds).' };
      if (a.mode != null && a.mode !== 'native_ui') return { result: { status: 'not_available', field: 'mode' }, message: 'Only mode "native_ui" (Autotask’s own merge, then delete in Admin) for now. API consolidation comes later, and only for placeholder records with no history.' };

      let groups: MergeGroup[];
      if (a.csv != null || a.mappings != null) {
        const m = parseMergeMappings(entity, { csv: a.csv, mappings: a.mappings });
        if (!m.ok) return { result: { status: 'invalid_value', errors: m.errors }, message: `Nothing built — ${m.errors.length} problem(s): ${m.errors.slice(0, 8).join(' | ')}${m.errors.length > 8 ? ' …' : ''}` };
        groups = m.groups;
      } else {
        const v = validateMergeIds(entity, entity === 'company' ? a.survivorCompanyId : a.survivorContactId, entity === 'company' ? a.sourceCompanyIds : a.sourceContactIds);
        if (!v.ok) return { result: { status: 'invalid_value' }, message: v.error };
        groups = [{ survivor: v.survivor, sources: v.sources }];
      }
      const all = [...new Set(groups.flatMap((g) => [g.survivor, ...g.sources]))];
      const d = await deps();
      const recs = await loadRecords(d, entity, all);
      const missing = all.filter((id) => !recs.has(id));
      if (missing.length) return { result: { status: 'not_found', missing }, message: `Nothing built — not found as ${entity === 'company' ? 'Companies' : 'Contacts'} in Autotask: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ' …' : ''}. Check the ids (a ${entity} id, not a ${entity === 'company' ? 'contact' : 'company'} id).` };
      const bad: string[] = [];
      for (const g of groups) {
        const sv = recs.get(g.survivor)!;
        if (sv.placeholder) bad.push(`survivor #${sv.id} "${sv.name}" is a placeholder (${sv.placeholder}) — choose a real ${entity} to keep`);
        if (!sv.isActive && a.allowInactiveSurvivor !== true) bad.push(`survivor #${sv.id} "${sv.name}" is INACTIVE — reactivate it first or pass allowInactiveSurvivor: true`);
      }
      if (bad.length) return { result: { status: 'refused', problems: bad }, message: `Nothing built: ${bad.slice(0, 6).join(' | ')}` };

      const inv = await inventory(d, entity, all);
      const rows = [];
      for (const g of groups) rows.push(...buildMergeRows(entity, recs.get(g.survivor)!, g.sources.map((id) => recs.get(id)!), inv, { billingReviewed: a.billingReviewed === true, firstRowNo: rows.length + 1 }));
      const store = new PlanStore(p);
      const plan = await store.create({ kind: MERGE_PLAN_KINDS[entity], title: `Merge ${entity === 'company' ? 'companies' : 'contacts'}: ${groups.reduce((t, g) => t + g.sources.length, 0)} into ${groups.length} survivor(s)`,
        params: { entity, mode: 'native_ui', groups, billingReviewed: a.billingReviewed === true, snapshot: Object.fromEntries(all.map((id) => [id, { name: recs.get(id)!.name, isActive: recs.get(id)!.isActive, attached: inv.get(id)?.total ?? 0 }])) }, rows, by: who(ctx), supersedeKind: false });
      const blocked = plan.rows.filter((r) => r.blocked && r.action === 'manual').length;
      const table = groups.map((g) => ({ survivor: { id: g.survivor, name: recs.get(g.survivor)!.name, link: recs.get(g.survivor)!.link, attached: inv.get(g.survivor)?.total ?? 0 },
        sources: g.sources.map((id) => ({ id, name: recs.get(id)!.name, isActive: recs.get(id)!.isActive, placeholder: recs.get(id)!.placeholder, attached: inv.get(id)?.total ?? 0, blockers: inv.get(id)?.blockers ?? [], link: recs.get(id)!.link })) }));
      return { result: { ...planView(plan), groups: table },
        message: `Plan ${plan.id} (hash ${plan.hash}): ${groups.reduce((t, g) => t + g.sources.length, 0)} ${entity}(s) into ${groups.length} survivor(s) — a work list of Autotask UI steps (merge, then delete in Admin) with links. ${blocked ? `${blocked} merge step(s) BLOCKED (active contracts → billing review). ` : ''}Nothing is written by the MCP. Review it with the person, do the steps in Autotask, then autotask_merge_verify { planId }.` };
    }],

    ['autotask_merge_verify', async (a) => {
      const p = getPool(); if (!p) return { result: { status: 'unavailable' }, message: 'Needs the Postgres store.' };
      const store = new PlanStore(p);
      const plan = a.planId ? await store.get(String(a.planId)) : null;
      if (!plan || !plan.kind.startsWith('merge_')) return { result: { status: 'not_found' }, message: `No merge plan ${a.planId ?? ''}.` };
      const params = plan.params as { entity: MergeEntity; groups: MergeGroup[] };
      const d = await deps();
      const all = [...new Set(params.groups.flatMap((g) => [g.survivor, ...g.sources]))];
      const recs = await loadRecords(d, params.entity, all);
      const stillThere = all.filter((id) => recs.has(id) && params.groups.some((g) => g.sources.includes(id)));
      const inv: Map<number, RecordInventory> = stillThere.length ? await inventory(d, params.entity, stillThere) : new Map();
      const results = [];
      for (const g of params.groups) {
        const sv = recs.get(g.survivor);
        const res = evaluateMerge({
          survivor: { exists: !!sv, isActive: !!sv?.isActive },
          sources: g.sources.map((id) => {
            const r = recs.get(id);
            const state: SourceState = !r ? 'gone' : r.isActive ? 'active' : 'inactive';
            const i = inv.get(id);
            // A contact or company on a source still pointing at it counts; the source's own contacts list is a remnant too.
            return { id, state, remaining: i?.total ?? 0, remainingByLabel: Object.fromEntries((i?.refs ?? []).filter((x) => x.count).map((x) => [x.label, x.count])) };
          }),
        });
        results.push({ survivorId: g.survivor, survivor: sv?.name ?? null, ...res });
        // Mark the plan's steps: merge done when nothing is left on the source; delete done when it is gone.
        for (const row of plan.rows) {
          const m = row.meta as { step?: string; sourceId?: number } | null;
          if (!m?.sourceId || !g.sources.includes(m.sourceId) || row.status === 'applied') continue;
          const gone = res.done.includes(m.sourceId), empty = gone || res.mergedNotDeleted.includes(m.sourceId);
          if ((m.step === 'merge' && empty) || (m.step === 'delete' && gone)) await store.setRowResult(plan.id, row.rowNo, 'applied', { verifiedAt: new Date().toISOString(), state: gone ? 'gone' : 'empty' });
        }
      }
      const status = results.some((r) => r.status === 'failed') ? 'failed' : results.every((r) => r.status === 'passed') ? 'passed' : results.some((r) => r.status !== 'not_started') ? 'partial' : 'not_started';
      if (status === 'passed') await store.setStatus(plan.id, 'done');
      const done = results.reduce((t, r) => t + r.done.length, 0), total = params.groups.reduce((t, g) => t + g.sources.length, 0);
      return { result: { planId: plan.id, status, groups: results }, message: `Merge plan ${plan.id}: ${status.toUpperCase()} — ${done} of ${total} source(s) merged and deleted.${results.flatMap((r) => r.notes).slice(0, 4).map((n) => ` ${n}`).join('')}` };
    }],
  ];
}
