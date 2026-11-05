// Materials onto a ticket (autotask_add_ticket_materials): catalog products →
// priced TicketCharges, with the existing charges checked for duplicates.
//
// Why (2026-11-04): a tech asked ChatGPT to put cable, patch cords and jacks on a
// ticket. The pieces existed (find_product, create_ticket_charge) but nothing
// tied them together: find_product returned no prices, create_ticket_charge
// wanted a chargeType picklist id and checked nothing, so a re-run doubled the
// bill. This module is the pure part — which product each line means, its price,
// and whether the ticket already carries it. Nothing here calls Autotask.

import { matchProducts, type ProductMatch, type SearchableProduct } from './catalog-hygiene.js';
import { findInternalText } from './invoice-text.js';

export interface MaterialRequest {
  /** Exact product id (from a previous plan's candidates). Wins over query. */
  productId?: number;
  /** Part number, SKU or name words — matched against the whole catalog. */
  query?: string;
  quantity: number;
  /** Override the catalog price for this charge. */
  unitPrice?: number;
  /** Override the catalog cost for this charge. */
  unitCost?: number;
  /** Charge description (default: the product's). */
  description?: string;
}

export interface CatalogProduct extends SearchableProduct {
  productBillingCodeID?: number | null;
}

export interface ExistingCharge {
  id: number;
  productID?: number | null;
  name?: string | null;
  unitQuantity?: number | null;
  unitPrice?: number | null;
  datePurchased?: string | null;
  isBilled?: boolean | null;
}

export type MaterialAction = 'create' | 'duplicate' | 'needs_product' | 'invalid';

export interface MaterialLine {
  line: number;
  action: MaterialAction;
  request: MaterialRequest;
  productID?: number;
  name?: string;
  sku?: string | null;
  manufacturerProductName?: string | null;
  description?: string | null;
  quantity: number;
  unitPrice?: number;
  unitCost?: number;
  extendedPrice?: number;
  /** Where the price came from: the catalog, or the caller's override. */
  priceSource?: 'catalog' | 'override';
  billingCodeID?: number | null;
  /** Charges already on the ticket for this product (action duplicate). */
  existing?: ExistingCharge[];
  /** Ranked catalog matches when the line did not resolve to one product. */
  candidates?: Array<Pick<ProductMatch, 'id' | 'name' | 'sku' | 'manufacturerProductName' | 'unitPrice' | 'unitCost' | 'score' | 'matchedOn'>>;
  problem?: string;
  /** Something the reviewer should know that does not block the line. */
  note?: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const num = (v: unknown): number | undefined => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));

/**
 * The one product a free-text line means, or the candidates to choose from.
 * Resolved only when it is unambiguous: a single match, or an exact identifier
 * hit (sku / part number) that outranks every other match. Name-word matches
 * ("cat6 patch cable" vs 3 ft / 6 ft / 10 ft) always come back as a choice —
 * a wrong product on a bill is worse than one more question.
 */
export function resolveProductQuery(catalog: SearchableProduct[], query: string): { productId: number } | { candidates: ProductMatch[] } {
  const matches = matchProducts(catalog, query, { activeOnly: true, limit: 25 });
  if (matches.length === 1) return { productId: matches[0]!.id };
  const [top, second] = matches;
  if (top && top.score >= 100 && (!second || second.score < top.score)) return { productId: top.id };
  // FULL_MATCH: every word of the query is in the name, or a part number contains it. One full
  // match among partials ("plenum cat6 cable" vs patch cables sharing "cat6 cable") is the one meant;
  // two or more ("cat6 patch cable": 3 ft and 6 ft) are a choice — and only those are offered.
  const full = matches.filter((m) => m.score >= FULL_MATCH);
  if (full.length === 1) return { productId: full[0]!.id };
  return { candidates: (full.length ? full : matches).slice(0, 8) };
}
/** matchProducts' score for "all query words in the name" (40); any identifier hit scores more. */
const FULL_MATCH = 40;

/** Charges on the ticket that are the same product (by productID; by exact name for charges without one). */
export function findDuplicates(existing: ExistingCharge[], product: { id: number; name?: string | undefined }): ExistingCharge[] {
  const name = product.name?.trim().toLowerCase();
  return existing.filter((c) => (c.productID != null ? Number(c.productID) === product.id : !!name && (c.name ?? '').trim().toLowerCase() === name));
}

/**
 * Plan each requested line. `products` holds the resolved product records
 * (by id); `resolved` maps a line index to its product id, or to its candidates.
 */
export function planMaterialLines(input: {
  items: MaterialRequest[];
  resolved: Array<{ productId: number } | { candidates: ProductMatch[] } | { error: string }>;
  products: Map<number, CatalogProduct>;
  existing: ExistingCharge[];
  allowDuplicates?: boolean;
  allowInternalText?: boolean;
}): MaterialLine[] {
  const seen = new Set<number>();
  return input.items.map((request, i) => {
    const line = i + 1;
    const quantity = Number(request.quantity);
    const base: MaterialLine = { line, action: 'invalid', request, quantity };
    if (!Number.isFinite(quantity) || quantity <= 0) return { ...base, problem: 'quantity must be a number above 0' };
    const r = input.resolved[i];
    if (!r) return { ...base, problem: 'give productId or query' };
    if ('error' in r) return { ...base, problem: r.error };
    if ('candidates' in r) {
      const candidates = r.candidates.map((m) => ({ id: m.id, name: m.name, sku: m.sku, manufacturerProductName: m.manufacturerProductName, unitPrice: m.unitPrice, unitCost: m.unitCost, score: m.score, matchedOn: m.matchedOn }) as NonNullable<MaterialLine['candidates']>[number]);
      return {
        ...base, action: 'needs_product', candidates,
        problem: candidates.length ? `"${request.query}" matches ${candidates.length} products — pick one and pass its productId` : `no active product matches "${request.query}" — try a part number or other words, or pass productId`,
      };
    }
    const p = input.products.get(r.productId);
    if (!p) return { ...base, problem: `product ${r.productId} not found` };
    const overridePrice = num(request.unitPrice);
    const unitPrice = overridePrice ?? num(p.unitPrice);
    const unitCost = num(request.unitCost) ?? num(p.unitCost) ?? 0;
    // The description prints on the invoice. A catalog description with purchasing notes / cost
    // in it is left off (the charge keeps the product name); a supplied one is refused below.
    const catalogInternal = request.description === undefined ? findInternalText(p.description) : [];
    const requestInternal = input.allowInternalText ? [] : findInternalText(`${request.description ?? ''}`);
    const described: MaterialLine = {
      ...base,
      productID: p.id,
      ...(p.name !== undefined ? { name: p.name } : {}),
      sku: p.sku ?? null,
      manufacturerProductName: p.manufacturerProductName ?? null,
      description: request.description ?? (catalogInternal.length ? null : p.description ?? null),
      ...(catalogInternal.length ? { note: `catalog description left off the invoice — it contains ${catalogInternal.join(', ')}` } : {}),
      unitCost,
      billingCodeID: num(p.productBillingCodeID) ?? null,
      ...(unitPrice !== undefined ? { unitPrice, extendedPrice: round2(unitPrice * quantity), priceSource: overridePrice !== undefined ? 'override' as const : 'catalog' as const } : {}),
    };
    if (p.isActive === false) return { ...described, problem: `product ${p.id} is inactive` };
    if (requestInternal.length) return { ...described, problem: `the description contains ${requestInternal.join(', ')} — it prints on the customer's invoice; describe the product only (cost and price have their own fields), or pass allowInternalText` };
    if (unitPrice === undefined) return { ...described, problem: `product ${p.id} has no unit price in the catalog — pass unitPrice` };
    if (seen.has(p.id) && !input.allowDuplicates) return { ...described, action: 'duplicate', problem: 'the same product is listed twice in this request — combine the quantities, or pass allowDuplicates' };
    seen.add(p.id);
    const dups = findDuplicates(input.existing, p);
    if (dups.length && !input.allowDuplicates) {
      return { ...described, action: 'duplicate', existing: dups, problem: `the ticket already has ${dups.length === 1 ? 'a charge' : `${dups.length} charges`} for this product (${dups.map((d) => `#${d.id}: ${d.unitQuantity ?? '?'} × ${d.unitPrice ?? '?'}${d.datePurchased ? ` on ${String(d.datePurchased).slice(0, 10)}` : ''}`).join('; ')}) — not added again; pass allowDuplicates if it really is another one` };
    }
    return { ...described, action: 'create', ...(dups.length ? { existing: dups } : {}) };
  });
}

export function summarizeMaterialLines(lines: MaterialLine[]): { counts: Record<MaterialAction, number>; total: number; readyToWrite: boolean } {
  const counts: Record<MaterialAction, number> = { create: 0, duplicate: 0, needs_product: 0, invalid: 0 };
  let total = 0;
  for (const l of lines) {
    counts[l.action]++;
    if (l.action === 'create') total += l.extendedPrice ?? 0;
  }
  // Every line must be settled (a product chosen, a price known) before anything is written:
  // a half-written materials list is harder to fix than a second question.
  return { counts, total: round2(total), readyToWrite: counts.create > 0 && counts.needs_product === 0 && counts.invalid === 0 };
}
