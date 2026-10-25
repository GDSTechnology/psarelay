// Tools: vendor price reference, catalog standardization plans, and the generic
// change-plan review / execute path. Building and reviewing never write to
// Autotask; only autotask_change_plan_execute does — approved rows only,
// FINANCIAL (confirm:true), re-reading every target before writing.

import type { Pool } from 'pg';
import type { AutotaskService } from '../services/autotask.service.js';
import type { CallerContext } from '../types/context.js';
import { VendorStore } from './store.js';
import { PriceStore, perOf, pricesFromInvoices } from './prices.js';
import { buildStandardizePlan, type AutotaskServiceRow } from './catalog-standard.js';
import { PlanStore, parseRows, type Plan } from '../change-plans/store.js';
import { PolicyStore } from './policy.js';
import { NoticeStore, rowsAwaitingNotice } from './notices.js';
import { executePlan, type EntityIO } from '../change-plans/execute.js';
import { inChunks } from './contract-context.js';
import { ADJUSTMENTS, adjustmentAlreadyApplied, adjustmentReadBack, adjustmentSnapshot, unitsOn, type LineKind, type QueryFn, type UnitPeriod } from './contract-io.js';

type Result = { result: unknown; message: string };
type H = (a: Record<string, any>, ctx: CallerContext) => Promise<Result>;
const who = (ctx: CallerContext) => ctx.requestingUserEmail ?? (ctx.source !== 'unknown' ? ctx.source : null);
const unavailable: Result = { result: { status: 'unavailable' }, message: 'Needs the Postgres store (MCP_PG_ENABLED=true and migrations 0010 + 0011).' };
const CADENCES = ['MM', 'AM', 'AA', 'monthly', 'annual'];

/** A plan as chat shows it: numbered rows, what each does, and whether it can be approved. */
export function planView(p: Plan, opts: { rows?: 'all' | 'actionable' } = {}): Record<string, unknown> {
  const rows = p.rows.filter((r) => opts.rows !== 'actionable' || (!r.blocked && r.action !== 'info'));
  const counts: Record<string, number> = {};
  for (const r of p.rows) counts[r.blocked ? 'blocked' : r.status] = (counts[r.blocked ? 'blocked' : r.status] ?? 0) + 1;
  return {
    planId: p.id, hash: p.hash, kind: p.kind, title: p.title, status: p.status, createdBy: p.createdBy, createdAt: p.createdAt, counts,
    rows: rows.map((r) => ({ row: r.rowNo, action: r.action, label: r.label, before: r.before, after: r.after, reason: r.reason, ...(r.blocked ? { blocked: r.blocked } : {}), status: r.status, ...(r.approvedBy ? { approvedBy: r.approvedBy } : {}), ...(r.result ? { result: r.result } : {}) })),
  };
}

/** The fields that identify a record an order created (checked after the create). */
const VERIFY_KEYS: Record<string, string[]> = {
  Companies: ['companyName'], Contacts: ['companyID', 'firstName', 'lastName'], Contracts: ['companyID', 'contractName', 'startDate', 'endDate'],
  Tickets: ['companyID', 'title', 'queueID'], TicketCharges: ['ticketID', 'name', 'unitQuantity', 'unitPrice'],
};

/** Autotask reads / writes the change-plan executor and the drift check use. */
export async function createEntityIO(s: AutotaskService): Promise<EntityIO & { unitsOn(lineId: number, date: string, kind?: LineKind): Promise<UnitPeriod | null>; query: QueryFn }> {
    const http = await s.httpClient();
    const query: QueryFn = (entity, filters, opts) => http.query(entity, filters as never, opts);
    const byId = async (entity: string, id: number) => {
      const got = await http.get<Record<string, unknown>>(entity, id).catch(() => null);
      if (got) return got;
      // Some entities are query-only.
      return (await http.query<Record<string, unknown>>(entity, [{ op: 'eq', field: 'id', value: id }], { maxRecords: 1, noCache: true }))[0] ?? null;
    };
    return {
      query,
      unitsOn: (lineId, date, kind = 'service') => unitsOn(query, kind, lineId, date),
      get: byId,
      update: async (entity, id, fields) => { await http.update(entity, id, fields); },
      // A contract charge is created under its contract (POST /Contracts/{id}/Charges).
      // An adjustment's create answers without an itemId (verified live): it is verified by its effect, so 0 = "no id".
      create: async (entity, fields) => (entity === 'ContractCharges' ? http.childCreate('Contracts', Number(fields.contractID), 'Charges', fields)
        : ADJUSTMENTS[entity] ? (await http.createWithoutId(entity, fields)).id ?? 0
        // Orders (commerce): the typed paths — company name guards + default owner, the contacts' child route,
        // ticket defaults, the ticket charges' child route.
        : entity === 'Companies' ? s.createCompany(fields as never)
        : entity === 'Contacts' ? s.createContact(fields as never)
        : entity === 'Tickets' ? s.createTicket(fields as never)
        : entity === 'TicketCharges' ? s.createTicketCharge(fields as never)
        : http.create(entity, fields)),
      findExisting: async (entity, fields, snap, row) => {
        // A re-run must not create the same thing twice.
        if (entity === 'Services' && typeof fields.name === 'string') {
          return (await http.query<{ id: number }>('Services', [{ op: 'eq', field: 'name', value: fields.name }], { maxRecords: 2, includeFields: ['id'], noCache: true }))[0]?.id ?? null;
        }
        // Adjustments can't be queried: "already done" = the line already shows the planned effect.
        if (ADJUSTMENTS[entity]) return adjustmentAlreadyApplied(query, { entity, after: fields, meta: row?.meta ?? null }, snap ?? null);
        // A back-bill charge is unique by contract + name ("… — back-bill Sep 2026 – Oct 2026"): never charge it twice.
        if (entity === 'ContractCharges' && fields.contractID != null && typeof fields.name === 'string') {
          return (await http.query<{ id: number }>('ContractCharges', [{ op: 'eq', field: 'contractID', value: fields.contractID }, { op: 'eq', field: 'name', value: fields.name }], { maxRecords: 2, includeFields: ['id'], noCache: true }))[0]?.id ?? null;
        }
        // Orders: what an earlier, interrupted run of the same plan already created.
        const one = async (e: string, filters: Array<{ op: string; field: string; value: unknown }>) => (await http.query<{ id: number }>(e, filters as never, { maxRecords: 2, includeFields: ['id'], noCache: true }))[0]?.id ?? null;
        if (entity === 'Companies' && typeof fields.companyName === 'string') return one('Companies', [{ op: 'eq', field: 'companyName', value: fields.companyName }]);
        if (entity === 'Contacts' && fields.companyID != null && typeof fields.emailAddress === 'string') return one('Contacts', [{ op: 'eq', field: 'companyID', value: fields.companyID }, { op: 'eq', field: 'emailAddress', value: fields.emailAddress }]);
        if (entity === 'Contracts' && fields.companyID != null && typeof fields.contractName === 'string') return one('Contracts', [{ op: 'eq', field: 'companyID', value: fields.companyID }, { op: 'eq', field: 'contractName', value: fields.contractName }]);
        if (entity === 'Tickets' && fields.companyID != null && typeof fields.title === 'string') return one('Tickets', [{ op: 'eq', field: 'companyID', value: fields.companyID }, { op: 'eq', field: 'title', value: fields.title }, { op: 'noteq', field: 'status', value: 5 }]);
        if (entity === 'TicketCharges' && fields.ticketID != null && typeof fields.name === 'string') return one('TicketCharges', [{ op: 'eq', field: 'ticketID', value: fields.ticketID }, { op: 'eq', field: 'name', value: fields.name }]);
        if (entity === 'ContractServices' && fields.contractID != null && fields.serviceID != null) {
          return (await http.query<{ id: number }>('ContractServices', [{ op: 'eq', field: 'contractID', value: fields.contractID }, { op: 'eq', field: 'serviceID', value: fields.serviceID }], { maxRecords: 2, includeFields: ['id'], noCache: true }))[0]?.id ?? null;
        }
        return null;
      },
      // An adjustment depends on the line's CURRENT units and price (the period before it takes effect).
      snapshot: async (row) => (ADJUSTMENTS[row.entity] ? adjustmentSnapshot(query, row) : null),
      readBack: async (row, id, snap) => {
        if (ADJUSTMENTS[row.entity]) return adjustmentReadBack(query, row, snap);
        // Orders: check the identifying fields only — Autotask normalises others (phone formats, rich-text
        // descriptions), which would read as "not applied" although the record is right.
        const keys = VERIFY_KEYS[row.entity];
        if (!keys) return null;
        const rec = await byId(row.entity, id);
        if (!rec) return { unverifiable: `${row.entity} ${id} not readable yet` };
        const a = row.after ?? {};
        return { record: rec, expect: Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]])) };
      },
    };
}

export function catalogToolHandlers(s: AutotaskService, getPool: () => Pool | null): Array<[string, H]> {
  const stores = () => { const p = getPool(); return p ? { vendor: new VendorStore(p), prices: new PriceStore(p), plans: new PlanStore(p), policy: new PolicyStore(p), notices: new NoticeStore(p) } : null; };
  const io = () => createEntityIO(s);

  return [
    ['autotask_vendor_prices', async (a, ctx) => {
      const st = stores(); if (!st) return unavailable;
      const vendor = String(a.vendor ?? 'pax8');
      const action = String(a.action ?? 'list');
      if (action === 'refresh') {
        const ps = await pricesFromInvoices(st.vendor, vendor);
        const n = await st.prices.upsert(ps.map((p) => ({ ...p, by: who(ctx) })));
        return { result: { recorded: n }, message: `Recorded ${n} price point(s) from ${vendor} invoices (cost + suggested price per SKU and term).` };
      }
      if (action === 'set') {
        const items = Array.isArray(a.items) ? a.items : [];
        const bad = items.filter((i: any) => !i.sku || !CADENCES.includes(i.cadence) || (i.unitCost == null && i.suggestedPrice == null));
        if (!items.length || bad.length) return { result: { status: 'invalid_value', bad }, message: `items: [{ sku, cadence: ${CADENCES.join('|')}, unitCost, suggestedPrice, effectiveDate? }] — MM/AM/monthly per month, AA/annual per year.` };
        const n = await st.prices.upsert(items.map((i: any) => ({ vendor, sku: String(i.sku), cadence: String(i.cadence), unitCost: i.unitCost != null ? Number(i.unitCost) : null, suggestedPrice: i.suggestedPrice != null ? Number(i.suggestedPrice) : null, per: perOf(String(i.cadence)), source: String(i.source ?? 'price_list'), effectiveDate: String(i.effectiveDate ?? new Date().toISOString().slice(0, 10)), by: who(ctx) })));
        return { result: { recorded: n }, message: `Recorded ${n} ${vendor} price point(s).` };
      }
      const cur = await st.prices.current(vendor);
      return { result: cur, message: `${cur.length} current ${vendor} price point(s) (per SKU and term).` };
    }],

    ['autotask_catalog_plan_standardize', async (a, ctx) => {
      const st = stores(); if (!st) return unavailable;
      const vendor = String(a.vendor ?? 'pax8');
      const http = await s.httpClient();
      const [offerings, offeringMappings, links, prices, lines] = await Promise.all([st.vendor.offerings(), st.vendor.offeringMappings(vendor), st.vendor.catalogLinks(), st.prices.current(vendor), st.vendor.lines({ vendor, limit: 20000 })]);
      if (!offerings.length) return { result: { status: 'no_offerings' }, message: 'No offerings yet — map vendor SKUs first (autotask_reconcile_resolve_mapping kind=offerings).' };
      const soldSkus = new Map<string, { cadences: Set<string>; chargeClasses: Set<string> }>();
      for (const l of lines) { if (!l.sku) continue; const e = soldSkus.get(l.sku) ?? { cadences: new Set<string>(), chargeClasses: new Set<string>() }; e.cadences.add(l.cadence); e.chargeClasses.add(l.chargeClass); soldSkus.set(l.sku, e); }
      const services = await http.query<AutotaskServiceRow>('Services', [{ op: 'gte', field: 'id', value: 0 }], { maxRecords: 2000, includeFields: ['id', 'name', 'description', 'invoiceDescription', 'periodType', 'unitCost', 'unitPrice', 'isActive', 'billingCodeID', 'manufacturerServiceProvider'], noCache: true });
      const activeContracts = new Set((await http.query<{ id: number }>('Contracts', [{ op: 'eq', field: 'status', value: 1 }], { maxRecords: 10000, includeFields: ['id'] })).map((c) => c.id));
      const cs = await http.query<{ contractID: number; serviceID: number }>('ContractServices', [{ op: 'gte', field: 'id', value: 0 }], { maxRecords: 20000, includeFields: ['id', 'contractID', 'serviceID'] });
      // "In use" = a line on an active contract that still bills units from today on. A line emptied by a
      // move (units → 0) no longer holds its service, so the duplicate can be deactivated.
      const linked = new Set(links.filter((l) => l.autotaskEntity === 'Services').map((l) => l.autotaskId));
      const linkedLines = cs.filter((x) => activeContracts.has(x.contractID) && linked.has(x.serviceID)) as Array<{ id: number; contractID: number; serviceID: number }>;
      const today = new Date().toISOString().slice(0, 10);
      const billing = new Set((await inChunks<{ contractServiceID: number }>((e, f, o) => http.query(e, f as never, o), 'ContractServiceUnits', 'contractServiceID', linkedLines.map((x) => Number(x.id)), [{ op: 'gte', field: 'endDate', value: `${today}T00:00:00` }, { op: 'gt', field: 'units', value: 0 }], ['id', 'contractServiceID'])).map((u) => Number(u.contractServiceID)));
      const activeUses = new Map<number, number>();
      for (const x of cs as Array<{ id: number; contractID: number; serviceID: number }>) {
        if (!activeContracts.has(x.contractID)) continue;
        if (linked.has(x.serviceID) && !billing.has(Number(x.id))) continue;
        activeUses.set(x.serviceID, (activeUses.get(x.serviceID) ?? 0) + 1);
      }
      const r = buildStandardizePlan({ vendor, offerings, offeringMappings, soldSkus, links, services, activeUses, prices, policies: await st.policy.policies(), ...(Array.isArray(a.offeringIds) && a.offeringIds.length ? { offeringIds: a.offeringIds.map(Number) } : {}) });
      if (!r.rows.length) return { result: { summary: r.summary }, message: 'The catalog already matches the standard — nothing to change.' };
      const plan = await st.plans.create({ kind: 'catalog_standardize', title: `Standardize Autotask services (${vendor}: ${r.summary.products} product(s))`, params: { vendor, summary: r.summary }, rows: r.rows, by: who(ctx) });
      const sm = r.summary;
      return {
        result: { ...planView(plan), summary: sm },
        message: `Plan ${plan.id} (hash ${plan.hash}): ${sm.products} product(s) — rename ${sm.rename}, catalog reprice ${sm.reprice}, create ${sm.create}${sm.blocked ? ` (${sm.blocked} blocked: missing price / work type)` : ''}${sm.skippedTerms ? `, ${sm.skippedTerms} term(s) not offered skipped (no service, no price, not bought)` : ''}, deactivate ${sm.deactivate} unused duplicate(s), ${sm.inUseDuplicates} in-use duplicate(s) kept${sm.inUseDuplicates ? ' (move their contract lines with autotask_contract_plan_move_lines, then rebuild this plan to deactivate them)' : ''}, ${sm.unknownTerm} service(s) with an unstated term. Nothing written. Review the rows, then approve: autotask_change_plan_review action=approve planId hash rows="1-12" (or "all").`,
      };
    }],

    ['autotask_change_plan_review', async (a, ctx) => {
      const st = stores(); if (!st) return unavailable;
      const action = String(a.action ?? (a.planId ? 'get' : 'list'));
      if (action === 'list') { const l = await st.plans.list(Number(a.limit) || 20); return { result: l, message: `${l.length} plan(s).` }; }
      const plan = a.planId ? await st.plans.get(String(a.planId)) : null;
      if (!plan) return { result: { status: 'not_found' }, message: `No plan ${a.planId ?? ''}.` };
      if (action === 'get') return { result: planView(plan, { rows: a.actionableOnly === true ? 'actionable' : 'all' }), message: `${plan.title}: ${plan.rows.length} row(s), status ${plan.status}.` };
      if (action === 'approve' || action === 'exclude') {
        const rows = parseRows(a.rows, plan.rows.length);
        if (!rows || !rows.length) return { result: { status: 'invalid_value', field: 'rows' }, message: 'rows: "all", "3-15", "1,4,7-9" or an array of row numbers.' };
        if (!a.hash) return { result: { status: 'invalid_value', field: 'hash' }, message: `Pass the plan hash you reviewed (${plan.hash}).` };
        const r = await st.plans.setApproval(plan.id, String(a.hash), rows, action === 'approve', who(ctx));
        return { result: r, message: `${action === 'approve' ? 'Approved' : 'Excluded'} ${r.changed.length} row(s)${r.refused.length ? `; ${r.refused.length} not changeable (${r.refused.slice(0, 5).map((x) => `${x.row}: ${x.why}`).join('; ')})` : ''}. Nothing is written until autotask_change_plan_execute.` };
      }
      return { result: { status: 'invalid_value' }, message: 'action: list | get | approve | exclude.' };
    }],

    ['autotask_change_plan_execute', async (a, ctx) => {
      const st = stores(); if (!st) return unavailable;
      const plan = a.planId ? await st.plans.get(String(a.planId)) : null;
      if (!plan) return { result: { status: 'not_found' }, message: `No plan ${a.planId ?? ''}.` };
      if (plan.status !== 'open' && plan.status !== 'executing') return { result: { status: plan.status }, message: `Plan is ${plan.status} — build a new plan.` };
      if (plan.kind.startsWith('merge_')) return { result: { status: 'manual_plan' }, message: 'A merge plan is a work list of Autotask UI steps (merge, then delete in Admin) — nothing here is executed by the MCP. Do the steps in Autotask, then run autotask_merge_verify { planId }.' };
      if (!plan.rows.some((r) => r.status === 'approved')) return { result: { status: 'nothing_approved' }, message: 'No approved rows — approve rows first (autotask_change_plan_review action=approve).' };
      const by = who(ctx);
      let rowNos = a.rows != null ? parseRows(a.rows, plan.rows.length) : undefined;
      if (a.rows != null && !rowNos?.length) return { result: { status: 'invalid_value', field: 'rows' }, message: 'rows: "all", "3", "3-5" or [row numbers] — only these approved rows run (e.g. a one-row pilot).' };
      // Customer-facing contract changes wait until the customer's notice (or a waiver) is recorded.
      const held = plan.kind === 'contract_pricing' ? rowsAwaitingNotice(plan, await st.notices.list(plan.id)).filter((h) => !rowNos || rowNos.includes(h.row)) : [];
      if (held.length) {
        const heldRows = new Set(held.map((h) => h.row));
        rowNos = (rowNos ?? plan.rows.filter((r) => r.status === 'approved').map((r) => r.rowNo)).filter((n) => !heldRows.has(n));
        const who2 = [...new Set(held.map((h) => h.customer ?? String(h.companyId ?? '?')))].slice(0, 8).join(', ');
        if (!rowNos.length) return { result: { status: 'notice_required', held }, message: `Nothing run: ${held.length} approved row(s) change what customers are invoiced and no notice is recorded for ${who2}. Send the notice, then record it: autotask_pricing_customer_notices { action: "mark_sent", planId, companyIds, sentOn, method } (method "waived" when no notice is needed).` };
      }
      const rep = await executePlan(st.plans, plan, await io(), {
        maxRows: Number(a.maxRows) || 25,
        ...(rowNos ? { rowNos } : {}),
        onApplied: async (row, id) => {
          const m = row.meta as { offeringId?: number; term?: string } | null;
          if (plan.kind === 'catalog_standardize' && id != null && m?.offeringId && row.action !== 'deactivate') {
            await st.vendor.setCatalogLinks([{ autotaskEntity: 'Services', autotaskId: id, offeringId: m.offeringId, cadence: m.term ?? '', method: 'standardized', confidence: 'confirmed', note: `plan ${plan.id} row ${row.rowNo}`, decidedBy: by }]);
          }
        },
      });
      const left = (await st.plans.get(plan.id))!.rows.filter((r) => r.status === 'approved').length;
      return { result: { ...rep, ...(held.length ? { heldForNotice: held } : {}) }, message: `${held.length ? `${held.length} row(s) held until the customer notice is recorded (autotask_pricing_customer_notices). ` : ''}Executed ${rep.attempted} row(s): ${rep.applied} applied and verified, ${rep.skipped} already as planned, ${rep.stale} stale (changed since the plan — rebuild), ${rep.failed} failed${rep.waiting ? `, ${rep.waiting} waiting for a row they depend on` : ''}${rep.stoppedBy ? ` — STOPPED: ${rep.stoppedBy}` : ''}.${left ? ` ${left} approved row(s) left — call again.` : ''}${rep.rows.some((r) => r.detail?.includes('not verifiable yet')) ? ' Rows "not verifiable yet" were written; re-check them with autotask_reconcile_check_sync_drift once Autotask shows the new unit period.' : ''}` };
    }],
  ];
}
