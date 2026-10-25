// Commerce: offerings, quotes, orders → one change plan (company → users → contract → services →
// delivery ticket → charges, with cross-row ids), and tracking to invoice and payment.

import { buildOrderPlan, offeringProblems, orderProblems, quoteOrder, type Offering, type OrderInput } from '../src/commerce/model';
import { executePlan, type EntityIO } from '../src/change-plans/execute';
import { trackOrder } from '../src/commerce/tools';
import type { Plan, PlanRow, PlanRowInput } from '../src/change-plans/store';
import type { Order } from '../src/commerce/store';

const off = (o: Partial<Offering>): Offering => ({ code: 'x', platform: null, name: 'X', kind: 'recurring', perUnit: false, unitLabel: 'user', autotaskServiceId: null, billingCodeId: null, unitPrice: null, delivery: null, contract: null, charge: null, modules: [], active: true, ...o });
const catalog = new Map<string, Offering>([
  ['psarelay-pro', off({ code: 'psarelay-pro', platform: 'PSArelay', name: 'PSArelay Pro', perUnit: true, autotaskServiceId: 501, contract: { contractCategory: 12, termMonths: 12 }, modules: ['core', 'reports'], delivery: { queueID: 8, title: 'Onboarding {company} — {quantity} {unitLabel}s' } })],
  ['addon-vendor', off({ code: 'addon-vendor', platform: 'PSArelay', name: 'Vendor billing add-on', autotaskServiceId: 502, unitPrice: 99, modules: ['vendor'] })],
  ['security-audit', off({ code: 'security-audit', name: 'Security audit', kind: 'one_time', billingCodeId: 77, unitPrice: 1500, delivery: { queueID: 9, title: 'Security audit — {company}' } })],
  ['old', off({ code: 'old', name: 'Old', active: false, unitPrice: 1 })],
]);
const prices = (id: number) => (id === 501 ? 25 : null);

describe('offerings and quotes', () => {
  test('an offering is checked before it is saved', () => {
    expect(offeringProblems(off({ code: 'Bad Code!', name: '' }))).toEqual(expect.arrayContaining([expect.stringMatching(/^code/), 'name is required.', expect.stringMatching(/autotaskServiceId/)]));
    expect(offeringProblems(off({ code: 'audit', name: 'A', kind: 'one_time' }))).toEqual(expect.arrayContaining([expect.stringMatching(/MATERIAL/), expect.stringMatching(/unitPrice/), expect.stringMatching(/delivery/)]));
    expect(offeringProblems(catalog.get('psarelay-pro')!)).toEqual([]);
  });
  test('quote: per-unit × quantity, flat lines ignore quantity, service price fallback, modules, problems', () => {
    const q = quoteOrder([{ offering: 'psarelay-pro', quantity: 4 }, { offering: 'addon-vendor', quantity: 7 }, { offering: 'security-audit' }], catalog, prices);
    expect(q.problems).toEqual([]);
    expect(q.lines.map((l) => [l.offering, l.quantity, l.unitPrice, l.total])).toEqual([['psarelay-pro', 4, 25, 100], ['addon-vendor', 1, 99, 99], ['security-audit', 1, 1500, 1500]]);
    expect([q.recurring, q.oneTime]).toEqual([199, 1500]);
    expect(q.modules).toEqual(['core', 'reports', 'vendor']);
    const bad = quoteOrder([{ offering: 'nope' }, { offering: 'old' }, { offering: 'psarelay-pro', quantity: 0 }], catalog, prices);
    expect(bad.problems).toEqual([expect.stringMatching(/no offering "nope"/), expect.stringMatching(/archived/), expect.stringMatching(/quantity/)]);
  });
});

describe('order validation', () => {
  const contacts = [{ firstName: 'Avery', lastName: 'Lee', emailAddress: 'avery@example.com' }, { firstName: 'Sam', lastName: 'Roe', emailAddress: 'sam@example.com' }];
  test('a new company needs a real name and a phone, and is refused when one with that name exists', () => {
    expect(orderProblems({ customer: { companyName: 'Gmail' }, lines: [] })).toEqual(expect.arrayContaining([expect.stringMatching(/companyName "Gmail"/), expect.stringMatching(/phone/)]));
    expect(orderProblems({ customer: { companyName: 'Example Dental', phone: '555-0100' }, lines: [] }, { existingCompanyWithName: { id: 42, companyName: 'Example Dental' } })).toEqual([expect.stringMatching(/already exists \(#42\).*companyId: 42/)]);
    expect(orderProblems({ customer: { companyName: 'Example Dental', phone: '555-0100' }, contacts, lines: [] })).toEqual([]);
  });
  test('contacts need names and a unique valid email; company 0 is refused', () => {
    expect(orderProblems({ customer: { companyId: 0 }, contacts: [{ firstName: '', lastName: 'X', emailAddress: 'bad' }, contacts[0]!, { ...contacts[0]!, emailAddress: 'AVERY@example.com' }], lines: [] }))
      .toEqual([expect.stringMatching(/company 0/), expect.stringMatching(/contact 1: firstName/), expect.stringMatching(/contact 1: a valid emailAddress/), expect.stringMatching(/contact 3: avery@example.com is listed twice/)]);
  });
});

describe('order plan', () => {
  const input: OrderInput = { customer: { companyName: 'Example Dental', phone: '555-0100', city: 'Atlanta' }, contacts: [{ firstName: 'Avery', lastName: 'Lee', emailAddress: 'Avery@Example.com' }, { firstName: 'Sam', lastName: 'Roe', emailAddress: 'sam@example.com' }],
    lines: [{ offering: 'psarelay-pro', quantity: 2 }, { offering: 'security-audit' }], startDate: '2026-11-01', notes: 'call before 10' };
  const q = quoteOrder(input.lines, catalog, prices);
  const { rows } = buildOrderPlan(input, q, catalog, '2026-10-24');
  test('company → users → contract → service adjustment → delivery tickets → one-time charge, each wired to the rows it needs', () => {
    expect(rows.map((r) => `${r.entity}:${(r.meta as { step: string }).step}`)).toEqual(['Companies:company', 'Contacts:contact', 'Contacts:contact', 'Contracts:contract', 'ContractServiceAdjustments:service', 'Tickets:ticket', 'Tickets:ticket', 'TicketCharges:charge']);
    expect(rows[0]!.after).toEqual({ companyName: 'Example Dental', companyType: 1, phone: '555-0100', city: 'Atlanta' });
    expect(rows[1]).toMatchObject({ after: { firstName: 'Avery', emailAddress: 'avery@example.com', primaryContact: true, isActive: 1 }, meta: { refs: { companyID: 1 } } });
    expect(rows[2]!.after).not.toHaveProperty('primaryContact');
    expect(rows[3]).toMatchObject({ after: { contractType: 7, status: 1, startDate: '2026-11-01', endDate: '2027-10-31', contractCategory: 12, contractName: 'PSArelay — PSArelay Pro' }, blocked: null, meta: { refs: { companyID: 1, contactID: 2 } } });
    expect(rows[4]).toMatchObject({ after: { serviceID: 501, unitChange: 2, adjustedUnitPrice: 25, effectiveDate: '2026-11-01' }, meta: { refs: { contractID: 4 } } });
    expect(rows[5]).toMatchObject({ after: { title: 'Onboarding Example Dental — 2 users', queueID: 8, status: 1, priority: 2 }, meta: { refs: { companyID: 1, contactID: 2 } } });
    expect(String(rows[6]!.after!.description)).toMatch(/Notes: call before 10/);
    expect(rows[7]).toMatchObject({ after: { name: 'Security audit', billingCodeID: 77, unitQuantity: 1, unitPrice: 1500, isBillableToCompany: true }, meta: { refs: { ticketID: 7 } } });
  });
  test('an existing company and contract: no company or contract rows, fixed ids', () => {
    const r = buildOrderPlan({ customer: { companyId: 314 }, lines: [{ offering: 'addon-vendor' }], contractId: 99, startDate: '2026-11-15' }, quoteOrder([{ offering: 'addon-vendor' }], catalog, prices), catalog, '2026-10-24').rows;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ entity: 'ContractServiceAdjustments', after: { contractID: 99, serviceID: 502, unitChange: 1, adjustedUnitPrice: 99, effectiveDate: '2026-11-15' } });
  });
  test('a recurring offering without a contract category blocks the contract row (Autotask requires one)', () => {
    const cat = new Map(catalog); cat.set('psarelay-pro', { ...catalog.get('psarelay-pro')!, contract: { termMonths: 12 } });
    const r = buildOrderPlan({ customer: { companyId: 314 }, lines: [{ offering: 'psarelay-pro', quantity: 3 }] }, quoteOrder([{ offering: 'psarelay-pro', quantity: 3 }], cat, prices), cat, '2026-10-24').rows;
    expect(r[0]!.blocked).toMatch(/contractCategory/);
  });
});

describe('executor: rows use the ids earlier rows create', () => {
  function fakePlans(inputs: PlanRowInput[]) {
    const plan: Plan = { id: 'p1', kind: 'commerce_order', title: 't', params: null, hash: 'h', status: 'open', createdBy: null, createdAt: 'x', rows: inputs.map((r, i) => ({ ...r, rowNo: i + 1, status: 'approved', approvedBy: 'u', approvedAt: 'x', result: null, executedAt: null }) as PlanRow) };
    return { plan, store: { setStatus: async (_: string, s: string) => { plan.status = s; }, setRowResult: async (_: string, n: number, status: string, result: Record<string, unknown>) => { const r = plan.rows.find((x) => x.rowNo === n)!; r.status = status as never; r.result = result; }, get: async () => plan } as never };
  }
  test('company id flows into the contacts and contract; a re-run after an interruption finds what exists', async () => {
    const input: OrderInput = { customer: { companyName: 'Example Dental', phone: '555-0100' }, contacts: [{ firstName: 'Avery', lastName: 'Lee', emailAddress: 'avery@example.com' }], lines: [{ offering: 'psarelay-pro', quantity: 2 }], startDate: '2026-11-01' };
    const { rows } = buildOrderPlan(input, quoteOrder(input.lines, catalog, prices), catalog, '2026-10-24');
    const nonAdj = rows.filter((r) => r.entity !== 'ContractServiceAdjustments');
    const { plan, store } = fakePlans(nonAdj);
    const db: Record<number, Record<string, unknown> & { _e: string }> = {}; let next = 7000; const created: Array<[string, Record<string, unknown>]> = [];
    let failTicket = true;
    const io: EntityIO = {
      get: async (_e, id) => (db[id] ? { ...db[id] } : null),
      update: async () => undefined,
      create: async (e, f) => { if (e === 'Tickets' && failTicket) throw new Error('HTTP 500 queue closed'); const id = next++; db[id] = { ...f, _e: e }; created.push([e, f]); return id; },
      findExisting: async (e, f) => Number(Object.entries(db).find(([, r]) => r._e === e && (e === 'Companies' ? r.companyName === f.companyName : e === 'Contacts' ? r.emailAddress === f.emailAddress && r.companyID === f.companyID : r.title === f.title))?.[0] ?? NaN) || null,
    };
    const rep = await executePlan(store, plan, io);
    expect(rep).toMatchObject({ applied: 3, failed: 1 }); // company, contact, contract in; the ticket failed
    expect(created.map(([e, f]) => [e, f.companyID ?? null])).toEqual([['Companies', null], ['Contacts', 7000], ['Contracts', 7000]]);
    expect(created[2]![1]).toMatchObject({ contactID: 7001 });
    expect(plan.rows[0]!.after).not.toHaveProperty('companyID'); // the stored plan (and its hash) is untouched
    // Fix the cause, re-approve the failed row, run again: only the ticket is written.
    failTicket = false; plan.rows[3]!.status = 'approved';
    const again = await executePlan(store, plan, io);
    expect(again).toMatchObject({ applied: 1, failed: 0 });
    expect(created.map(([e]) => e)).toEqual(['Companies', 'Contacts', 'Contracts', 'Tickets']);
    expect(created[3]![1]).toMatchObject({ companyID: 7000, contactID: 7001 });
  });
  test('a row whose referenced row has no id yet waits and writes nothing', async () => {
    const { plan, store } = fakePlans([
      { action: 'create', entity: 'Companies', targetId: null, label: 'c', before: null, after: { companyName: 'A' }, reason: null, blocked: null, meta: null },
      { action: 'create', entity: 'Contacts', targetId: null, label: 'u', before: null, after: { firstName: 'A' }, reason: null, blocked: null, meta: { refs: { companyID: 1 } } },
    ]);
    plan.rows[0]!.status = 'excluded';
    const writes: string[] = [];
    const rep = await executePlan(store, plan, { get: async () => null, update: async () => undefined, create: async (e) => { writes.push(e); return 1; }, findExisting: async () => null });
    expect(rep).toMatchObject({ waiting: 1, attempted: 0 });
    expect(writes).toEqual([]);
  });
});

describe('tracking an order to invoice and payment', () => {
  const plan: Plan = { id: 'p1', kind: 'commerce_order', title: 't', params: null, hash: 'h', status: 'done', createdBy: null, createdAt: 'x', rows: [
    { rowNo: 1, action: 'create', entity: 'Companies', targetId: null, label: 'c', before: null, after: {}, reason: null, blocked: null, meta: { step: 'company' }, status: 'applied', approvedBy: 'u', approvedAt: 'x', result: { id: 314 }, executedAt: 'x' },
    { rowNo: 2, action: 'create', entity: 'Tickets', targetId: null, label: 't', before: null, after: {}, reason: null, blocked: null, meta: { step: 'ticket' }, status: 'skipped', approvedBy: 'u', approvedAt: 'x', result: { existingId: 9001 }, executedAt: 'x' },
  ] };
  const base: Order = { id: 'o1', status: 'planned', customer: { companyName: 'Example Dental' }, contacts: [], lines: [], totals: { modules: ['core'] }, startDate: '2026-11-01', planId: 'p1', companyId: null, contractId: null, ticketIds: [], payment: { status: 'unpaid' }, notes: null, createdBy: null, createdAt: 'x', updatedAt: 'x' };
  function harness(invoice: Record<string, unknown> | null) {
    const updates: Array<Record<string, unknown>> = []; const events: string[] = [];
    const s = { httpClient: async () => ({ query: async (e: string) => (e === 'BillingItems' ? (invoice ? [{ id: 1, ticketID: 9001, invoiceID: 555 }] : [{ id: 1, ticketID: 9001, invoiceID: null }]) : e === 'Invoices' && invoice ? [invoice] : []) }) } as never;
    return { s, plans: { get: async () => plan } as never, orders: { update: async (_: string, f: Record<string, unknown>) => { updates.push(f); } } as never, updates, events, emit: (e: { type: string }) => { events.push(e.type); } };
  }
  test('set up → ready; then invoiced; then paid (paidDate) — each change notified once', async () => {
    let h = harness(null);
    let o = await trackOrder(h.s, h.plans, h.orders, base, h.emit as never);
    expect([o.status, o.companyId, o.ticketIds]).toEqual(['provisioned', 314, [9001]]);
    expect(h.events).toEqual(['commerce.order_ready']);
    h = harness({ id: 555, invoiceNumber: 'INV-1001', invoiceTotal: 1500, isVoided: false, paidDate: null });
    o = await trackOrder(h.s, h.plans, h.orders, o, h.emit as never);
    expect([o.status, o.payment.status, o.payment.invoiceNumbers]).toEqual(['invoiced', 'invoiced', ['INV-1001']]);
    expect(h.events).toEqual(['commerce.order_invoiced']);
    h = harness({ id: 555, invoiceNumber: 'INV-1001', invoiceTotal: 1500, isVoided: false, paidDate: '2026-11-02T15:00:00Z' });
    o = await trackOrder(h.s, h.plans, h.orders, o, h.emit as never);
    expect([o.status, o.payment.status, o.payment.amount]).toEqual(['paid', 'paid', 1500]);
    expect(h.events).toEqual(['commerce.order_paid']);
    const quiet = harness({ id: 555, invoiceNumber: 'INV-1001', invoiceTotal: 1500, isVoided: false, paidDate: '2026-11-02T15:00:00Z' });
    await trackOrder(quiet.s, quiet.plans, quiet.orders, o, quiet.emit as never);
    expect(quiet.events).toEqual([]); // nothing changed, nothing sent
  });
});

describe('subscription changes', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { buildChangePlan, periodOf, nextPeriodStart } = require('../src/commerce/model');
  test('monthly periods from the contract start, month ends handled', () => {
    expect(periodOf('2026-01-31', '2026-03-05')).toEqual({ start: '2026-02-28', end: '2026-03-30' });
    expect(periodOf('2026-11-01', '2026-11-15')).toEqual({ start: '2026-11-01', end: '2026-11-30' });
    expect(nextPeriodStart('2026-11-01', '2026-11-15')).toBe('2026-12-01');
    expect(periodOf('2026-11-10', '2026-12-09')).toEqual({ start: '2026-11-10', end: '2026-12-09' });
  });
  const current = [{ contractServiceId: 61, serviceId: 501, units: 3, unitPrice: 22 }, { contractServiceId: 62, serviceId: 999, units: 1, unitPrice: 50 }];
  const base = { contractId: 4, contractStart: '2026-11-01', today: '2026-11-16', current, catalog, servicePrice: prices };
  test('seats up today (line keeps its price, prorated), add-on added at catalog price; unnamed lines untouched', () => {
    const r = buildChangePlan({ ...base, targets: [{ offering: 'psarelay-pro', quantity: 5 }, { offering: 'addon-vendor' }] });
    expect(r.problems).toEqual([]);
    expect(r.lines).toEqual([
      { offering: 'psarelay-pro', name: 'PSArelay Pro', from: 3, to: 5, delta: 2, unitPrice: 22, effectiveDate: '2026-11-16', kind: 'increase', prorated: 22 }, // 2 × 22 × 15/30
      { offering: 'addon-vendor', name: 'Vendor billing add-on', from: 0, to: 1, delta: 1, unitPrice: 99, effectiveDate: '2026-11-16', kind: 'add', prorated: 49.5 },
    ]);
    expect(r.rows[0]!.after).toEqual({ contractID: 4, contractServiceID: 61, serviceID: 501, unitChange: 2, adjustedUnitPrice: 22, effectiveDate: '2026-11-16' });
    expect(r.rows[1]!.after).not.toHaveProperty('contractServiceID');
    expect(r.modules).toEqual(['core', 'reports', 'vendor']);
    expect(r.recurringAfter).toBe(5 * 22 + 99);
  });
  test('decrease and remove wait for the next period (no mid-period credit); nothing-to-do and archived adds are refused', () => {
    const r = buildChangePlan({ ...base, targets: [{ offering: 'psarelay-pro', quantity: 0 }] });
    expect(r.lines[0]).toMatchObject({ from: 3, to: 0, delta: -3, effectiveDate: '2026-12-01', kind: 'remove', prorated: null });
    expect(r.modules).toEqual([]);
    expect(buildChangePlan({ ...base, targets: [{ offering: 'psarelay-pro', quantity: 3 }] }).problems).toEqual([expect.stringMatching(/nothing changes/)]);
    expect(buildChangePlan({ ...base, targets: [{ offering: 'old', quantity: 1 }] }).problems).toEqual([expect.stringMatching(/not a recurring offering/)]);
    expect(buildChangePlan({ ...base, targets: [{ offering: 'security-audit' }] }).problems).toEqual([expect.stringMatching(/not a recurring offering/)]);
  });
  test('a downgrade-only change is complete once it is in — no invoice to wait for — and announces the change', async () => {
    const plan: Plan = { id: 'p9', kind: 'commerce_change', title: 't', params: null, hash: 'h', status: 'done', createdBy: null, createdAt: 'x', rows: [
      { rowNo: 1, action: 'create', entity: 'ContractServiceAdjustments', targetId: null, label: 'a', before: null, after: {}, reason: null, blocked: null, meta: { step: 'service' }, status: 'applied', approvedBy: 'u', approvedAt: 'x', result: { id: 0 }, executedAt: 'x' }] };
    const o: Order = { id: 'o9', status: 'planned', customer: { companyId: 314 }, contacts: [], lines: [{ name: 'PSArelay Pro', from: 3, to: 1, delta: -2 }], totals: { kind: 'change', modules: ['core'] }, startDate: '2026-12-01', planId: 'p9', companyId: 314, contractId: 4, ticketIds: [], payment: { status: 'unpaid' }, notes: null, createdBy: null, createdAt: 'x', updatedAt: 'x' };
    const events: string[] = [];
    const t = await trackOrder({ httpClient: async () => ({ query: async () => [] }) } as never, { get: async () => plan } as never, { update: async () => undefined } as never, o, ((e: { type: string }) => events.push(e.type)) as never);
    expect(t.status).toBe('complete');
    expect(events).toEqual(['commerce.subscription_changed']);
  });
});
