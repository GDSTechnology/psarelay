// Tools: reconcile a vendor invoice against customer contracts, work the
// exceptions, set pricing policy, export the workbook, build contract pricing
// change plans, and check for sync drift. Everything here is read-only toward
// Autotask except the plans' execution (autotask_change_plan_execute).

import type { Pool } from 'pg';
import type { AutotaskService } from '../services/autotask.service.js';
import type { CallerContext } from '../types/context.js';
import { VendorStore } from './store.js';
import { PolicyStore, type PolicyMode } from './policy.js';
import { DECIDED_STATUSES, EXCEPTION_STATUSES, ReconStore, type ExceptionStatus } from './recon-store.js';
import { loadReconInput } from './recon-data.js';
import { reconcile, type ReconRow } from './reconcile.js';
import { buildWorkbook } from './workbook.js';
import { buildContractPlan, CHANGE_KINDS, rebaseToEffectiveDate, type ChangeKind } from './contract-plan.js';
import { inChunks, inEffect, lastPostedFrom, loadContractContext, unitsBefore } from './contract-context.js';
import { driftEvent, plansToCheck, PLAN_KINDS_WITH_WRITES } from './monitor.js';
import { DriftStore, checkDrift } from './drift.js';
import { createEntityIO, planView } from './catalog-tools.js';
import { PlanStore } from '../change-plans/store.js';
import { notify } from '../services/notifier.js';

type Result = { result: unknown; message: string };
type H = (a: Record<string, any>, ctx: CallerContext) => Promise<Result>;
const who = (ctx: CallerContext) => ctx.requestingUserEmail ?? (ctx.source !== 'unknown' ? ctx.source : null);
const unavailable: Result = { result: { status: 'unavailable' }, message: 'Needs the Postgres store (MCP_PG_ENABLED=true and migrations 0010–0012).' };
const money = (n: unknown) => (typeof n === 'number' ? `$${n.toFixed(2)}` : '—');

const today = () => new Date().toISOString().slice(0, 10);
/** Still undecided and past its due date. */
export function isOverdue(s: { status: string; dueOn?: string | null }): boolean {
  return !!s.dueOn && s.dueOn < today() && !DECIDED_STATUSES.includes(s.status as ExceptionStatus) && s.status !== 'fix_planned';
}

/** The compact row chat shows: the required columns, then why. */
export function chatRow(r: ReconRow, state?: { status: string; owner: string | null; dueOn?: string | null; reference?: string | null }): Record<string, unknown> {
  return {
    row: r.rowNo, severity: r.severity, exceptions: r.exceptions, customer: r.customerName, contract: r.autotaskContract, vendor: r.vendor, sku: r.serviceSku, offering: r.offering, term: r.cadence,
    unit: r.unit, quantity: r.quantity, contractQuantity: r.contractQuantity, costShouldBe: r.costShouldBe, priceShouldBe: r.priceShouldBe, currentCost: r.currentCost, currentPrice: r.currentPrice,
    differenceOnCost: r.differenceOnCost, differenceOnPrice: r.differenceOnPrice, per: r.basis, billedRate: r.billedRate, billingPosted: r.billingPosted, monthlyExposure: r.monthlyExposure,
    confidence: r.confidence, reason: r.reason, proposedAction: r.proposedAction, exceptionKey: r.exceptionKey, ...(state ? { status: state.status, owner: state.owner, dueOn: state.dueOn ?? null, overdue: isOverdue(state), reference: state.reference ?? null } : {}),
  };
}

export function reconToolHandlers(s: AutotaskService, getPool: () => Pool | null): Array<[string, H]> {
  const stores = () => { const p = getPool(); return p ? { vendor: new VendorStore(p), policy: new PolicyStore(p), recon: new ReconStore(p), plans: new PlanStore(p), drift: new DriftStore(p) } : null; };
  const runOf = async (st: NonNullable<ReturnType<typeof stores>>, a: Record<string, any>) => (a.runId ? st.recon.getRun(String(a.runId)) : st.recon.latestRun(a.vendor ? String(a.vendor) : undefined));

  return [
    ['autotask_reconcile_vendor_to_autotask', async (a, ctx) => {
      const st = stores(); if (!st) return unavailable;
      const vendor = String(a.vendor ?? 'pax8');
      const loaded = await loadReconInput(s, st, { vendor, ...(a.invoiceNumber ? { invoiceNumber: String(a.invoiceNumber) } : {}), ...(a.documentId ? { documentId: Number(a.documentId) } : {}) });
      if ('error' in loaded) return { result: { status: 'not_found' }, message: loaded.error };
      const { rows, summary } = reconcile(loaded.input);
      const inv = loaded.input.invoice;
      const runId = await st.recon.saveRun({ vendor, documentId: inv.documentId, invoiceNumber: inv.invoiceNumber, periodStart: inv.periodStart, periodEnd: inv.periodEnd, params: { autotaskCalls: loaded.calls }, summary, rows, by: who(ctx) });
      const sm = summary as Record<string, number>;
      if (sm.critical) notify({ type: 'reconcile.critical', severity: 'warning', title: `${vendor} reconciliation: ${sm.critical} critical exception(s)`, detail: `Invoice ${inv.invoiceNumber ?? inv.documentId} (${inv.periodStart} – ${inv.periodEnd}): monthly exposure ${money(sm.monthlyExposure)}; ${sm.belowCost} below landed cost (${sm.belowCostConfirmed} confirmed by a posted invoice), ${sm.notBilled} vendor charge(s) not billed back, ${sm.qtyShort} short on quantity.`, fields: { run: runId }, dedupeKey: `reconcile.critical:${inv.documentId}` });
      const limit = Math.min(Math.max(Number(a.limit) || 50, 1), 500);
      const top = rows.filter((r) => a.includeOk === true || (r.severity !== 'ok' && r.severity !== 'info')).slice(0, limit);
      return {
        result: { runId, invoice: inv, summary, rows: top.map((r) => chatRow(r)), totalRows: rows.length, autotaskCalls: loaded.calls },
        message: `Run ${runId} — ${vendor} ${inv.invoiceNumber ?? ''} (${inv.periodStart} – ${inv.periodEnd}): ${sm.critical} critical, ${sm.high} high, ${sm.review} review, ${sm.ok} matching. Monthly exposure ${money(sm.monthlyExposure)} (critical ${money(sm.monthlyExposureCritical)}). ${sm.belowCost} below landed cost (${sm.belowCostConfirmed} confirmed by a posted invoice), ${sm.notBilled} not billed back, ${sm.qtyShort} short on quantity. Nothing was changed. Next: autotask_reconcile_get_exceptions, autotask_reconcile_export_workbook, autotask_pricing_build_change_plan.`,
      };
    }],

    ['autotask_reconcile_get_exceptions', async (a, ctx) => {
      const st = stores(); if (!st) return unavailable;
      const action = String(a.action ?? 'list');
      if (action === 'update') {
        const keys = Array.isArray(a.keys) ? a.keys.map(String) : [];
        if (!keys.length) return { result: { status: 'invalid_value', field: 'keys' }, message: 'keys: the exceptionKey of each row to update.' };
        if (a.status && !(EXCEPTION_STATUSES as readonly string[]).includes(String(a.status))) return { result: { status: 'invalid_value', field: 'status', choices: EXCEPTION_STATUSES }, message: `status: ${EXCEPTION_STATUSES.join(' | ')}. Outcomes: absorbed = GDS carries the cost; billed_elsewhere = billed on another company / contract (give reference); fix_planned = a change plan fixes it (reference = plan id); accepted = an expected variance; resolved = fixed in Autotask.` };
        const status = a.status ? String(a.status) as ExceptionStatus : undefined;
        if ((status === 'billed_elsewhere' || status === 'fix_planned') && !a.reference) return { result: { status: 'invalid_value', field: 'reference' }, message: status === 'billed_elsewhere' ? 'billed_elsewhere needs reference: where it is billed (company / contract / invoice).' : 'fix_planned needs reference: the change plan id.' };
        if (status === 'absorbed' && !a.note) return { result: { status: 'invalid_value', field: 'note' }, message: 'absorbed needs a note: why GDS carries this cost (e.g. "customer out of business, contract ridden out").' };
        const dueOn = a.dueOn === null || a.dueOn === '' ? null : a.dueOn != null ? String(a.dueOn).slice(0, 10) : undefined;
        if (dueOn && !/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) return { result: { status: 'invalid_value', field: 'dueOn' }, message: 'dueOn: YYYY-MM-DD (or null to clear).' };
        const n = await st.recon.updateState(keys, { ...(status ? { status } : {}), ...(a.owner !== undefined ? { owner: a.owner === null ? null : String(a.owner) } : {}), ...(a.note ? { note: String(a.note) } : {}), ...(dueOn !== undefined ? { dueOn } : {}), ...(a.reference !== undefined ? { reference: a.reference === null ? null : String(a.reference) } : {}), by: who(ctx) });
        return { result: { updated: n }, message: `Updated ${n} exception(s)${status ? ` → ${status}` : ''}; the change is added to each one's history.` };
      }
      const run = await runOf(st, a);
      if (!run) return { result: { status: 'not_found' }, message: 'No reconciliation run yet — autotask_reconcile_vendor_to_autotask.' };
      let rows = await st.recon.rows(run.id);
      const sev = Array.isArray(a.severity) && a.severity.length ? a.severity.map(String) : ['critical', 'high', 'review'];
      rows = rows.filter((r) => sev.includes(r.severity));
      if (a.customer) rows = rows.filter((r) => String(r.customerName ?? '').toLowerCase().includes(String(a.customer).toLowerCase()));
      if (a.exceptionType) rows = rows.filter((r) => r.exceptions.includes(String(a.exceptionType)));
      if (a.sku) rows = rows.filter((r) => r.serviceSku === String(a.sku));
      if (a.minExposure != null) rows = rows.filter((r) => (r.monthlyExposure ?? 0) >= Number(a.minExposure));
      const states = await st.recon.states(rows.map((r) => r.exceptionKey));
      const withState = rows.map((r) => ({ r, s: states.get(r.exceptionKey) ?? { status: 'open' as ExceptionStatus, owner: null, dueOn: null, reference: null, history: [] } }));
      let filtered = a.status ? withState.filter((x) => x.s.status === String(a.status)) : withState;
      if (a.owner) filtered = filtered.filter((x) => String(x.s.owner ?? '').toLowerCase() === String(a.owner).toLowerCase());
      if (a.overdue === true) filtered = filtered.filter((x) => isOverdue(x.s));
      if (a.undecided === true) filtered = filtered.filter((x) => !DECIDED_STATUSES.includes(x.s.status) && x.s.status !== 'fix_planned');
      const exposureOf = (f: (s: { status: string }) => boolean) => filtered.filter((x) => f(x.s)).reduce((t, x) => t + (x.r.monthlyExposure ?? 0), 0);
      const byStatus: Record<string, number> = {};
      for (const x of filtered) byStatus[x.s.status] = (byStatus[x.s.status] ?? 0) + 1;
      const limit = Math.min(Math.max(Number(a.limit) || 100, 1), 1000);
      return {
        result: { runId: run.id, invoice: run.invoiceNumber, period: `${run.periodStart} – ${run.periodEnd}`, total: filtered.length, byStatus, overdue: filtered.filter((x) => isOverdue(x.s)).length,
          openExposure: Math.round(exposureOf((s) => !DECIDED_STATUSES.includes(s.status as ExceptionStatus)) * 100) / 100, absorbedExposure: Math.round(exposureOf((s) => s.status === 'absorbed') * 100) / 100, rows: filtered.slice(0, limit).map((x) => ({ ...chatRow(x.r, x.s), history: a.includeHistory === true ? (x.s as { history?: unknown }).history : undefined })) },
        message: `${filtered.length} exception(s) in run ${run.id} (${run.invoiceNumber ?? ''}): open exposure ${money(exposureOf((s) => !DECIDED_STATUSES.includes(s.status as ExceptionStatus)))}/month${exposureOf((s) => s.status === 'absorbed') ? `, absorbed ${money(exposureOf((s) => s.status === 'absorbed'))}/month` : ''}${filtered.some((x) => isOverdue(x.s)) ? `, ${filtered.filter((x) => isOverdue(x.s)).length} OVERDUE` : ''}.`,
      };
    }],

    ['autotask_vendor_pricing_policy', async (a, ctx) => {
      const st = stores(); if (!st) return unavailable;
      const action = String(a.action ?? 'list');
      if (action === 'set') {
        const mode = String(a.mode ?? 'vendor_suggested') as PolicyMode;
        if (!['vendor_suggested', 'margin', 'markup'].includes(mode)) return { result: { status: 'invalid_value', field: 'mode' }, message: 'mode: vendor_suggested | margin | markup.' };
        const pct = a.pct == null ? null : Number(a.pct) > 1 ? Number(a.pct) / 100 : Number(a.pct);
        const floor = a.marginFloor == null ? null : Number(a.marginFloor) > 1 ? Number(a.marginFloor) / 100 : Number(a.marginFloor);
        if ((mode !== 'vendor_suggested' && (pct == null || !Number.isFinite(pct))) || (floor != null && (floor < 0 || floor >= 1))) return { result: { status: 'invalid_value' }, message: 'pct is required for margin / markup (e.g. 20 or 0.2); marginFloor must be 0–<1.' };
        const fee = String(a.feePolicy ?? 'overhead');
        if (!['overhead', 'allocate'].includes(fee)) return { result: { status: 'invalid_value', field: 'feePolicy' }, message: 'feePolicy: overhead | allocate.' };
        await st.policy.setPolicy({ scope: String(a.scope ?? '*'), mode, pct, marginFloor: floor, feePolicy: fee as 'overhead' | 'allocate', note: a.note ? String(a.note) : null, decidedBy: who(ctx) });
        return { result: { saved: true }, message: `Pricing policy for ${a.scope ?? '*'} saved (${mode}${pct != null ? ` ${mode === 'vendor_suggested' ? '+' : ''}${Math.round(pct * 1000) / 10}%` : ''}${floor != null ? `, floor ${Math.round(floor * 100)}%` : ''}, fees ${fee}). It applies from the next reconciliation run.` };
      }
      if (action === 'set_negotiated' || action === 'remove_negotiated') {
        const company = Number(a.companyId), offering = Number(a.offeringId);
        if (!Number.isInteger(company) || !Number.isInteger(offering)) return { result: { status: 'invalid_value' }, message: 'companyId and offeringId are required.' };
        if (action === 'remove_negotiated') { await st.policy.setException({ autotaskCompanyId: company, offeringId: offering, cadence: String(a.cadence ?? ''), remove: true, decidedBy: who(ctx) }); return { result: { removed: true }, message: 'Negotiated price removed.' }; }
        if (a.price == null || !a.reason) return { result: { status: 'invalid_value' }, message: 'price and reason are required (expiresOn optional).' };
        await st.policy.setException({ autotaskCompanyId: company, offeringId: offering, cadence: String(a.cadence ?? ''), agreedUnitPrice: Number(a.price), reason: String(a.reason), expiresOn: a.expiresOn ? String(a.expiresOn) : null, decidedBy: who(ctx) });
        return { result: { saved: true }, message: 'Negotiated price saved — it is honoured as the target, not flagged as below target.' };
      }
      const [policies, exceptions] = await Promise.all([st.policy.policies(), st.policy.exceptions()]);
      return { result: { policies, negotiated: exceptions, default: 'vendor suggested price, never below cost; fees as overhead' }, message: `${policies.length} policy rule(s), ${exceptions.length} negotiated customer price(s).` };
    }],

    ['autotask_reconcile_export_workbook', async (a) => {
      const st = stores(); if (!st) return unavailable;
      const run = await runOf(st, a);
      if (!run) return { result: { status: 'not_found' }, message: 'No reconciliation run yet.' };
      const rows = await st.recon.rows(run.id);
      const [states, lines, policies, exceptions, planList] = await Promise.all([st.recon.states(rows.map((r) => r.exceptionKey)), run.documentId ? st.vendor.lines({ documentId: run.documentId, limit: 20000 }) : Promise.resolve([]), st.policy.policies(), st.policy.exceptions(), st.plans.list(20)]);
      const plans = (await Promise.all(planList.filter((p) => PLAN_KINDS_WITH_WRITES.includes(p.kind)).slice(0, 10).map((p) => st.plans.get(p.id)))).filter((p): p is NonNullable<typeof p> => !!p);
      const buf = await buildWorkbook({ run, rows, states, lines, policies, customerExceptions: exceptions, plans });
      const fileName = `GDS_${run.vendor}_Autotask_Reconciliation_${run.invoiceNumber ?? run.periodStart}.xlsx`;
      return { result: { fileName, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: buf.length, contentBase64: buf.toString('base64') }, message: `${fileName} (${Math.round(buf.length / 1024)} KB): Executive Summary, Exceptions, All Vendor Lines, Customer Contracts, Unmatched Internal NFR, Approved Changes, Execution Audit, Pricing Policy. contentBase64 holds the file.` };
    }],

    ['autotask_pricing_build_change_plan', async (a, ctx) => {
      const st = stores(); if (!st) return unavailable;
      const run = await runOf(st, a);
      if (!run) return { result: { status: 'not_found' }, message: 'No reconciliation run yet — autotask_reconcile_vendor_to_autotask.' };
      const runRows = await st.recon.rows(run.id);
      const include = (Array.isArray(a.include) && a.include.length ? a.include.map(String) : CHANGE_KINDS).filter((k: string): k is ChangeKind => (CHANGE_KINDS as string[]).includes(k));
      const now = new Date();
      const effectiveDate = a.effectiveDate ? String(a.effectiveDate).slice(0, 10) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) return { result: { status: 'invalid_value', field: 'effectiveDate' }, message: 'effectiveDate: YYYY-MM-DD.' };
      const io = await createEntityIO(s);
      // Units as they stand the day before the change — not the reconciled month's (a seat added since would be added twice).
      const rows = rebaseToEffectiveDate(runRows, await unitsBefore(io.query, [...new Set(runRows.filter((r) => r.lineKind === 'service' && r.contractServiceId != null).map((r) => r.contractServiceId!))], effectiveDate));
      const companyIds = [...new Set(rows.map((r) => r.autotaskCompanyId).filter((x): x is number => x != null))];
      const cc = await loadContractContext(io.query, { companyIds });
      const [links, offerings] = await Promise.all([st.vendor.catalogLinks(), st.vendor.offerings()]);
      const offeringOfService = new Map(links.filter((l) => l.autotaskEntity === 'Services').map((l) => [l.autotaskId, l.offeringId]));
      const manufacturerOf = new Map(offerings.map((o) => [o.id, o.manufacturer]));
      // Licence contracts: the customer's Recurring Service contracts in effect on the effective date that already hold a service of the same manufacturer.
      const licence = new Map<number, number[]>();
      for (const r of rows.filter((x) => x.exceptions.includes('not_billed') && x.autotaskCompanyId != null && x.offeringId != null)) {
        const mfr = manufacturerOf.get(r.offeringId!);
        const ids = [...new Set(cc.lines.filter((c) => { const k = cc.contracts.get(c.contractID); return k?.companyID === r.autotaskCompanyId && inEffect(k, effectiveDate) && manufacturerOf.get(offeringOfService.get(c.serviceID) ?? -1) === mfr; }).map((c) => c.contractID))];
        licence.set(r.autotaskCompanyId!, ids);
      }
      // Already invoiced at/after the effective date?
      const posted = await lastPostedFrom(io.query, rows.map((r) => r.contractServiceId).filter((x): x is number => x != null), rows.map((r) => r.contractServiceBundleId).filter((x): x is number => x != null), effectiveDate);
      const standard = (offeringId: number, cadence: string) => links.filter((l) => l.autotaskEntity === 'Services' && l.offeringId === offeringId && (l.cadence === cadence || (cadence === 'monthly' && l.cadence === 'MM'))).sort((x, y) => Number(y.method === 'standardized') - Number(x.method === 'standardized'))[0]?.autotaskId ?? null;
      const stdIds = [...new Set(rows.filter((r) => r.offeringId != null).map((r) => standard(r.offeringId!, r.cadence)).filter((x): x is number => x != null))];
      const svcRows = await inChunks<{ id: number; name: string; billingCodeID: number | null }>(io.query, 'Services', 'id', [...stdIds, ...rows.map((r) => r.serviceId).filter((x): x is number => x != null)], [], ['id', 'name', 'billingCodeID']);
      const names = new Map(svcRows.map((x) => [Number(x.id), String(x.name)]));
      // A contract charge needs a MATERIAL COST code (BillingCodes.useType 4) — a service's recurring code (useType 5)
      // is refused ("billingCodeID is not a material cost code"). Use backbillBillingCodeId, else the active
      // material code with the same tax category as the service's code, preferring one named like "Software".
      const serviceCode = new Map(svcRows.map((x) => [Number(x.id), x.billingCodeID == null ? null : Number(x.billingCodeID)]));
      const codes = new Map<number, number | null>();
      if (a.backbillFrom) {
        const override = a.backbillBillingCodeId != null ? Number(a.backbillBillingCodeId) : null;
        const all = await io.query<{ id: number; name: string; useType: number; isActive: boolean; taxCategoryID: number | null }>('BillingCodes', [{ op: 'gte', field: 'id', value: 0 }], { maxRecords: 2000, includeFields: ['id', 'name', 'useType', 'isActive', 'taxCategoryID'] });
        const byId = new Map(all.map((c) => [Number(c.id), c]));
        const material = all.filter((c) => Number(c.useType) === 4 && c.isActive);
        for (const [sid, code] of serviceCode) {
          if (override != null) { codes.set(sid, override); continue; }
          const own = code != null ? byId.get(code) : undefined;
          if (own && Number(own.useType) === 4) { codes.set(sid, code); continue; }
          const sameTax = material.filter((c) => (c.taxCategoryID ?? null) === (own?.taxCategoryID ?? null));
          const pick = sameTax.find((c) => /software/i.test(c.name)) ?? (sameTax.length === 1 ? sameTax[0] : undefined);
          codes.set(sid, pick ? Number(pick.id) : null);
        }
      }
      // Back-bill: from a month (YYYY-MM or YYYY-MM-DD → the 1st) up to the effective date.
      const backbillFrom = a.backbillFrom ? `${String(a.backbillFrom).slice(0, 7)}-01` : undefined;
      if (backbillFrom && !/^\d{4}-\d{2}-01$/.test(backbillFrom)) return { result: { status: 'invalid_value', field: 'backbillFrom' }, message: 'backbillFrom: YYYY-MM (the first month to back-bill).' };
      const inWindow = backbillFrom ? (await lastPostedFrom(io.query, rows.map((r) => r.contractServiceId).filter((x): x is number => x != null), [], backbillFrom)).service : undefined;
      const rowNos = Array.isArray(a.rows) ? a.rows.map(Number) : undefined;
      const plan = buildContractPlan({ rows, include, effectiveDate, contracts: cc.contracts, lastPostedThrough: posted.service, lastPostedBundle: posted.bundle, licenceContracts: licence, standardService: standard, serviceName: (id) => names.get(id) ?? null, billingCode: (id) => codes.get(id) ?? null, contractLines: cc.contractLines,
        ...(backbillFrom ? { backbillFrom, backbillPrice: a.backbillPrice != null && a.backbillPrice !== '' && Number.isFinite(Number(a.backbillPrice)) ? Number(a.backbillPrice) : a.backbillPrice === 'target' ? 'target' as const : 'contract' as const, ...(inWindow ? { lastPostedFrom: inWindow } : {}) } : {}),
        ...(rowNos ? { rowNos } : {}), ...(a.contractChoices && typeof a.contractChoices === 'object' ? { contractChoices: a.contractChoices } : {}) });
      if (!plan.rows.length) return { result: { summary: plan.summary }, message: 'Nothing to change for the selected rows.' };
      const saved = await st.plans.create({ kind: 'contract_pricing', title: `Contract changes from ${run.vendor} ${run.invoiceNumber ?? ''} (effective ${effectiveDate})`, params: { runId: run.id, include, effectiveDate, summary: plan.summary }, rows: plan.rows, by: who(ctx) });
      const sm = plan.summary;
      return { result: { ...planView(saved), summary: sm }, message: `Plan ${saved.id} (hash ${saved.hash}), effective ${effectiveDate}: ${sm.cost} cost update(s), ${sm.price} customer price change(s), ${sm.quantity} quantity change(s), ${sm.missing_line} missing line(s), ${sm.term} term move(s), ${sm.end_line} line(s) to end${sm.backbill ? `, ${sm.backbill} back-bill charge(s)` : ''}${sm.blocked ? `; ${sm.blocked} blocked` : ''}. Nothing written — customer prices change only for rows a person approves (autotask_change_plan_review action=approve), then autotask_change_plan_execute. A move's second row (end the old line) runs only after its first.` };
    }],

    ['autotask_reconcile_check_sync_drift', async (a) => {
      const st = stores(); if (!st) return unavailable;
      const days = Math.min(Math.max(Number(a.days) || 120, 1), 730);
      const plans = await plansToCheck(st.plans, days);
      const io = await createEntityIO(s);
      const { checked, findings } = await checkDrift(plans, { get: io.get, unitsOn: io.unitsOn });
      const fresh = await st.drift.record(findings);
      for (const f of fresh) notify(driftEvent(f));
      return { result: { checked, drift: findings, newSinceLastCheck: fresh.length }, message: `${checked} applied change(s) checked: ${findings.length} drifted (${fresh.length} new). ${findings.length ? 'Nothing is re-applied automatically — decide which system owns each field.' : ''}` };
    }],
  ];
}
