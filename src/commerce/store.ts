// Commerce storage (migration 0017): the offering catalog and orders.

import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type { Delivery, Offering, OfferingKind } from './model.js';

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const num = (v: unknown) => (v == null ? null : Number(v));

const offering = (x: Record<string, any>): Offering => ({
  code: x.code, platform: x.platform ?? null, name: x.name, kind: x.kind as OfferingKind, perUnit: !!x.per_unit, unitLabel: x.unit_label,
  autotaskServiceId: num(x.autotask_service_id), billingCodeId: num(x.billing_code_id), unitPrice: num(x.unit_price),
  delivery: (x.delivery ?? null) as Delivery | null, contract: x.contract ?? null, charge: x.charge ?? null, modules: Array.isArray(x.modules) ? x.modules : [], active: !!x.active,
});

export class OfferingStore {
  constructor(private readonly pool: Pool) {}
  async list(o: { includeArchived?: boolean; platform?: string } = {}): Promise<Offering[]> {
    const r = await this.pool.query(`SELECT * FROM commerce_offering WHERE ($1::boolean OR active) AND ($2::text IS NULL OR platform = $2) ORDER BY platform NULLS LAST, kind, code`, [!!o.includeArchived, o.platform ?? null]);
    return r.rows.map(offering);
  }
  async catalog(): Promise<Map<string, Offering>> { return new Map((await this.list({ includeArchived: true })).map((o) => [o.code, o])); }
  async get(code: string): Promise<Offering | null> { const r = await this.pool.query('SELECT * FROM commerce_offering WHERE code = $1', [code]); return r.rows[0] ? offering(r.rows[0]) : null; }
  async upsert(o: Offering, by: string | null): Promise<void> {
    await this.pool.query(`INSERT INTO commerce_offering (code, platform, name, kind, per_unit, unit_label, autotask_service_id, billing_code_id, unit_price, delivery, contract, charge, modules, active, updated_by, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
      ON CONFLICT (code) DO UPDATE SET platform = EXCLUDED.platform, name = EXCLUDED.name, kind = EXCLUDED.kind, per_unit = EXCLUDED.per_unit, unit_label = EXCLUDED.unit_label,
        autotask_service_id = EXCLUDED.autotask_service_id, billing_code_id = EXCLUDED.billing_code_id, unit_price = EXCLUDED.unit_price, delivery = EXCLUDED.delivery, contract = EXCLUDED.contract,
        charge = EXCLUDED.charge, modules = EXCLUDED.modules, active = EXCLUDED.active, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [o.code, o.platform, o.name, o.kind, o.perUnit, o.unitLabel, o.autotaskServiceId, o.billingCodeId, o.unitPrice, o.delivery ? JSON.stringify(o.delivery) : null, o.contract ? JSON.stringify(o.contract) : null, o.charge ? JSON.stringify(o.charge) : null, JSON.stringify(o.modules), o.active, by]);
  }
  async setActive(code: string, active: boolean, by: string | null): Promise<boolean> {
    return ((await this.pool.query('UPDATE commerce_offering SET active = $2, updated_by = $3, updated_at = now() WHERE code = $1', [code, active, by])).rowCount ?? 0) > 0;
  }
}

export type OrderStatus = 'planned' | 'provisioning' | 'provisioned' | 'invoiced' | 'paid' | 'complete' | 'failed' | 'cancelled';
export interface Payment { status: 'unpaid' | 'invoiced' | 'paid'; method?: string | null; reference?: string | null; amount?: number | null; invoiceIds?: number[]; invoiceNumbers?: string[]; paidAt?: string | null; at?: string | null; by?: string | null }
export interface Order {
  id: string; status: OrderStatus; customer: Record<string, unknown>; contacts: Array<Record<string, unknown>>; lines: Array<Record<string, unknown>>; totals: Record<string, unknown> | null;
  startDate: string; planId: string | null; companyId: number | null; contractId: number | null; ticketIds: number[]; payment: Payment; notes: string | null;
  createdBy: string | null; createdAt: string; updatedAt: string;
}
const order = (x: Record<string, any>): Order => ({
  id: x.id, status: x.status, customer: x.customer ?? {}, contacts: x.contacts ?? [], lines: x.lines ?? [], totals: x.totals ?? null, startDate: String(iso(x.start_date) ?? '').slice(0, 10),
  planId: x.plan_id ?? null, companyId: num(x.company_id), contractId: num(x.contract_id), ticketIds: Array.isArray(x.ticket_ids) ? x.ticket_ids.map(Number) : [], payment: x.payment ?? { status: 'unpaid' },
  notes: x.notes ?? null, createdBy: x.created_by ?? null, createdAt: iso(x.created_at)!, updatedAt: iso(x.updated_at)!,
});

export class OrderStore {
  constructor(private readonly pool: Pool) {}
  async create(o: Pick<Order, 'customer' | 'contacts' | 'lines' | 'totals' | 'startDate' | 'planId' | 'notes'> & { by: string | null; companyId?: number | null; contractId?: number | null }): Promise<Order> {
    const r = await this.pool.query(`INSERT INTO commerce_order (id, status, customer, contacts, lines, totals, start_date, plan_id, company_id, contract_id, notes, created_by) VALUES ($1,'planned',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [randomUUID(), JSON.stringify(o.customer), JSON.stringify(o.contacts), JSON.stringify(o.lines), o.totals ? JSON.stringify(o.totals) : null, o.startDate, o.planId, o.companyId ?? null, o.contractId ?? null, o.notes, o.by]);
    return order(r.rows[0]);
  }
  async get(id: string): Promise<Order | null> { const r = await this.pool.query('SELECT * FROM commerce_order WHERE id = $1', [id]); return r.rows[0] ? order(r.rows[0]) : null; }
  async list(limit = 30, status?: string): Promise<Order[]> {
    return (await this.pool.query('SELECT * FROM commerce_order WHERE ($2::text IS NULL OR status = $2) ORDER BY created_at DESC LIMIT $1', [limit, status ?? null])).rows.map(order);
  }
  /** Orders still on their way to paid (for tracking). */
  async open(): Promise<Order[]> { return (await this.pool.query(`SELECT * FROM commerce_order WHERE status IN ('provisioning','provisioned','invoiced') ORDER BY created_at`)).rows.map(order); }
  async update(id: string, f: Partial<Pick<Order, 'status' | 'companyId' | 'contractId' | 'ticketIds' | 'payment'>>): Promise<void> {
    await this.pool.query(`UPDATE commerce_order SET status = COALESCE($2, status), company_id = COALESCE($3, company_id), contract_id = COALESCE($4, contract_id),
        ticket_ids = COALESCE($5::jsonb, ticket_ids), payment = COALESCE($6::jsonb, payment), updated_at = now() WHERE id = $1`,
      [id, f.status ?? null, f.companyId ?? null, f.contractId ?? null, f.ticketIds ? JSON.stringify(f.ticketIds) : null, f.payment ? JSON.stringify(f.payment) : null]);
  }
}
