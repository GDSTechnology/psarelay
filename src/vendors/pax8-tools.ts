// autotask_vendor_sync — Pax8 Partner API: import invoices (same parser as the
// CSV export) and refresh the price reference for every mapped SKU and term.
// Off until PAX8_CLIENT_ID / PAX8_CLIENT_SECRET are configured.

import type { Pool } from 'pg';
import type { CallerContext } from '../types/context.js';
import { VendorStore } from './store.js';
import { PriceStore, perOf } from './prices.js';
import { pax8RowsToDocument } from './pax8.js';
import { Pax8Client, pax8Config, pax8ItemToCsvRow, pax8PricingCadence } from './pax8-api.js';
import { documentChecks, sha256 } from './service.js';

type Result = { result: unknown; message: string };
type H = (a: Record<string, any>, ctx: CallerContext) => Promise<Result>;
const who = (ctx: CallerContext) => ctx.requestingUserEmail ?? (ctx.source !== 'unknown' ? ctx.source : null);

export function pax8ToolHandlers(getPool: () => Pool | null, env: NodeJS.ProcessEnv = process.env): Array<[string, H]> {
  return [
    ['autotask_vendor_sync', async (a, ctx) => {
      const what = String(a.what ?? 'status');
      const cfg = pax8Config(env);
      if (!cfg) return { result: { status: 'not_configured' }, message: 'The Pax8 API is not configured. In Pax8: Integrations → Credentials → generate an API key; put PAX8_CLIENT_ID and PAX8_CLIENT_SECRET in the MCP server env file and restart. Until then, import the invoice CSV exports with autotask_vendor_import_invoice.' };
      if (what === 'status') return { result: { status: 'configured', apiUrl: cfg.apiUrl, tokenUrl: cfg.tokenUrl }, message: `Pax8 API configured (${cfg.apiUrl}). what=invoices imports invoices; what=pricing refreshes cost + suggested price per SKU and term.` };
      const pool = getPool();
      if (!pool) return { result: { status: 'unavailable' }, message: 'Needs the Postgres store.' };
      const store = new VendorStore(pool), prices = new PriceStore(pool);
      const api = new Pax8Client(cfg);
      const by = who(ctx);

      if (what === 'invoices') {
        const since = String(a.since ?? new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 10));
        const invoices = (await api.all('/invoices')).filter((inv) => String(inv.invoiceDate ?? '').slice(0, 10) >= since);
        const have = new Set((await store.listDocuments({ vendor: 'pax8', limit: 500 })).map((d) => d.invoiceNumber));
        const results: Array<Record<string, unknown>> = [];
        for (const inv of invoices) {
          const number = String(inv.number ?? inv.invoiceNumber ?? inv.id);
          if (have.has(number)) { results.push({ invoice: number, status: 'already imported' }); continue; }
          const items = await api.all(`/invoices/${inv.id}/items`);
          const rows = items.map((it) => pax8ItemToCsvRow(it, inv));
          const doc = pax8RowsToDocument(rows, { account: env.PAX8_ACCOUNT_ID ?? null, invoiceNumber: number, invoiceDate: String(inv.invoiceDate ?? '').slice(0, 10) || null });
          const checks = documentChecks(doc);
          const r = await store.importDocument({ ...doc, warnings: [...doc.warnings, `imported from the Pax8 API (invoice id ${inv.id})`] }, { sha256: sha256(JSON.stringify(items)), fileName: `pax8-api-invoice-${inv.id}`, format: 'api', by });
          results.push({ invoice: number, status: r.created ? 'imported' : 'already imported', lines: doc.lines.length, total: doc.lineTotal, vendorTotal: inv.total ?? null, matchesVendorTotal: inv.total == null ? null : Math.abs(Number(inv.total) - doc.lineTotal) < 0.02, subtotalMismatches: checks.subtotalMismatches.length });
        }
        return { result: { invoices: results, apiCalls: api.calls }, message: `${results.filter((x) => x.status === 'imported').length} Pax8 invoice(s) imported, ${results.filter((x) => x.status !== 'imported').length} already there (${api.calls} Pax8 API call(s)).` };
      }

      if (what === 'pricing') {
        const mappings = (await store.offeringMappings('pax8')).filter((m) => m.status === 'mapped');
        const skus = new Map(mappings.map((m) => [m.sku.toUpperCase(), m]));
        const products = (await api.all('/products', a.vendorName ? { vendorName: String(a.vendorName) } : {}, Number(a.maxPages) || 50)).filter((p) => skus.has(String(p.sku ?? '').toUpperCase()));
        const recorded: Array<Record<string, unknown>> = [];
        const today = new Date().toISOString().slice(0, 10);
        for (const p of products) {
          const m = skus.get(String(p.sku).toUpperCase())!;
          if (p.vendorSku && m.offeringId) await store.setManufacturerProductId(m.offeringId, String(p.vendorSku));
          const pricing = await api.get(`/products/${p.id}/pricing`);
          for (const entry of (Array.isArray(pricing?.content) ? pricing.content : Array.isArray(pricing) ? pricing : [])) {
            const cadence = pax8PricingCadence(entry);
            const rate = Array.isArray(entry.rates) ? entry.rates[0] : entry;
            if (!cadence || !rate) continue;
            const cost = rate.partnerBuyRate ?? rate.partnerBuyPrice ?? null, srp = rate.suggestedRetailPrice ?? null;
            await prices.upsert([{ vendor: 'pax8', sku: m.sku, cadence, unitCost: cost == null ? null : Number(cost), suggestedPrice: srp == null ? null : Number(srp), per: perOf(cadence), source: 'pax8_api', effectiveDate: today, by }]);
            recorded.push({ sku: m.sku, cadence, unitCost: cost, suggestedPrice: srp, vendorSku: p.vendorSku ?? null });
          }
        }
        return { result: { recorded, productsMatched: products.length, skusMapped: skus.size, apiCalls: api.calls }, message: `Recorded ${recorded.length} Pax8 price point(s) for ${products.length} of ${skus.size} mapped SKU(s) (${api.calls} Pax8 API call(s)). Rebuild the catalog plan to use them.` };
      }
      return { result: { status: 'invalid_value' }, message: 'what: status | invoices | pricing.' };
    }],
  ];
}
