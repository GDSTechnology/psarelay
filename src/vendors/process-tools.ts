// Tools for the monthly billing process around the reconciliation:
//   autotask_billing_preinvoice_check   read-only, before Approve & Post (step 7)
//   autotask_pricing_customer_notices   who must be told about a contract plan's
//                                       changes, export, record notice sent (step 4)
// Exception outcomes (step 3) live on autotask_reconcile_get_exceptions.

import type { Pool } from 'pg';
import type { AutotaskService } from '../services/autotask.service.js';
import type { CallerContext } from '../types/context.js';
import { VendorStore } from './store.js';
import { ReconStore, DECIDED_STATUSES } from './recon-store.js';
import { PlanStore, type Plan } from '../change-plans/store.js';
import { NOTICE_METHODS, NoticeStore, buildNotices, noticesCsv, rowsAwaitingNotice } from './notices.js';
import { analyzePreinvoice, loadPreinvoice } from './preinvoice.js';
import { createEntityIO } from './catalog-tools.js';

type Result = { result: unknown; message: string };
type H = (a: Record<string, any>, ctx: CallerContext) => Promise<Result>;
const who = (ctx: CallerContext) => ctx.requestingUserEmail ?? (ctx.source !== 'unknown' ? ctx.source : null);
const unavailable: Result = { result: { status: 'unavailable' }, message: 'Needs the Postgres store (MCP_PG_ENABLED=true and migrations up to 0014).' };
const money = (n: number) => `$${n.toFixed(2)}`;
const today = () => new Date().toISOString().slice(0, 10);
const lastDayOfMonth = (d: string) => { const x = new Date(`${d.slice(0, 7)}-01T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + 1); x.setUTCDate(0); return x.toISOString().slice(0, 10); };

export function processToolHandlers(s: AutotaskService, getPool: () => Pool | null): Array<[string, H]> {
  const stores = () => { const p = getPool(); return p ? { vendor: new VendorStore(p), recon: new ReconStore(p), plans: new PlanStore(p), notices: new NoticeStore(p) } : null; };

  /** The plan asked for, else the newest open contract pricing plan. */
  const planOf = async (st: NonNullable<ReturnType<typeof stores>>, id: unknown): Promise<Plan | null> => {
    if (id) return st.plans.get(String(id));
    const open = (await st.plans.list(50)).find((p) => p.kind === 'contract_pricing' && p.status === 'open');
    return open ? st.plans.get(open.id) : null;
  };

  return [
    ['autotask_pricing_customer_notices', async (a, ctx) => {
      const st = stores(); if (!st) return unavailable;
      const action = String(a.action ?? 'list');
      const plan = await planOf(st, a.planId);
      if (!plan) return { result: { status: 'not_found' }, message: a.planId ? `No plan ${a.planId}.` : 'No open contract pricing plan — build one (autotask_pricing_build_change_plan).' };
      if (plan.kind !== 'contract_pricing') return { result: { status: 'invalid_value', field: 'planId' }, message: `Plan ${plan.id} is a ${plan.kind} plan — notices are for contract pricing plans.` };
      const list = buildNotices(plan, await st.notices.list(plan.id));

      if (action === 'mark_sent' || action === 'unmark') {
        const all = a.companyIds === 'all' || (Array.isArray(a.companyIds) && a.companyIds.includes('all'));
        const ids = all ? list.map((c) => c.companyId) : (Array.isArray(a.companyIds) ? a.companyIds : a.companyId != null ? [a.companyId] : []).map(Number).filter(Number.isFinite);
        if (!ids.length) return { result: { status: 'invalid_value', field: 'companyIds' }, message: 'companyIds: the customers (Autotask company ids) — or "all" for every customer in the plan.' };
        const unknown = ids.filter((id) => !list.some((c) => c.companyId === id));
        if (unknown.length) return { result: { status: 'invalid_value', field: 'companyIds', unknown }, message: `Not customers in plan ${plan.id}: ${unknown.join(', ')}.` };
        if (action === 'unmark') { const n = await st.notices.remove(plan.id, ids); return { result: { removed: n }, message: `Notice record removed for ${n} customer(s); their customer-facing rows wait again.` }; }
        const method = String(a.method ?? 'email');
        if (!(NOTICE_METHODS as readonly string[]).includes(method)) return { result: { status: 'invalid_value', field: 'method', choices: NOTICE_METHODS }, message: `method: ${NOTICE_METHODS.join(' | ')} (waived = no notice needed — say why in note).` };
        if (method === 'waived' && !a.note) return { result: { status: 'invalid_value', field: 'note' }, message: 'waived needs a note: why no notice is needed (e.g. "agreed on the call 10/11").' };
        const sentOn = a.sentOn ? String(a.sentOn).slice(0, 10) : today();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(sentOn)) return { result: { status: 'invalid_value', field: 'sentOn' }, message: 'sentOn: YYYY-MM-DD.' };
        const n = await st.notices.record(plan.id, ids, { sentOn, method, note: a.note ? String(a.note) : null, by: who(ctx) });
        const short = buildNotices(plan, await st.notices.list(plan.id)).filter((c) => ids.includes(c.companyId) && c.noticeDays != null && c.noticeDays < (Number(a.minNoticeDays) || 30));
        return { result: { recorded: n, shortNotice: short.map((c) => ({ companyId: c.companyId, customer: c.customer, noticeDays: c.noticeDays, effectiveDate: c.effectiveDate })) },
          message: `Notice recorded (${method}, ${sentOn}) for ${n} customer(s); their approved customer-facing rows can now execute.${short.length ? ` SHORT NOTICE (< ${Number(a.minNoticeDays) || 30} days before the effective date): ${short.map((c) => `${c.customer} ${c.noticeDays}d`).join(', ')}.` : ''}` };
      }

      if (action === 'export') {
        const csv = noticesCsv(list);
        const fileName = `customer-notices-${plan.id.slice(0, 8)}.csv`;
        return { result: { fileName, mimeType: 'text/csv', bytes: Buffer.byteLength(csv), contentBase64: Buffer.from(csv).toString('base64') }, message: `${fileName}: ${list.length} customer(s), ${list.reduce((t, c) => t + c.lines.length, 0)} change(s) — one line per change, for a mail merge.` };
      }

      const held = rowsAwaitingNotice(plan, await st.notices.list(plan.id));
      const pending = list.filter((c) => c.increase && !c.notice);
      return {
        result: { planId: plan.id, planStatus: plan.status, customers: list, awaitingNotice: pending.length, approvedRowsHeld: held.length },
        message: `Plan ${plan.id}: ${list.length} customer(s) with invoice changes — ${money(list.reduce((t, c) => t + Math.max(c.monthlyChange, 0), 0))}/month in increases, ${money(list.reduce((t, c) => t + c.oneTime, 0))} one-time. ${pending.length} still need a notice${pending.length ? ` (${pending.slice(0, 6).map((c) => c.customer ?? c.companyId).join(', ')}${pending.length > 6 ? ', …' : ''})` : ''}; ${held.length} approved row(s) are held until it is recorded (action=mark_sent).`,
      };
    }],

    ['autotask_billing_preinvoice_check', async (a) => {
      const st = stores(); if (!st) return unavailable;
      const throughDate = a.throughDate ? String(a.throughDate).slice(0, 10) : lastDayOfMonth(today());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(throughDate)) return { result: { status: 'invalid_value', field: 'throughDate' }, message: 'throughDate: YYYY-MM-DD — the date you will Approve & Post through (default: the end of this month).' };
      const companyId = a.companyId != null && a.companyId !== '' ? Number(a.companyId) : undefined; // 0 = your own company
      // Customers reconciled in the latest run of each vendor are always checked (duplicate lines), not only those with a pending charge.
      const runs = await st.recon.runs(20);
      const latest = new Map<string, (typeof runs)[number]>(); for (const r of runs) if (!latest.has(r.vendor)) latest.set(r.vendor, r);
      const reconRows = (await Promise.all([...latest.values()].map((r) => st.recon.rows(r.id)))).flat();
      const reconCompanies = [...new Set(reconRows.map((r) => r.autotaskCompanyId).filter((x): x is number => x != null))];
      const io = await createEntityIO(s);
      const data = await loadPreinvoice(io.query, { throughDate, ...(companyId != null ? { companyId } : { companyIds: reconCompanies }) });
      const links = await st.vendor.catalogLinks();
      const offeringOfService = new Map(links.filter((l) => l.autotaskEntity === 'Services').map((l) => [l.autotaskId, l.offeringId]));
      const planList = (await st.plans.list(50)).filter((p) => p.kind === 'contract_pricing' && (p.status === 'open' || p.status === 'executing' || p.status === 'executed' || p.status === 'done'));
      const plans = (await Promise.all(planList.map((p) => st.plans.get(p.id)))).filter((p): p is Plan => !!p);
      const notices = await st.notices.list();
      const crit = reconRows.filter((r) => r.severity === 'critical' && (companyId == null || r.autotaskCompanyId === companyId));
      const states = await st.recon.states(crit.map((r) => r.exceptionKey));
      const openCritical = crit.filter((r) => { const s2 = states.get(r.exceptionKey)?.status ?? 'open'; return !DECIDED_STATUSES.includes(s2) && s2 !== 'fix_planned'; })
        .map((r) => ({ customer: r.customerName, offering: r.offering, exceptions: r.exceptions, monthlyExposure: r.monthlyExposure, exceptionKey: r.exceptionKey }));
      const rep = analyzePreinvoice({ throughDate, ...data, offeringOfService, plans, notices, openCritical });
      const head = rep.verdict === 'stop' ? `STOP — do not Approve & Post yet: ${rep.doubleBilling.length} charge(s) would bill months another line already bills.`
        : rep.verdict === 'review' ? 'REVIEW before Approve & Post.' : 'READY — nothing found that would make this invoice wrong.';
      return {
        result: { ...rep, autotaskCalls: data.calls },
        message: `${head} Through ${throughDate}: ${rep.pendingCharges.length} pending charge(s) (${money(rep.totals.pendingChargeAmount)})${rep.pendingCharges.some((c) => c.warning) ? `, ${rep.pendingCharges.filter((c) => c.warning).length} with a warning` : ''}; ${rep.duplicateLines.length} customer product(s) on two lines this month; ${rep.priceChanges.length} plan change(s) taking effect${rep.priceChanges.some((c) => c.noticeRecorded === false) ? ` (${rep.priceChanges.filter((c) => c.noticeRecorded === false).length} without a recorded customer notice)` : ''}; ${rep.openCritical.length} undecided critical reconciliation exception(s). Read-only — nothing was changed.`,
      };
    }],
  ];
}
