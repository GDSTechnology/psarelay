// Commerce tools: the offering catalog, quotes, and orders — a sign-up becomes ONE change plan
// (company → users → contract → services → delivery ticket → charges), approved by hash and run by
// the shared executor; then the order is tracked to its invoice and payment, read from Autotask.

import type { Pool } from 'pg';
import type { AutotaskService } from '../services/autotask.service.js';
import type { CallerContext } from '../types/context.js';
import { PlanStore, type Plan } from '../change-plans/store.js';
import { rowId } from '../change-plans/execute.js';
import { notify } from '../services/notifier.js';
import type { Logger } from '../utils/logger.js';
import { buildChangePlan, buildOrderPlan, offeringProblems, orderProblems, quoteOrder, type CurrentLine, type Offering, type OrderInput, type OrderLineInput } from './model.js';
import { dayBefore, unitsOn, type QueryFn } from '../vendors/contract-io.js';
import { OfferingStore, OrderStore, type Order, type OrderStatus, type Payment } from './store.js';

type Result = { result: unknown; message: string };
type H = (a: Record<string, any>, ctx: CallerContext) => Promise<Result>;
const who = (ctx: CallerContext) => ctx.trustedActingUserEmail ?? ctx.requestingUserEmail ?? (ctx.source !== 'unknown' ? ctx.source : null);
const today = () => new Date().toISOString().slice(0, 10);

/** The offering from tool input (snake or camel), defaults applied. */
export function offeringFromInput(x: Record<string, any>): Offering {
  return {
    code: String(x.code ?? '').trim().toLowerCase(), platform: x.platform ? String(x.platform) : null, name: String(x.name ?? '').trim(),
    kind: x.kind, perUnit: x.perUnit === true || x.per_unit === true, unitLabel: String(x.unitLabel ?? x.unit_label ?? 'user'),
    autotaskServiceId: x.autotaskServiceId != null ? Number(x.autotaskServiceId) : null, billingCodeId: x.billingCodeId != null ? Number(x.billingCodeId) : null,
    unitPrice: x.unitPrice != null && x.unitPrice !== '' ? Number(x.unitPrice) : null,
    delivery: x.delivery && typeof x.delivery === 'object' ? x.delivery : null, contract: x.contract && typeof x.contract === 'object' ? x.contract : null,
    charge: x.charge && typeof x.charge === 'object' ? x.charge : null, modules: Array.isArray(x.modules) ? x.modules.map(String) : [], active: x.active !== false,
  };
}

const isChange = (o: Pick<Order, 'totals'>) => ['change', 'cancel'].includes(String((o.totals as { kind?: string } | null)?.kind ?? ''));

/**
 * Where an order stands, from its plan and from Autotask billing (read-only): which company / contract /
 * tickets the plan created, whether its charges / contract have been invoiced, and whether that invoice is paid
 * (Invoices.paidDate is set when the payment syncs back from the accounting / payment platform).
 */
export async function trackOrder(s: AutotaskService, plans: PlanStore, orders: OrderStore, o: Order, emit: (e: Parameters<typeof notify>[0]) => void = notify): Promise<Order> {
  const plan = o.planId ? await plans.get(o.planId) : null;
  let { companyId, contractId } = o; let ticketIds = o.ticketIds; let status: OrderStatus = o.status;
  if (plan && status !== 'cancelled') {
    const rows = plan.rows.filter((r) => r.action !== 'info');
    const idOf = (step: string) => rows.filter((r) => (r.meta as { step?: string } | null)?.step === step && (r.status === 'applied' || r.status === 'skipped')).map((r) => rowId(r)).filter((n): n is number => n != null);
    companyId = companyId ?? idOf('company')[0] ?? (Number((o.customer as { companyId?: number }).companyId) || null);
    contractId = contractId ?? idOf('contract')[0] ?? null;
    ticketIds = [...new Set([...ticketIds, ...idOf('ticket')])];
    const done = rows.every((r) => r.status === 'applied' || r.status === 'skipped');
    const bad = rows.some((r) => r.status === 'failed' || r.status === 'stale');
    const some = rows.some((r) => r.status === 'applied' || r.status === 'skipped');
    if (['planned', 'provisioning', 'failed'].includes(status)) status = bad ? 'failed' : done ? 'provisioned' : some ? 'provisioning' : 'planned';
    // A change that only reduces or removes lines has nothing to invoice: it is complete once it is in.
    if (status === 'provisioned' && isChange(o) && !o.lines.some((l) => Number((l as { delta?: number }).delta) > 0)) status = 'complete';
  }
  let payment: Payment = o.payment;
  if (['provisioned', 'invoiced'].includes(status) && payment.status !== 'paid') {
    const http = await s.httpClient();
    // Billing items of the order: its delivery tickets' charges and its contract's lines (from the start date).
    const items: Array<Record<string, any>> = [];
    if (ticketIds.length) items.push(...await http.query<Record<string, any>>('BillingItems', [{ op: 'in', field: 'ticketID', value: ticketIds }] as never, { maxRecords: 500 }));
    if (contractId != null) items.push(...await http.query<Record<string, any>>('BillingItems', [{ op: 'eq', field: 'contractID', value: contractId }, { op: 'gte', field: 'itemDate', value: `${o.startDate}T00:00:00` }] as never, { maxRecords: 500 }));
    const invoiceIds = [...new Set(items.map((i) => Number(i.invoiceID)).filter((n) => Number.isInteger(n) && n > 0))];
    if (invoiceIds.length) {
      const inv = await http.query<Record<string, any>>('Invoices', [{ op: 'in', field: 'id', value: invoiceIds }] as never, { maxRecords: 100 });
      const live = inv.filter((i) => !i.isVoided);
      const paid = live.length > 0 && live.every((i) => i.paidDate);
      payment = { ...payment, status: paid ? 'paid' : 'invoiced', invoiceIds: live.map((i) => Number(i.id)), invoiceNumbers: live.map((i) => String(i.invoiceNumber ?? '')), amount: Math.round(live.reduce((t, i) => t + Number(i.invoiceTotal ?? 0), 0) * 100) / 100, paidAt: paid ? String(live.map((i) => i.paidDate).sort().slice(-1)[0]) : null };
      status = paid ? 'paid' : 'invoiced';
    }
  }
  const changed = status !== o.status || companyId !== o.companyId || contractId !== o.contractId || ticketIds.length !== o.ticketIds.length || payment.status !== o.payment.status;
  if (changed) {
    await orders.update(o.id, { status, companyId, contractId, ticketIds, payment });
    const fields = { order: o.id, company: String(companyId ?? ''), contract: String(contractId ?? ''), tickets: ticketIds.join(', '), modules: String(((o.totals ?? {}) as { modules?: string[] }).modules?.join(', ') ?? '') };
    // Subscription changes: tell the control plane at once (entitlements follow the contract).
    if (status !== o.status && (status === 'provisioned' || status === 'complete') && isChange(o)) emit({ type: 'commerce.subscription_changed', severity: 'info', title: 'Subscription changed', detail: `Order ${o.id}: ${o.lines.map((l) => `${(l as { name?: string }).name} ${(l as { from?: number }).from}→${(l as { to?: number }).to}`).join(', ')} on contract ${contractId}.`, fields: { ...fields, change: String((o.totals as { kind?: string } | null)?.kind ?? '') }, dedupeKey: `commerce.changed:${o.id}` });
    if (status !== o.status && status === 'provisioned' && !isChange(o)) emit({ type: 'commerce.order_ready', severity: 'info', title: 'Order set up in Autotask — ready to invoice', detail: `Order ${o.id}: company, users, contract and tickets are in place. Next: the invoice (from the delivery ticket / contract).`, fields, dedupeKey: `commerce.ready:${o.id}` });
    if (status !== o.status && status === 'invoiced') emit({ type: 'commerce.order_invoiced', severity: 'info', title: `Order invoiced: ${payment.invoiceNumbers?.join(', ')}`, detail: `Order ${o.id}: invoice ${payment.invoiceNumbers?.join(', ')} (${payment.amount}) — waiting for payment.`, fields: { ...fields, invoices: payment.invoiceNumbers?.join(', ') ?? '' }, dedupeKey: `commerce.invoiced:${o.id}` });
    if (status !== o.status && status === 'paid') emit({ type: 'commerce.order_paid', severity: 'info', title: `Order paid: ${payment.invoiceNumbers?.join(', ')}`, detail: `Order ${o.id} is paid (${payment.amount}). Build the account and start onboarding.`, fields: { ...fields, invoices: payment.invoiceNumbers?.join(', ') ?? '', amount: String(payment.amount ?? '') }, dedupeKey: `commerce.paid:${o.id}` });
    if (status !== o.status && status === 'failed') emit({ type: 'commerce.order_failed', severity: 'warning', title: 'Order set-up failed in Autotask', detail: `Order ${o.id}: a plan row failed or went stale — review plan ${o.planId}.`, fields, dedupeKey: `commerce.failed:${o.id}` });
  }
  return { ...o, status, companyId, contractId, ticketIds, payment };
}

const orderView = (o: Order, plan?: Plan | null) => ({
  id: o.id, status: o.status, payment: o.payment, companyId: o.companyId, contractId: o.contractId, ticketIds: o.ticketIds, startDate: o.startDate,
  customer: o.customer, contacts: o.contacts.length, lines: o.lines, totals: o.totals, planId: o.planId, createdBy: o.createdBy, createdAt: o.createdAt,
  ...(plan ? { plan: { status: plan.status, hash: plan.hash, rows: plan.rows.map((r) => ({ row: r.rowNo, label: r.label, status: r.status, ...(r.blocked ? { blocked: r.blocked } : {}) })) } } : {}),
});

export function commerceToolHandlers(s: AutotaskService, getPool: () => Pool | null): Array<[string, H]> {
  const stores = () => { const p = getPool(); return p ? { offerings: new OfferingStore(p), orders: new OrderStore(p), plans: new PlanStore(p) } : null; };
  const noPg: Result = { result: { status: 'unavailable' }, message: 'Needs the Postgres store (migration 0017).' };
  // Autotask Service prices for recurring lines (one read each).
  const servicePrices = async (catalog: Map<string, Offering>, codes: string[]) => {
    const http = await s.httpClient(); const out = new Map<number, number | null>();
    for (const c of codes) {
      const o = catalog.get(c); if (!o?.autotaskServiceId || o.unitPrice != null || out.has(o.autotaskServiceId)) continue;
      const svc = await http.get<Record<string, any>>('Services', o.autotaskServiceId).catch(() => null);
      out.set(o.autotaskServiceId, svc?.unitPrice != null ? Number(svc.unitPrice) : null);
    }
    return (id: number) => out.get(id) ?? null;
  };

  return [
    ['autotask_commerce_offerings', async (a, ctx) => {
      const st = stores(); if (!st) return noPg;
      const action = String(a.action ?? 'list');
      if (action === 'list') { const list = await st.offerings.list({ includeArchived: a.includeArchived === true, platform: a.platform }); return { result: { offerings: list }, message: `${list.length} offering(s).` }; }
      if (action === 'get') { const o = await st.offerings.get(String(a.code ?? '')); return o ? { result: o, message: `${o.code}: ${o.name}` } : { result: { status: 'not_found' }, message: `No offering "${a.code}".` }; }
      if (action === 'archive' || action === 'restore') {
        const ok = await st.offerings.setActive(String(a.code ?? ''), action === 'restore', who(ctx));
        return { result: { ok }, message: ok ? `${a.code} ${action === 'restore' ? 'restored' : 'archived (existing orders keep it; new orders can’t use it)'}.` : `No offering "${a.code}".` };
      }
      if (action === 'set') {
        const o = offeringFromInput(a.offering ?? {});
        const problems = offeringProblems(o);
        // Check what it points at in Autotask (reads only).
        const http = await s.httpClient(); const checks: Record<string, unknown> = {};
        if (!problems.length && o.autotaskServiceId) {
          const svc = await http.get<Record<string, any>>('Services', o.autotaskServiceId).catch(() => null);
          if (!svc) problems.push(`Autotask Service ${o.autotaskServiceId} not found.`);
          else { checks.service = { id: svc.id, name: svc.name, unitPrice: svc.unitPrice, isActive: svc.isActive }; if (svc.isActive === false) problems.push(`Autotask Service ${svc.id} "${svc.name}" is inactive.`); }
        }
        if (!problems.length && o.billingCodeId) {
          const bc = (await http.query<Record<string, any>>('BillingCodes', [{ op: 'eq', field: 'id', value: o.billingCodeId }] as never, { maxRecords: 1 }).catch(() => []))[0];
          if (!bc) problems.push(`Billing code ${o.billingCodeId} not found.`);
          else { checks.billingCode = { id: bc.id, name: bc.name, useType: bc.useType }; if (Number(bc.useType) !== 4) problems.push(`Billing code ${bc.id} "${bc.name}" is useType ${bc.useType} — a charge needs a MATERIAL cost code (useType 4).`); }
        }
        if (problems.length) return { result: { status: 'invalid', problems, checks }, message: `Not saved: ${problems.join(' ')}` };
        await st.offerings.upsert(o, who(ctx));
        return { result: { saved: o, checks }, message: `Saved offering ${o.code} (${o.kind}${o.perUnit ? `, per ${o.unitLabel}` : ''}).` };
      }
      return { result: { status: 'invalid_value', field: 'action' }, message: 'action: list | get | set | archive | restore.' };
    }],

    ['autotask_commerce_quote', async (a) => {
      const st = stores(); if (!st) return noPg;
      const catalog = await st.offerings.catalog();
      const lines = Array.isArray(a.lines) ? a.lines : [];
      const q = quoteOrder(lines, catalog, await servicePrices(catalog, lines.map((l: { offering: string }) => l.offering)));
      return { result: q, message: q.problems.length ? `Can't quote: ${q.problems.join(' ')}` : `One-time ${q.oneTime}, recurring ${q.recurring} per period; unlocks ${q.modules.join(', ') || 'no modules'}.` };
    }],

    ['autotask_commerce_order', async (a, ctx) => {
      const st = stores(); if (!st) return noPg;
      const action = String(a.action ?? 'status');
      if (action === 'list') { const l = await st.orders.list(Math.min(Number(a.limit) || 30, 200), a.status); return { result: { orders: l.map((o) => orderView(o)) }, message: `${l.length} order(s).` }; }
      if (action === 'invoice_queue') {
        // What still needs an invoice: set up in Autotask, not invoiced yet (the invoice runner's work list).
        const open = (await st.orders.list(200, 'provisioned'));
        return { result: { orders: open.map((o) => ({ id: o.id, companyId: o.companyId, contractId: o.contractId, ticketIds: o.ticketIds, startDate: o.startDate, totals: o.totals })) }, message: `${open.length} order(s) set up and waiting for their invoice.` };
      }
      if (action === 'track') {
        const open = await st.orders.open(); const out = [];
        for (const o of open) out.push(await trackOrder(s, st.plans, st.orders, o).catch((e) => ({ ...o, error: String(e).slice(0, 200) })));
        return { result: { orders: out.map((o) => ({ id: o.id, status: o.status, payment: o.payment.status })) }, message: `Tracked ${out.length} open order(s).` };
      }
      if (action === 'create') {
        const input: OrderInput = { customer: a.customer ?? {}, contacts: a.contacts ?? [], lines: a.lines ?? [], ...(a.startDate ? { startDate: String(a.startDate) } : {}), ...(a.contractId ? { contractId: Number(a.contractId) } : {}), ...(a.notes ? { notes: String(a.notes) } : {}) };
        const http = await s.httpClient();
        let existingCompanyWithName: { id: number; companyName: string } | null = null;
        const cust = input.customer as { companyId?: number; companyName?: string };
        if (cust.companyId == null && cust.companyName?.trim()) {
          const hit = (await http.query<{ id: number; companyName: string }>('Companies', [{ op: 'eq', field: 'companyName', value: cust.companyName.trim() }] as never, { maxRecords: 1, includeFields: ['id', 'companyName'] }))[0];
          if (hit) existingCompanyWithName = { id: Number(hit.id), companyName: hit.companyName };
        }
        const problems = orderProblems(input, { existingCompanyWithName });
        if (cust.companyId != null && !problems.length) {
          const co = await http.get<Record<string, any>>('Companies', Number(cust.companyId)).catch(() => null);
          if (!co) problems.push(`No company ${cust.companyId}.`);
        }
        const catalog = await st.offerings.catalog();
        const q = quoteOrder(input.lines, catalog, await servicePrices(catalog, input.lines.map((l) => l.offering)));
        problems.push(...q.problems);
        if (problems.length) return { result: { status: 'invalid', problems }, message: `Order not placed: ${problems.join(' ')}` };
        const { rows, startDate } = buildOrderPlan(input, q, catalog, today());
        const title = `Order: ${q.lines.map((l) => `${l.name}${l.perUnit ? ` × ${l.quantity}` : ''}`).join(', ')} — ${cust.companyName ?? `company #${cust.companyId}`}`;
        const plan = await st.plans.create({ kind: 'commerce_order', title: title.slice(0, 200), params: { orderInput: input as unknown as Record<string, unknown> }, rows, by: who(ctx), supersedeKind: false });
        const order = await st.orders.create({ customer: input.customer as unknown as Record<string, unknown>, contacts: (input.contacts ?? []) as unknown as Array<Record<string, unknown>>, lines: q.lines as unknown as Array<Record<string, unknown>>,
          totals: { oneTime: q.oneTime, recurring: q.recurring, modules: q.modules }, startDate, planId: plan.id, notes: input.notes ?? null, by: who(ctx), companyId: cust.companyId ?? null, contractId: input.contractId ?? null });
        const blocked = plan.rows.filter((r) => r.blocked);
        return { result: { order: orderView(order, plan), quote: q },
          message: `Order ${order.id} placed: ${plan.rows.length} step(s) in plan ${plan.id} (hash ${plan.hash}) — one-time ${q.oneTime}, recurring ${q.recurring}.${blocked.length ? ` ${blocked.length} step(s) BLOCKED: ${blocked.map((r) => r.blocked).join('; ')}.` : ''} Next: approve it (autotask_change_plan_review action=approve, planId, hash) and run it (autotask_change_plan_execute). Then autotask_commerce_order action=status follows it to its invoice and payment.` };
      }
      if (action === 'change' || action === 'cancel_subscription') {
        // A change to an existing recurring contract: upgrade / add-on / seats / downgrade / cancel.
        const contractId = Number(a.contractId);
        if (!(contractId > 0)) return { result: { status: 'invalid_value', field: 'contractId' }, message: 'contractId: the customer’s recurring contract.' };
        const http = await s.httpClient();
        const contract = await http.get<Record<string, any>>('Contracts', contractId).catch(() => null);
        if (!contract) return { result: { status: 'not_found' }, message: `No contract ${contractId}.` };
        if (Number(contract.contractType) !== 7) return { result: { status: 'invalid' }, message: `Contract ${contractId} is not a recurring service contract (type ${contract.contractType}).` };
        const q: QueryFn = (e, f, opts) => http.query(e, f as never, opts);
        const t = today();
        const lineRows = await q<Record<string, any>>('ContractServices', [{ op: 'eq', field: 'contractID', value: contractId }], { maxRecords: 200, includeFields: ['id', 'serviceID'], noCache: true });
        const current: CurrentLine[] = [];
        for (const l of lineRows) { const u = await unitsOn(q, 'service', Number(l.id), t); current.push({ contractServiceId: Number(l.id), serviceId: Number(l.serviceID), units: u?.units ?? 0, unitPrice: u?.unitPrice ?? null }); }
        const catalog = await st.offerings.catalog();
        const targets: OrderLineInput[] = action === 'cancel_subscription'
          ? current.filter((c) => c.units > 0).map((c) => [...catalog.values()].find((x) => x.autotaskServiceId === c.serviceId && x.kind === 'recurring')).filter((x): x is Offering => !!x).map((x) => ({ offering: x.code, quantity: 0 }))
          : (Array.isArray(a.lines) ? a.lines : []);
        const plan = buildChangePlan({ contractId, contractStart: String(contract.startDate).slice(0, 10), today: t, ...(a.effectiveDate ? { effectiveDate: String(a.effectiveDate).slice(0, 10) } : {}), current, targets, catalog,
          servicePrice: await servicePrices(catalog, targets.map((x) => x.offering)) });
        if (plan.problems.length) return { result: { status: 'invalid', problems: plan.problems, current }, message: `Not placed: ${plan.problems.join(' ')}` };
        const rows = [...plan.rows];
        // Cancelling: optionally end the contract the day before the last line stops.
        if (action === 'cancel_subscription' && a.endContract === true && plan.lines.length) {
          const last = plan.lines.map((l) => l.effectiveDate).sort().slice(-1)[0]!;
          rows.push({ action: 'update', entity: 'Contracts', targetId: contractId, label: `End contract ${contractId} on ${dayBefore(last)}`, before: { endDate: contract.endDate }, after: { endDate: dayBefore(last) }, reason: 'subscription cancelled', blocked: null, meta: { step: 'contract_end' } });
        }
        const kindTitle = action === 'cancel_subscription' ? 'Cancel subscription' : 'Change subscription';
        const p = await st.plans.create({ kind: 'commerce_change', title: `${kindTitle}: contract ${contractId} — ${plan.lines.map((l) => `${l.name} ${l.from}→${l.to}`).join(', ')}`.slice(0, 200), params: { contractId, lines: plan.lines }, rows, by: who(ctx), supersedeKind: false });
        const prorated = Math.round(plan.lines.reduce((x, l) => x + (l.prorated ?? 0), 0) * 100) / 100;
        const order = await st.orders.create({ customer: { companyId: Number(contract.companyID) }, contacts: [], lines: plan.lines as unknown as Array<Record<string, unknown>>,
          totals: { kind: action === 'cancel_subscription' ? 'cancel' : 'change', proratedNow: prorated, recurringAfter: plan.recurringAfter, modules: plan.modules },
          startDate: plan.lines.map((l) => l.effectiveDate).sort()[0]!, planId: p.id, notes: a.notes ? String(a.notes) : null, by: who(ctx), companyId: Number(contract.companyID), contractId });
        return { result: { order: orderView(order, p), lines: plan.lines, proratedNow: prorated, recurringAfter: plan.recurringAfter, modulesAfter: plan.modules, otherLines: current.filter((c) => ![...catalog.values()].some((x) => x.autotaskServiceId === c.serviceId)) },
          message: `${kindTitle} placed as order ${order.id}: ${plan.lines.map((l) => `${l.name} ${l.from}→${l.to} from ${l.effectiveDate}`).join('; ')}.${prorated ? ` About ${prorated} prorated for this period (Autotask calculates the exact amount).` : ''} Recurring after: ${plan.recurringAfter}. Modules after: ${plan.modules.join(', ') || 'none'}. Approve plan ${p.id} (hash ${p.hash}) and run it like any other plan.` };
      }

      const o = a.orderId ? await st.orders.get(String(a.orderId)) : null;
      if (!o) return { result: { status: 'not_found' }, message: `No order ${a.orderId ?? ''} (action=list shows them).` };
      if (action === 'status') {
        const t = o.status === 'cancelled' ? o : await trackOrder(s, st.plans, st.orders, o);
        const plan = t.planId ? await st.plans.get(t.planId) : null;
        return { result: orderView(t, plan), message: `Order ${t.id}: ${t.status}${t.payment.status !== 'unpaid' ? ` — ${t.payment.status}${t.payment.invoiceNumbers?.length ? ` (invoice ${t.payment.invoiceNumbers.join(', ')})` : ''}` : ''}.` };
      }
      if (action === 'mark_paid') {
        if (!a.reference) return { result: { status: 'invalid_value', field: 'reference' }, message: 'reference: the payment reference (e.g. the transaction id).' };
        const payment: Payment = { ...o.payment, status: 'paid', method: a.method ? String(a.method) : 'manual', reference: String(a.reference), at: new Date().toISOString(), by: who(ctx) };
        await st.orders.update(o.id, { status: 'paid', payment });
        notify({ type: 'commerce.order_paid', severity: 'info', title: 'Order marked paid', detail: `Order ${o.id} marked paid by ${who(ctx) ?? 'a user'} (${payment.reference}).`, fields: { order: o.id, company: String(o.companyId ?? ''), reference: payment.reference ?? '' }, dedupeKey: `commerce.paid:${o.id}` });
        return { result: { status: 'paid' }, message: `Order ${o.id} marked paid.` };
      }
      if (action === 'cancel') {
        if (!['planned', 'failed'].includes(o.status)) return { result: { status: o.status }, message: `Order ${o.id} is ${o.status} — only an order not yet set up in Autotask can be cancelled here (undo what was created with the plan's revert).` };
        await st.orders.update(o.id, { status: 'cancelled' });
        if (o.planId) await st.plans.setStatus(o.planId, 'cancelled');
        return { result: { status: 'cancelled' }, message: `Order ${o.id} cancelled; its plan will not run.` };
      }
      return { result: { status: 'invalid_value', field: 'action' }, message: 'action: create | change | cancel_subscription | status | list | track | invoice_queue | mark_paid | cancel.' };
    }],
  ];
}

/** Follow open orders to their invoice and payment every few minutes (reads the mirror / Autotask; no writes). */
export function startCommerceTracker(s: AutotaskService, getPool: () => Pool | null, logger: Logger, everyMs = 5 * 60_000): () => void {
  const pool = getPool(); if (!pool) return () => undefined;
  const plans = new PlanStore(pool), orders = new OrderStore(pool);
  const run = async () => {
    try { for (const o of await orders.open()) await trackOrder(s, plans, orders, o).catch((e) => logger.warn?.(`commerce: tracking order ${o.id} failed`, e)); }
    catch (e) { if (!/commerce_order/.test(String(e))) logger.warn?.('commerce: tracker run failed', e); }
  };
  const t = setInterval(() => { void run(); }, everyMs); t.unref?.();
  return () => clearInterval(t);
}
