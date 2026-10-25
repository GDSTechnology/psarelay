// Tools: contract line moves (duplicates → the standard service; any line →
// another service), contract-line invoice wording, undo of an executed plan,
// and the vendor monitor. Building plans never writes to Autotask; rows are
// approved with autotask_change_plan_review and applied with
// autotask_change_plan_execute like every other plan.

import type { Pool } from 'pg';
import type { AutotaskService } from '../services/autotask.service.js';
import type { CallerContext } from '../types/context.js';
import { VendorStore } from './store.js';
import { PlanStore, parseRows, type PlanRowInput } from '../change-plans/store.js';
import { buildRevertRows } from '../change-plans/revert.js';
import { createEntityIO, planView } from './catalog-tools.js';
import { moveRows, type MoveSpec } from './contract-plan.js';
import { inChunks, inEffect, lastPostedFrom, loadContractContext, unitsBefore } from './contract-context.js';
import { runVendorMonitor } from './monitor.js';
import type { QueryFn } from './contract-io.js';

type Result = { result: unknown; message: string };
type H = (a: Record<string, any>, ctx: CallerContext) => Promise<Result>;
const who = (ctx: CallerContext) => ctx.requestingUserEmail ?? (ctx.source !== 'unknown' ? ctx.source : null);
const unavailable: Result = { result: { status: 'unavailable' }, message: 'Needs the Postgres store (MCP_PG_ENABLED=true and migrations 0010–0012).' };
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const nextMonth = () => { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1)).toISOString().slice(0, 10); };
const dateArg = (v: unknown) => (v ? String(v).slice(0, 10) : nextMonth());
const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
/** Per-unit amounts between a monthly (2) and a yearly (5) service. */
const convert = (v: number | null, fromPeriod: number | null, toPeriod: number | null) => (v == null ? null : fromPeriod === toPeriod || fromPeriod == null || toPeriod == null ? v : fromPeriod === 5 && toPeriod !== 5 ? r4(v / 12) : toPeriod === 5 && fromPeriod !== 5 ? r4(v * 12) : v);

type Svc = { id: number; name: string; periodType: number | null; invoiceDescription: string | null; isActive?: boolean };
async function servicesById(q: QueryFn, ids: number[]): Promise<Map<number, Svc>> {
  const rows = await inChunks<Record<string, any>>(q, 'Services', 'id', ids, [], ['id', 'name', 'periodType', 'invoiceDescription', 'isActive']);
  return new Map(rows.map((x) => [Number(x.id), { id: Number(x.id), name: String(x.name ?? ''), periodType: x.periodType == null ? null : Number(x.periodType), invoiceDescription: x.invoiceDescription ?? null, isActive: x.isActive }]));
}
async function companyNames(q: QueryFn, ids: number[]): Promise<Map<number, string>> {
  const rows = await inChunks<{ id: number; companyName: string }>(q, 'Companies', 'id', ids, [], ['id', 'companyName']);
  return new Map(rows.map((c) => [Number(c.id), String(c.companyName)]));
}

/**
 * Move contract lines onto another service: for each line, add (or top up) the
 * target service on the same contract, then end the old line — the second row
 * runs only after the first is in.
 */
export async function buildMoveRows(q: QueryFn, moves: Array<{ lineId: number; toServiceId: number; why: string }>, effectiveDate: string): Promise<{ rows: PlanRowInput[]; summary: Record<string, number> }> {
  const lineRows = await inChunks<Record<string, any>>(q, 'ContractServices', 'id', moves.map((m) => m.lineId), [], ['id', 'contractID', 'serviceID', 'unitCost']);
  const lines = new Map(lineRows.map((l) => [Number(l.id), { id: Number(l.id), contractID: Number(l.contractID), serviceID: Number(l.serviceID), unitCost: l.unitCost == null ? null : Number(l.unitCost) }]));
  const ctx = await loadContractContext(q, { contractIds: [...new Set([...lines.values()].map((l) => l.contractID))] });
  const svcs = await servicesById(q, [...new Set([...moves.map((m) => m.toServiceId), ...[...lines.values()].map((l) => l.serviceID)])]);
  const names = await companyNames(q, [...new Set([...ctx.contracts.values()].map((c) => c.companyID))]);
  const units = await unitsBefore(q, [...lines.keys()], effectiveDate);
  const posted = await lastPostedFrom(q, [...lines.keys()], [], effectiveDate);
  const rows: PlanRowInput[] = [];
  const sum = { moves: 0, blocked: 0, nothing_to_move: 0, not_found: 0 };
  for (const m of moves) {
    const l = lines.get(m.lineId);
    const c = l ? ctx.contracts.get(l.contractID) : undefined;
    const from = l ? svcs.get(l.serviceID) : undefined, to = svcs.get(m.toServiceId);
    if (!l || !c || !to) { sum.not_found++; rows.push({ action: 'info', entity: 'ContractServices', targetId: m.lineId, label: `MOVE line #${m.lineId}`, before: null, after: null, reason: m.why, blocked: !l ? 'contract line not found' : !c ? 'not on an active contract' : `service ${m.toServiceId} not found` }); continue; }
    const u = units.get(l.id);
    const customer = names.get(c.companyID) ?? null;
    if (l.serviceID === m.toServiceId) continue;
    if (!u || u.units <= 0) {
      sum.nothing_to_move++;
      rows.push({ meta: { lineId: l.id }, action: 'info', entity: 'ContractServices', targetId: l.id, label: `MOVE ${customer} / ${c.contractName} / ${from?.name}: no units on ${effectiveDate} — nothing to move`, before: null, after: null, reason: `${m.why} The line bills nothing from ${effectiveDate}, so there is nothing to move.`, blocked: 'no units to move' });
      continue;
    }
    const p = posted.service.get(l.id);
    const blocked = !inEffect(c, effectiveDate) ? `${c.contractName} is not a Recurring Service contract in effect on ${effectiveDate}${c.endDate ? ` (ends ${c.endDate.slice(0, 10)})` : ''}`
      : to.isActive === false ? `${to.name} is inactive` : p && p.slice(0, 10) >= effectiveDate ? `already invoiced through ${p.slice(0, 10)} — pick a later effective date` : null;
    const spec: MoveSpec = {
      contractId: l.contractID, label: m.why.split('.')[0]!, customer, contractName: c.contractName,
      fromLineId: l.id, fromName: from?.name ?? `service ${l.serviceID}`, units: u.units, oldUnitPrice: u.unitPrice,
      toServiceId: to.id, toName: to.name, toLineId: ctx.contractLines.get(l.contractID)?.get(to.id) ?? null, newUnits: u.units,
      unitPrice: convert(u.unitPrice, from?.periodType ?? null, to.periodType), unitCost: convert(l.unitCost, from?.periodType ?? null, to.periodType),
      effectiveDate, blocked, reason: `${m.why} Same units and price on the new line; the customer's bill does not change.`, meta: { lineId: l.id, toServiceId: to.id },
    };
    rows.push(...moveRows(spec, rows.length + 1));
    sum.moves++; if (blocked) sum.blocked++;
  }
  return { rows, summary: sum };
}

export function contractToolHandlers(s: AutotaskService, getPool: () => Pool | null): Array<[string, H]> {
  const stores = () => { const p = getPool(); return p ? { pool: p, vendor: new VendorStore(p), plans: new PlanStore(p) } : null; };
  const query = async (): Promise<QueryFn> => (await createEntityIO(s)).query;

  return [
    ['autotask_contract_plan_move_lines', async (a, ctx) => {
      const st = stores(); if (!st) return unavailable;
      const effectiveDate = dateArg(a.effectiveDate);
      if (!isDate(effectiveDate)) return { result: { status: 'invalid_value', field: 'effectiveDate' }, message: 'effectiveDate: YYYY-MM-DD.' };
      const q = await query();
      const source = String(a.source ?? (Array.isArray(a.lines) && a.lines.length ? 'lines' : 'duplicates'));
      let moves: Array<{ lineId: number; toServiceId: number; why: string }>;
      const notes: string[] = [];
      if (source === 'lines') {
        const items = Array.isArray(a.lines) ? a.lines : [];
        moves = items.map((x: any) => ({ lineId: Number(x.contractServiceId), toServiceId: Number(x.toServiceId), why: String(x.reason ?? 'Requested move.') })).filter((m) => Number.isInteger(m.lineId) && Number.isInteger(m.toServiceId));
        if (!moves.length) return { result: { status: 'invalid_value', field: 'lines' }, message: 'lines: [{ contractServiceId, toServiceId, reason? }].' };
      } else if (source === 'duplicates') {
        // Lines on a service that duplicates the STANDARD service for its product + term.
        const links = (await st.vendor.catalogLinks()).filter((l) => l.autotaskEntity === 'Services' && (!Array.isArray(a.offeringIds) || !a.offeringIds.length || a.offeringIds.map(Number).includes(l.offeringId)));
        // Nothing linked yet means "unknown", not "no duplicates" — say what to do first.
        if (!links.length) return { result: { status: 'no_links' }, message: 'No Autotask services are linked to vendor products yet, so duplicates can’t be found. Link them first: autotask_reconcile_resolve_mapping kind=catalog (propose, then accept), then run the catalog plan (autotask_catalog_plan_standardize).' };
        const offerings = new Map((await st.vendor.offerings()).map((o) => [o.id, o]));
        const groups = new Map<string, typeof links>();
        for (const l of links) { const k = `${l.offeringId}|${l.cadence}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(l); }
        const dupOf = new Map<number, { std: number; label: string }>();
        for (const [k, g] of groups) {
          const std = g.find((l) => l.method === 'standardized');
          const o = offerings.get(Number(k.split('|')[0]));
          if (!std) { if (g.length > 1) notes.push(`${o?.name ?? k} ${k.split('|')[1]}: no standard service yet — run the catalog plan first`); continue; }
          for (const l of g) if (l.autotaskId !== std.autotaskId) dupOf.set(l.autotaskId, { std: std.autotaskId, label: `${o?.name ?? 'product'} ${std.cadence}` });
        }
        if (!links.some((l) => l.method === 'standardized')) return { result: { status: 'no_standard', notes }, message: 'No standard services yet: run the catalog plan first (autotask_catalog_plan_standardize, approve, execute). It picks the one service per product and term that duplicates are moved onto.' };
        if (!dupOf.size) return { result: { notes }, message: `No duplicate services with contract lines to move.${notes.length ? ` ${notes.join('; ')}.` : ''}` };
        const lines = await inChunks<{ id: number; contractID: number; serviceID: number }>(q, 'ContractServices', 'serviceID', [...dupOf.keys()], [], ['id', 'contractID', 'serviceID']);
        const active = new Set((await inChunks<{ id: number }>(q, 'Contracts', 'id', lines.map((l) => Number(l.contractID)), [{ op: 'eq', field: 'status', value: 1 }], ['id'])).map((c) => Number(c.id)));
        moves = lines.filter((l) => active.has(Number(l.contractID))).map((l) => { const d = dupOf.get(Number(l.serviceID))!; return { lineId: Number(l.id), toServiceId: d.std, why: `Duplicate service for ${d.label} → the standard service.` }; });
        if (!moves.length) return { result: { notes }, message: 'The duplicate services are not on any active contract — the catalog plan can deactivate them now.' };
      } else return { result: { status: 'invalid_value', field: 'source' }, message: 'source: duplicates | lines.' };
      const built = await buildMoveRows(q, moves, effectiveDate);
      if (!built.rows.length) return { result: { summary: built.summary, notes }, message: 'Nothing to move.' };
      const plan = await st.plans.create({ kind: 'contract_moves', title: `Move contract lines (${source}, effective ${effectiveDate})`, params: { source, effectiveDate, summary: built.summary, notes }, rows: built.rows, by: who(ctx) });
      const sm = built.summary;
      return { result: { ...planView(plan), summary: sm, notes }, message: `Plan ${plan.id} (hash ${plan.hash}), effective ${effectiveDate}: ${sm.moves} line move(s) (2 rows each: add the new line, then end the old one)${sm.blocked ? `, ${sm.blocked} blocked` : ''}${sm.nothing_to_move ? `, ${sm.nothing_to_move} line(s) with no units` : ''}. Customer prices and units stay the same. Nothing written — approve rows (both rows of a move), then autotask_change_plan_execute. Then rebuild the catalog plan to deactivate the emptied duplicates.${notes.length ? ` Note: ${notes.join('; ')}.` : ''}` };
    }],

    ['autotask_contract_plan_wording', async (a, ctx) => {
      const st = stores(); if (!st) return unavailable;
      const q = await query();
      const match = a.match ? String(a.match).toLowerCase() : null;
      const links = (await st.vendor.catalogLinks()).filter((l) => l.autotaskEntity === 'Services' && (!Array.isArray(a.offeringIds) || !a.offeringIds.length || a.offeringIds.map(Number).includes(l.offeringId)));
      const svcIds = [...new Set(links.map((l) => l.autotaskId))];
      if (!svcIds.length) return { result: { status: 'no_links' }, message: 'No services are linked to vendor products yet (catalog plan / resolve_mapping kind=catalog).' };
      const svcs = await servicesById(q, svcIds);
      const lines = await inChunks<Record<string, any>>(q, 'ContractServices', 'serviceID', svcIds, [], ['id', 'contractID', 'serviceID', 'invoiceDescription']);
      const bundleIds = a.includeBundles === false ? [] : [...new Set((await inChunks<{ serviceBundleID: number }>(q, 'ServiceBundleServices', 'serviceID', svcIds, [], ['id', 'serviceBundleID', 'serviceID'])).map((x) => Number(x.serviceBundleID)))];
      const bundles = new Map((await inChunks<Record<string, any>>(q, 'ServiceBundles', 'id', bundleIds, [], ['id', 'name', 'invoiceDescription'])).map((b) => [Number(b.id), { name: String(b.name ?? ''), invoiceDescription: b.invoiceDescription ?? null }]));
      const bundleLines = await inChunks<Record<string, any>>(q, 'ContractServiceBundles', 'serviceBundleID', bundleIds, [], ['id', 'contractID', 'serviceBundleID', 'invoiceDescription']);
      const contractRows = await inChunks<Record<string, any>>(q, 'Contracts', 'id', [...lines, ...bundleLines].map((l) => Number(l.contractID)), [{ op: 'eq', field: 'status', value: 1 }], ['id', 'companyID', 'contractName']);
      const contracts = new Map(contractRows.map((c) => [Number(c.id), { name: String(c.contractName ?? ''), companyID: Number(c.companyID) }]));
      const names = await companyNames(q, [...new Set([...contracts.values()].map((c) => c.companyID))]);
      const rows: PlanRowInput[] = [];
      const consider = (entity: string, id: number, contractID: number, current: string | null, want: string, what: string) => {
        const c = contracts.get(contractID); if (!c) return;
        const cur = (current ?? '').trim(), w = want.trim().slice(0, 1000);
        if (!cur || !w || cur === w) return; // empty = Autotask uses the catalog wording already
        if (match && !cur.toLowerCase().includes(match)) return;
        rows.push({ meta: { contractID }, action: 'update', entity, targetId: id, label: `WORDING ${names.get(c.companyID) ?? c.companyID} / ${c.name} / ${what}: "${cur.slice(0, 80)}" → "${w.slice(0, 80)}"`, before: { invoiceDescription: current }, after: { invoiceDescription: w }, reason: `The contract line keeps the invoice text it had when it was added; the ${entity === 'ContractServices' ? 'service' : 'bundle'} now reads "${w.slice(0, 120)}". Exclude rows where the customer-specific wording is intended.`, blocked: null });
      };
      for (const l of lines) { const sv = svcs.get(Number(l.serviceID)); if (sv) consider('ContractServices', Number(l.id), Number(l.contractID), l.invoiceDescription ?? null, sv.invoiceDescription || sv.name, sv.name); }
      for (const l of bundleLines) { const b = bundles.get(Number(l.serviceBundleID)); if (b) consider('ContractServiceBundles', Number(l.id), Number(l.contractID), l.invoiceDescription ?? null, b.invoiceDescription || b.name, `bundle ${b.name}`); }
      if (!rows.length) return { result: { checked: lines.length + bundleLines.length }, message: `${lines.length + bundleLines.length} contract line(s) checked — every invoice text already matches the catalog${match ? ` (or doesn't mention "${a.match}")` : ''}.` };
      const plan = await st.plans.create({ kind: 'contract_wording', title: `Contract invoice wording${match ? ` (lines mentioning "${a.match}")` : ''}`, params: { match: a.match ?? null }, rows, by: who(ctx) });
      return { result: { ...planView(plan) }, message: `Plan ${plan.id} (hash ${plan.hash}): ${rows.length} contract line(s) whose invoice text differs from the catalog (of ${lines.length + bundleLines.length} checked). Text only — no price or quantity changes. Exclude intended customer wording, approve the rest, then autotask_change_plan_execute.` };
    }],

    ['autotask_change_plan_revert', async (a, ctx) => {
      const st = stores(); if (!st) return unavailable;
      const plan = a.planId ? await st.plans.get(String(a.planId)) : null;
      if (!plan) return { result: { status: 'not_found' }, message: `No plan ${a.planId ?? ''}.` };
      if (!plan.rows.some((r) => r.status === 'applied')) return { result: { status: 'nothing_applied' }, message: 'Nothing in this plan was applied — nothing to undo.' };
      const effectiveDate = dateArg(a.effectiveDate);
      if (!isDate(effectiveDate)) return { result: { status: 'invalid_value', field: 'effectiveDate' }, message: 'effectiveDate: YYYY-MM-DD.' };
      const rowNos = a.rows != null ? parseRows(a.rows, plan.rows.length) ?? [] : undefined;
      const { rows, skipped } = buildRevertRows(plan, { effectiveDate, ...(rowNos ? { rowNos } : {}) });
      if (!rows.length) return { result: { skipped }, message: `Nothing to undo automatically: ${skipped.map((x) => `row ${x.row} ${x.why}`).join('; ')}.` };
      const rev = await st.plans.create({ kind: 'revert', title: `Undo plan ${plan.id} (${plan.title.slice(0, 80)})`, params: { revertsPlan: plan.id, effectiveDate, skipped }, rows, by: who(ctx), supersedeKind: false });
      return { result: { ...planView(rev), skipped }, message: `Undo plan ${rev.id} (hash ${rev.hash}): ${rows.length} row(s) putting back what plan ${plan.id} changed (contract lines from ${effectiveDate}; periods already invoiced stay invoiced).${skipped.length ? ` ${skipped.length} row(s) can't be undone automatically.` : ''} Nothing written — approve, then autotask_change_plan_execute.` };
    }],

    ['autotask_vendor_monitor', async (a) => {
      const st = stores(); if (!st) return unavailable;
      const r = await runVendorMonitor(s, st.pool, { drift: a.drift !== false });
      return { result: r, message: `Monitor: ${r.staleImports.length} vendor(s) with no recent invoice, ${r.renewals.length} subscription(s) renewing within 30 days, ${r.contractsEnding.length} contract(s) ending within 45 days, ${r.drift ? `${r.drift.findings.length} drifted change(s) (${r.drift.new} new)` : 'drift not checked'}, ${r.overdue.length} exception(s) past due, ${r.noticesDue.length} customer notice(s) due. ${r.events} notification(s) sent (each finding once).` };
    }],
  ];
}
