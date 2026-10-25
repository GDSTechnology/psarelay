// MCP tool handlers for vendor billing reconciliation (P0). Read-only toward
// Autotask: imports and mapping decisions are stored in the MCP's Postgres.

import type { Pool } from 'pg';
import type { AutotaskService } from '../services/autotask.service.js';
import type { CallerContext } from '../types/context.js';
import { VendorStore } from './store.js';
import { ADAPTERS, importVendorFile, proposeCatalogLinks, proposeCustomers, proposeOfferings, type CompanyLookup } from './service.js';

type Result = { result: unknown; message: string };
type H = (a: Record<string, any>, ctx: CallerContext) => Promise<Result>;

const MAX_BYTES = 10 * 1024 * 1024;
const CONF_RANK: Record<string, number> = { high: 3, medium: 2, low: 1, none: 0 };
const who = (ctx: CallerContext) => ctx.requestingUserEmail ?? (ctx.source !== 'unknown' ? ctx.source : null);
const unavailable: Result = { result: { status: 'unavailable' }, message: 'Vendor reconciliation needs the Postgres store (MCP_PG_ENABLED=true and migration 0010).' };

function companyLookup(s: AutotaskService): CompanyLookup {
  return {
    async byIds(ids) {
      const http = await s.httpClient();
      const out: Array<{ id: number; companyName: string; isActive: boolean }> = [];
      const real = ids.filter((i) => i > 0);
      for (let i = 0; i < real.length; i += 200) {
        out.push(...(await http.query<{ id: number; companyName: string; isActive: boolean }>('Companies', [{ op: 'in', field: 'id', value: real.slice(i, i + 200) }], { maxRecords: 500, includeFields: ['id', 'companyName', 'isActive'] })));
      }
      if (ids.includes(0)) {
        const own = await http.query<{ id: number; companyName: string; isActive: boolean }>('Companies', [{ op: 'eq', field: 'id', value: 0 }], { maxRecords: 1, includeFields: ['id', 'companyName', 'isActive'] });
        out.push(...own);
      }
      return out;
    },
    async byNames(names) {
      const http = await s.httpClient();
      const out: Array<{ id: number; companyName: string; isActive: boolean }> = [];
      for (let i = 0; i < names.length; i += 100) {
        out.push(...(await http.query<{ id: number; companyName: string; isActive: boolean }>('Companies', [{ op: 'in', field: 'companyName', value: names.slice(i, i + 100) }], { maxRecords: 500, includeFields: ['id', 'companyName', 'isActive'] })));
      }
      return out;
    },
  };
}

export function vendorToolHandlers(s: AutotaskService, getPool: () => Pool | null): Array<[string, H]> {
  const store = (): VendorStore | null => { const p = getPool(); return p ? new VendorStore(p) : null; };

  return [
    ['autotask_vendor_list_sources', async (a) => {
      const st = store(); if (!st) return unavailable;
      const vendor = a.vendor ? String(a.vendor) : undefined;
      const [docs, cust, offs, links, lines] = await Promise.all([st.listDocuments(vendor ? { vendor } : {}), st.customerMappings(vendor), st.offeringMappings(vendor), st.catalogLinks(), st.lines(vendor ? { vendor, limit: 20000 } : { limit: 20000 })]);
      const custIds = new Set(lines.map((l) => l.vendorCustomerId).filter(Boolean));
      const skus = new Set(lines.map((l) => l.sku).filter(Boolean));
      const coverage = {
        vendorCustomers: custIds.size, customersDecided: cust.filter((m) => custIds.has(m.vendorCustomerId)).length,
        skus: skus.size, skusDecided: offs.filter((m) => skus.has(m.sku)).length,
        autotaskServicesLinked: links.filter((l) => l.autotaskEntity === 'Services').length,
      };
      return {
        result: { adapters: ADAPTERS.map((x) => ({ vendor: x.vendor, label: x.label, formats: x.formats })), extraFormats: ['Pax8 company report (customer crosswalk)'], documents: docs, coverage },
        message: `${docs.length} imported document(s)${docs[0] ? `, latest ${docs[0].vendor} ${docs[0].invoiceNumber ?? ''} (${docs[0].invoiceDate})` : ''}. Customers decided ${coverage.customersDecided}/${coverage.vendorCustomers}, SKUs decided ${coverage.skusDecided}/${coverage.skus}, Autotask services linked to offerings: ${coverage.autotaskServicesLinked}.`,
      };
    }],

    ['autotask_vendor_import_invoice', async (a, ctx) => {
      const st = store(); if (!st) return unavailable;
      const fileName = String(a.fileName ?? '').trim();
      if (!fileName) return { result: { status: 'invalid_value', field: 'fileName' }, message: 'fileName is required.' };
      const content = typeof a.content === 'string' ? a.content : typeof a.contentBase64 === 'string' ? Buffer.from(a.contentBase64, 'base64').toString('utf8') : '';
      if (!content.trim()) return { result: { status: 'invalid_value', field: 'content' }, message: 'Pass the file text in content (or contentBase64).' };
      if (Buffer.byteLength(content) > MAX_BYTES) return { result: { status: 'too_large' }, message: 'File over 10 MB.' };
      const r = await importVendorFile(st, { content, fileName, by: who(ctx), ...(a.invoiceNumber ? { invoiceNumber: String(a.invoiceNumber) } : {}) });
      if (r.kind === 'crosswalk') return { result: r, message: `${r.created ? 'Imported' : 'Already imported'} the ${r.vendor} customer crosswalk: ${r.crosswalkRows} vendor customer(s)${r.warnings.length ? `; ${r.warnings.length} without a PSA company` : ''}. Next: autotask_reconcile_resolve_mapping kind=customers action=propose.` };
      const c = r.checks!;
      return {
        result: r,
        message: `${r.created ? 'Imported' : 'Already imported (same file)'} ${r.vendor} invoice ${r.document!.invoiceNumber ?? ''} (${r.document!.invoiceDate}): ${r.document!.lineCount} line(s), total ${r.document!.lineTotal}, ${c.customers} customer(s). ${c.subtotalMismatches.length ? `WARNING: ${c.subtotalMismatches.length} customer subtotal(s) don't match the vendor's` : 'Every line accounted for: each customer subtotal matches the vendor\'s.'} By class: ${Object.entries(r.byClass!).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
      };
    }],

    ['autotask_vendor_get_lines', async (a) => {
      const st = store(); if (!st) return unavailable;
      const vendor = a.vendor ? String(a.vendor) : undefined;
      let lines = await st.lines({ ...(vendor ? { vendor } : {}), ...(a.invoiceDate ? { invoiceDate: String(a.invoiceDate) } : {}), ...(a.documentId ? { documentId: Number(a.documentId) } : {}), ...(a.vendorCustomerId ? { vendorCustomerId: String(a.vendorCustomerId) } : {}), ...(a.sku ? { sku: String(a.sku) } : {}), limit: 20000 });
      if (a.chargeClass) lines = lines.filter((l) => l.chargeClass === String(a.chargeClass));
      const cust = new Map((await st.customerMappings()).map((m) => [`${m.vendor}|${m.vendorCustomerId}`, m]));
      const offs = new Map((await st.offeringMappings()).map((m) => [`${m.vendor}|${m.sku}`, m]));
      const offerings = new Map((await st.offerings()).map((o) => [o.id, o]));
      const rows = lines.map((l) => {
        const c = l.vendorCustomerId ? cust.get(`${l.vendor}|${l.vendorCustomerId}`) : undefined;
        const o = l.sku ? offs.get(`${l.vendor}|${l.sku}`) : undefined;
        const { raw: _raw, ...rest } = l;
        return { ...rest, customer: c ? { status: c.status, autotaskCompanyId: c.autotaskCompanyId } : 'unmapped', offering: o ? (o.offeringId ? { status: o.status, id: o.offeringId, name: offerings.get(o.offeringId)?.name } : { status: o.status }) : 'unmapped' };
      });
      const filtered = a.unmappedOnly === true ? rows.filter((r) => r.customer === 'unmapped' || r.offering === 'unmapped') : rows;
      const sum = (k: (r: typeof filtered[number]) => string) => { const m: Record<string, { lines: number; cost: number }> = {}; for (const r of filtered) { const e = (m[k(r)] ??= { lines: 0, cost: 0 }); e.lines++; e.cost = Math.round((e.cost + (r.costTotal ?? 0)) * 100) / 100; } return m; };
      const limit = Math.min(Math.max(Number(a.limit) || 200, 1), 5000);
      return {
        result: { lines: filtered.slice(0, limit), totalLines: filtered.length, byChargeClass: sum((r) => r.chargeClass), byCadence: sum((r) => r.cadence), byCustomer: sum((r) => r.vendorCustomerName ?? '(none)') },
        message: `${filtered.length} line(s)${filtered.length > limit ? ` (first ${limit} shown)` : ''}, total cost ${Math.round(filtered.reduce((n, r) => n + (r.costTotal ?? 0), 0) * 100) / 100}.`,
      };
    }],

    ['autotask_reconcile_resolve_mapping', async (a, ctx) => {
      const st = store(); if (!st) return unavailable;
      const kind = String(a.kind ?? ''), action = String(a.action ?? '');
      const vendor = String(a.vendor ?? 'pax8');
      const by = who(ctx);
      const min = CONF_RANK[String(a.minConfidence ?? 'high')] ?? 3;

      if (kind === 'customers') {
        if (action === 'list') { const m = await st.customerMappings(vendor); return { result: m, message: `${m.length} customer decision(s).` }; }
        if (action === 'propose' || action === 'accept') {
          const p = await proposeCustomers(st, companyLookup(s), vendor, { includeMapped: a.includeMapped === true });
          if (action === 'propose') return { result: p, message: `${p.length} vendor customer(s) to decide: ${p.filter((x) => x.confidence === 'high').length} high, ${p.filter((x) => x.confidence === 'medium').length} medium, ${p.filter((x) => !x.proposed).length} unmatched.` };
          const take = p.filter((x) => x.proposed && CONF_RANK[x.confidence]! >= min);
          await st.setCustomerMappings(take.map((x) => ({ vendor, vendorCustomerId: x.vendorCustomerId, vendorCustomerName: x.vendorCustomerName, status: x.proposed!.status, autotaskCompanyId: x.proposed!.autotaskCompanyId, method: x.method, confidence: x.confidence, note: x.why, decidedBy: by })));
          return { result: { saved: take.length, skipped: p.length - take.length }, message: `Saved ${take.length} customer mapping(s); ${p.length - take.length} left for review.` };
        }
        if (action === 'set') {
          const items = Array.isArray(a.items) ? a.items : [];
          const bad = items.filter((i: any) => !i.vendorCustomerId || !['mapped', 'internal', 'ignore'].includes(i.status) || (i.status === 'mapped' && !Number.isInteger(Number(i.autotaskCompanyId))));
          if (!items.length || bad.length) return { result: { status: 'invalid_value', bad }, message: 'items: [{ vendorCustomerId, status: mapped|internal|ignore, autotaskCompanyId (for mapped) }].' };
          const lines = await st.lines({ vendor, limit: 20000 });
          const names = new Map(lines.map((l) => [l.vendorCustomerId, l.vendorCustomerName]));
          await st.setCustomerMappings(items.map((i: any) => ({ vendor, vendorCustomerId: String(i.vendorCustomerId), vendorCustomerName: names.get(String(i.vendorCustomerId)) ?? i.vendorCustomerName ?? null, status: i.status, autotaskCompanyId: i.autotaskCompanyId != null ? Number(i.autotaskCompanyId) : null, method: 'manual', confidence: 'confirmed', note: i.note ?? null, decidedBy: by })));
          return { result: { saved: items.length }, message: `Saved ${items.length} customer decision(s).` };
        }
      }

      if (kind === 'offerings') {
        if (action === 'list') { const [m, o] = await Promise.all([st.offeringMappings(vendor), st.offerings()]); return { result: { mappings: m, offerings: o }, message: `${m.length} SKU decision(s), ${o.length} offering(s).` }; }
        if (action === 'propose' || action === 'accept') {
          const p = await proposeOfferings(st, vendor, { includeMapped: a.includeMapped === true });
          if (action === 'propose') return { result: p, message: `${p.length} SKU(s) to decide: ${p.filter((x) => x.confidence === 'high').length} high, ${p.filter((x) => x.confidence === 'medium').length} medium, ${p.filter((x) => x.confidence === 'low').length} low.` };
          const take = p.filter((x) => CONF_RANK[x.confidence]! >= min);
          const ms = [];
          for (const x of take) {
            const off = x.proposed.offering ? (x.proposed.offering.id ? { id: x.proposed.offering.id } : await st.ensureOffering({ manufacturer: x.proposed.offering.manufacturer, name: x.proposed.offering.name, by })) : null;
            ms.push({ vendor, sku: x.sku, status: x.proposed.status, offeringId: off?.id ?? null, method: 'proposal', confidence: x.confidence, note: x.why, decidedBy: by });
          }
          await st.setOfferingMappings(ms);
          return { result: { saved: ms.length, skipped: p.length - ms.length }, message: `Saved ${ms.length} SKU decision(s); ${p.length - ms.length} left for review.` };
        }
        if (action === 'set') {
          const items = Array.isArray(a.items) ? a.items : [];
          if (!items.length || items.some((i: any) => !i.sku || !['mapped', 'not_billable', 'ignore'].includes(i.status) || (i.status === 'mapped' && !i.offeringId && !(i.offering?.manufacturer && i.offering?.name)))) return { result: { status: 'invalid_value' }, message: 'items: [{ sku, status: mapped|not_billable|ignore, offeringId | offering: { manufacturer, name } }].' };
          const ms = [];
          for (const i of items) {
            const off = i.status === 'mapped' ? (i.offeringId ? { id: Number(i.offeringId) } : await st.ensureOffering({ manufacturer: String(i.offering.manufacturer), name: String(i.offering.name), unit: i.offering.unit ?? null, kind: i.offering.kind ?? 'recurring', by })) : null;
            ms.push({ vendor, sku: String(i.sku), status: i.status, offeringId: off?.id ?? null, method: 'manual', confidence: 'confirmed', note: i.note ?? null, decidedBy: by });
          }
          await st.setOfferingMappings(ms);
          return { result: { saved: ms.length }, message: `Saved ${ms.length} SKU decision(s).` };
        }
      }

      if (kind === 'catalog') {
        if (action === 'list') { const l = await st.catalogLinks(); return { result: l, message: `${l.length} Autotask catalog link(s).` }; }
        if (action === 'propose' || action === 'accept') {
          const http = await s.httpClient();
          const services = await http.query<{ id: number; name: string; periodType: number; unitCost: number; unitPrice: number; isActive: boolean }>('Services', [{ op: 'eq', field: 'isActive', value: true }], { maxRecords: 2000, includeFields: ['id', 'name', 'periodType', 'unitCost', 'unitPrice', 'isActive'] });
          const p = await proposeCatalogLinks(st, services, { includeLinked: a.includeMapped === true });
          if (action === 'propose') return { result: p, message: `${p.length} Autotask service(s) with a candidate offering: ${p.filter((x) => x.confidence === 'high').length} high, ${p.filter((x) => x.confidence === 'medium').length} medium, ${p.filter((x) => x.confidence === 'low').length} low (pick from candidates).` };
          const take = p.filter((x) => x.proposed && CONF_RANK[x.confidence]! >= min);
          await st.setCatalogLinks(take.map((x) => ({ autotaskEntity: 'Services', autotaskId: x.autotaskId, offeringId: x.proposed!.offeringId, cadence: x.cadence, method: 'proposal', confidence: x.confidence, note: x.why, decidedBy: by })));
          return { result: { saved: take.length, skipped: p.length - take.length }, message: `Saved ${take.length} catalog link(s); ${p.length - take.length} left for review.` };
        }
        if (action === 'set') {
          const items = Array.isArray(a.items) ? a.items : [];
          if (!items.length || items.some((i: any) => !Number.isInteger(Number(i.autotaskId)) || !Number.isInteger(Number(i.offeringId)) || typeof i.cadence !== 'string')) return { result: { status: 'invalid_value' }, message: 'items: [{ autotaskId, offeringId, cadence: MM|AM|AA|monthly|annual|one_time|"" }].' };
          await st.setCatalogLinks(items.map((i: any) => ({ autotaskEntity: String(i.autotaskEntity ?? 'Services'), autotaskId: Number(i.autotaskId), offeringId: Number(i.offeringId), cadence: String(i.cadence), method: 'manual', confidence: 'confirmed', note: i.note ?? null, decidedBy: by })));
          return { result: { saved: items.length }, message: `Saved ${items.length} catalog link(s).` };
        }
      }
      return { result: { status: 'invalid_value' }, message: 'kind: customers | offerings | catalog; action: propose | list | set | accept.' };
    }],
  ];
}
