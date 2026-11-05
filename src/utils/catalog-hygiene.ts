// Product-catalog hygiene primitives (#93, Phase A — read-only inspection).
//
// Pure/HTTP-free helpers a chat can drive through the MCP to SEE the catalog
// before changing anything: parse the productCategory picklist into a tree and
// flag dirty entries, find products with data gaps, and group likely duplicates.
//
// Categories live only as the Products.productCategory picklist (116 values,
// hierarchical by "Parent>Child>Grandchild" naming; not a REST entity), so the
// tree is derived from the label path convention.

export interface CategoryPick { value: number; label: string; isActive?: boolean }

export interface CategoryNode {
  value: number;
  label: string;
  /** last path segment — the category's own name */
  name: string;
  /** full path split on ">" */
  path: string[];
  depth: number;
  isActive: boolean;
  /** parent category value, if the parent path exists as its own picklist entry */
  parentValue: number | null;
  childValues: number[];
  /** label looks like a description, not a category name (dirty data to fix in the UI) */
  malformed: boolean;
  /** number of products in this category — populated only when counts are supplied */
  productCount?: number;
}

/** A category label that reads like a sentence/description rather than a name. */
export function isMalformedCategoryLabel(label: string): boolean {
  const name = label.split('>').pop()?.trim() ?? '';
  return label.length > 64 || name.length > 40 || /[.!?]\s/.test(name) || name.split(/\s+/).length > 6;
}

export function buildCategoryTree(
  picklist: CategoryPick[],
  counts?: Map<number, number>,
): { nodes: CategoryNode[]; roots: number[]; malformedCount: number } {
  const byPath = new Map<string, number>(); // joined lowercased path -> value
  const nodes: CategoryNode[] = picklist.map((p) => {
    const path = String(p.label).split('>').map((s) => s.trim()).filter(Boolean);
    byPath.set(path.map((s) => s.toLowerCase()).join('>'), p.value);
    return {
      value: p.value,
      label: p.label,
      name: path[path.length - 1] ?? p.label,
      path,
      depth: Math.max(0, path.length - 1),
      isActive: p.isActive !== false,
      parentValue: null,
      childValues: [],
      malformed: isMalformedCategoryLabel(p.label),
      ...(counts ? { productCount: counts.get(p.value) ?? 0 } : {}),
    };
  });
  const byValue = new Map<number, CategoryNode>(nodes.map((n) => [n.value, n]));
  const roots: number[] = [];
  for (const n of nodes) {
    if (n.path.length > 1) {
      const parentKey = n.path.slice(0, -1).map((s) => s.toLowerCase()).join('>');
      const pv = byPath.get(parentKey);
      if (pv != null && pv !== n.value) {
        n.parentValue = pv;
        byValue.get(pv)!.childValues.push(n.value);
        continue;
      }
    }
    roots.push(n.value);
  }
  return { nodes, roots, malformedCount: nodes.filter((n) => n.malformed).length };
}

// ---- catalog gaps ------------------------------------------------------------

export interface ProductLite {
  id: number;
  name?: string;
  description?: string;
  productCategory?: number | null;
  msrp?: number | null;
  unitPrice?: number | null;
  unitCost?: number | null;
  isActive?: boolean;
  sku?: string;
  manufacturerName?: string;
  manufacturerProductName?: string;
}

export interface CatalogGapsResult {
  scanned: number;
  gaps: {
    missingCategory: { count: number; sample: Array<{ id: number; name?: string }> };
    missingMsrp: { count: number; sample: Array<{ id: number; name?: string }> };
    weakDescription: { count: number; sample: Array<{ id: number; name?: string; reason: string }> };
  };
}

/** Products missing a category / MSRP / a usable description. A description is
 *  "weak" when empty, shorter than `minDescriptionLength`, or identical to the
 *  product name (adds no information). */
export function findCatalogGaps(
  products: ProductLite[],
  opts: { minDescriptionLength?: number; maxSamples?: number } = {},
): CatalogGapsResult {
  const minDesc = opts.minDescriptionLength ?? 10;
  const cap = opts.maxSamples ?? 25;
  const missingCategory: Array<{ id: number; name?: string }> = [];
  const missingMsrp: Array<{ id: number; name?: string }> = [];
  const weakDescription: Array<{ id: number; name?: string; reason: string }> = [];
  const ref = (p: ProductLite) => (p.name !== undefined ? { id: p.id, name: p.name } : { id: p.id });

  for (const p of products) {
    if (p.productCategory == null || p.productCategory === 0) missingCategory.push(ref(p));
    if (p.msrp == null || p.msrp === 0) missingMsrp.push(ref(p));
    const desc = (p.description ?? '').trim();
    let reason = '';
    if (desc === '') reason = 'empty';
    else if (desc.length < minDesc) reason = `too short (${desc.length} chars)`;
    else if (p.name && desc.toLowerCase() === p.name.trim().toLowerCase()) reason = 'same as name';
    if (reason) weakDescription.push({ ...ref(p), reason });
  }
  return {
    scanned: products.length,
    gaps: {
      missingCategory: { count: missingCategory.length, sample: missingCategory.slice(0, cap) },
      missingMsrp: { count: missingMsrp.length, sample: missingMsrp.slice(0, cap) },
      weakDescription: { count: weakDescription.length, sample: weakDescription.slice(0, cap) },
    },
  };
}

// ---- product search (Autotask's native search is poor) -----------------------

export interface SearchableProduct extends ProductLite {
  internalProductID?: string;
  externalProductID?: string;
  vendorProductNumber?: string;
}

export interface ProductMatch {
  id: number;
  name?: string;
  sku?: string;
  internalProductID?: string;
  manufacturerName?: string;
  manufacturerProductName?: string;
  vendorProductNumber?: string;
  isActive?: boolean;
  productCategory?: number | null;
  description?: string;
  /** Customer price, cost and list price — so a match can be priced without a second read. */
  unitPrice?: number | null;
  unitCost?: number | null;
  msrp?: number | null;
  score: number;
  matchedOn: string[];
}

/**
 * Normalized, multi-field product search — the clean layer over Autotask's weak
 * native search. Matches the query against every identifier (sku,
 * internalProductID, externalProductID, manufacturerProductName,
 * vendorProductNumber) plus name/description tokens, scores each product, and
 * returns the best matches. An exact identifier hit ranks highest; token overlap
 * on the name catches "cat6 keystone" → "Blue Cat6 Keystone".
 */
export function matchProducts(
  products: SearchableProduct[],
  query: string,
  opts: { limit?: number; activeOnly?: boolean } = {},
): ProductMatch[] {
  const q = norm(query);
  const qTokens = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (q === '' && qTokens.length === 0) return [];
  const idFields: Array<[keyof SearchableProduct, string]> = [
    ['sku', 'sku'], ['internalProductID', 'internalProductID'], ['externalProductID', 'externalProductID'],
    ['manufacturerProductName', 'manufacturerProductName'], ['vendorProductNumber', 'vendorProductNumber'],
  ];
  const out: ProductMatch[] = [];
  for (const p of products) {
    if (opts.activeOnly && p.isActive === false) continue;
    let score = 0;
    const matchedOn: string[] = [];
    for (const [field, label] of idFields) {
      const v = norm(p[field] as string | undefined);
      if (!v) continue;
      if (v === q) { score += 100; matchedOn.push(`${label} (exact)`); }
      else if (q.length >= 3 && (v.includes(q) || q.includes(v))) { score += 55; matchedOn.push(label); }
    }
    // Name / description token overlap.
    const nameNorm = norm(p.name);
    if (q.length >= 3 && nameNorm.includes(q)) { score += 45; matchedOn.push('name'); }
    else if (qTokens.length) {
      const hay = `${(p.name ?? '').toLowerCase()} ${(p.description ?? '').toLowerCase()}`;
      const hit = qTokens.filter((tk) => hay.includes(tk)).length;
      if (hit > 0) { score += Math.round((hit / qTokens.length) * 40); if (!matchedOn.includes('name')) matchedOn.push(hit === qTokens.length ? 'name (all tokens)' : 'name (partial)'); }
    }
    if (score > 0) {
      out.push({
        id: p.id, score, matchedOn,
        ...(p.name !== undefined ? { name: p.name } : {}),
        ...(p.sku !== undefined ? { sku: p.sku } : {}),
        ...(p.internalProductID !== undefined ? { internalProductID: p.internalProductID } : {}),
        ...(p.manufacturerName !== undefined ? { manufacturerName: p.manufacturerName } : {}),
        ...(p.manufacturerProductName !== undefined ? { manufacturerProductName: p.manufacturerProductName } : {}),
        ...(p.vendorProductNumber !== undefined ? { vendorProductNumber: p.vendorProductNumber } : {}),
        ...(p.isActive !== undefined ? { isActive: p.isActive } : {}),
        ...(p.productCategory !== undefined ? { productCategory: p.productCategory } : {}),
        ...(p.description !== undefined ? { description: p.description } : {}),
        ...(p.unitPrice !== undefined ? { unitPrice: p.unitPrice } : {}),
        ...(p.unitCost !== undefined ? { unitCost: p.unitCost } : {}),
        ...(p.msrp !== undefined ? { msrp: p.msrp } : {}),
      });
    }
  }
  out.sort((a, b) => b.score - a.score || a.id - b.id);
  return out.slice(0, opts.limit ?? 25);
}

// ---- write planning (Phase B, dry-run-first) --------------------------------

export interface BulkUpdateItem {
  id: number;
  found: boolean;
  changes: Record<string, { from: unknown; to: unknown }>;
  /** true when the product exists but every supplied field already matches */
  noop: boolean;
}
export interface BulkUpdatePlan {
  items: BulkUpdateItem[];
  totalWithChanges: number;
  totalChangedFields: number;
  notFound: number[];
}

const PRODUCT_UPDATABLE = new Set([
  'name', 'description', 'sku', 'internalProductID', 'manufacturerName', 'manufacturerProductName',
  'vendorProductNumber', 'productCategory', 'unitCost', 'unitPrice', 'msrp', 'isActive', 'isSerialized', 'link', 'defaultVendorID',
]);

/**
 * Diff each requested product patch against current values (pure). Only fields
 * that actually change are kept, so a dry run shows exactly what would be written
 * and no-ops are skipped. Unknown/immutable fields are ignored.
 */
export function planBulkProductUpdate(
  current: Map<number, Record<string, any>>,
  updates: Array<Record<string, any> & { id: number }>,
): BulkUpdatePlan {
  const items: BulkUpdateItem[] = [];
  const notFound: number[] = [];
  let totalChangedFields = 0;
  for (const u of updates) {
    const cur = current.get(u.id);
    if (!cur) { notFound.push(u.id); items.push({ id: u.id, found: false, changes: {}, noop: false }); continue; }
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, v] of Object.entries(u)) {
      if (k === 'id' || !PRODUCT_UPDATABLE.has(k)) continue;
      if (cur[k] !== v) changes[k] = { from: cur[k] ?? null, to: v };
    }
    totalChangedFields += Object.keys(changes).length;
    items.push({ id: u.id, found: true, changes, noop: Object.keys(changes).length === 0 });
  }
  return { items, totalWithChanges: items.filter((i) => i.found && !i.noop).length, totalChangedFields, notFound };
}

/** Fields a merge copies onto the survivor when the survivor is missing them. */
export const MERGE_ENRICH_FIELDS = ['description', 'msrp', 'productCategory', 'manufacturerName', 'manufacturerProductName', 'vendorProductNumber', 'unitCost', 'unitPrice', 'link'];

export interface MergePlan {
  survivorId: number;
  survivorPatch: Record<string, { from: unknown; to: unknown }>;
  deactivate: number[];
  /** duplicates that still hold stock — reconcile counts before deactivating */
  onHandWarnings: Array<{ id: number; onHand: number }>;
}

/**
 * Plan a duplicate merge (pure): enrich the survivor with fields it lacks from
 * the duplicates (first non-empty wins), and list the duplicates to deactivate.
 * Duplicates with on-hand stock are flagged so counts can be moved first — this
 * never auto-moves inventory.
 */
export function planProductMerge(
  survivor: Record<string, any>,
  duplicates: Array<Record<string, any>>,
  onHandByProductId: Map<number, number>,
  opts: { enrichSurvivor?: boolean } = {},
): MergePlan {
  const survivorPatch: Record<string, { from: unknown; to: unknown }> = {};
  if (opts.enrichSurvivor !== false) {
    for (const f of MERGE_ENRICH_FIELDS) {
      const has = survivor[f] != null && survivor[f] !== '' && survivor[f] !== 0;
      if (has) continue;
      const donor = duplicates.find((d) => d[f] != null && d[f] !== '' && d[f] !== 0);
      if (donor) survivorPatch[f] = { from: survivor[f] ?? null, to: donor[f] };
    }
  }
  const onHandWarnings: Array<{ id: number; onHand: number }> = [];
  for (const d of duplicates) {
    const oh = onHandByProductId.get(d.id) ?? 0;
    if (oh > 0) onHandWarnings.push({ id: d.id, onHand: oh });
  }
  return { survivorId: survivor.id, survivorPatch, deactivate: duplicates.map((d) => d.id), onHandWarnings };
}

// ---- duplicate detection -----------------------------------------------------

export interface DupGroup {
  matchKey: 'sku' | 'manufacturerProductName' | 'name';
  keyValue: string;
  members: Array<{ id: number; name?: string; sku?: string; isActive?: boolean; productCategory?: number | null; msrp?: number | null; description?: string }>;
  /** the member best kept (active, most complete, then lowest id); merge others into it */
  suggestedSurvivorId: number;
}

const norm = (s?: string): string => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** A product's strongest identifier for grouping: sku, else manufacturer product
 *  name, else name. Non-overlapping groups (each product counted once). */
function primaryKey(p: ProductLite): { type: DupGroup['matchKey']; value: string } | null {
  if (norm(p.sku)) return { type: 'sku', value: norm(p.sku) };
  if (norm(p.manufacturerProductName)) return { type: 'manufacturerProductName', value: norm(p.manufacturerProductName) };
  if (norm(p.name)) return { type: 'name', value: norm(p.name) };
  return null;
}

function completeness(p: ProductLite): number {
  return (p.description ? 1 : 0) + (p.msrp ? 1 : 0) + (p.productCategory ? 1 : 0);
}

/** Group products that share a normalized identifier into duplicate candidates,
 *  each with a suggested survivor (active > most complete > lowest id). */
export function findDuplicateProducts(products: ProductLite[]): DupGroup[] {
  const buckets = new Map<string, ProductLite[]>();
  for (const p of products) {
    const k = primaryKey(p);
    if (!k) continue;
    const key = `${k.type}:${k.value}`;
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(p);
  }
  const groups: DupGroup[] = [];
  for (const [key, members] of buckets) {
    if (members.length < 2) continue;
    const [matchKey, keyValue] = [key.slice(0, key.indexOf(':')) as DupGroup['matchKey'], key.slice(key.indexOf(':') + 1)];
    const survivor = [...members].sort((a, b) =>
      Number(b.isActive !== false) - Number(a.isActive !== false) ||
      completeness(b) - completeness(a) ||
      a.id - b.id,
    )[0];
    groups.push({
      matchKey,
      keyValue,
      members: members.map((m) => ({
        id: m.id,
        ...(m.name !== undefined ? { name: m.name } : {}),
        ...(m.sku !== undefined ? { sku: m.sku } : {}),
        ...(m.isActive !== undefined ? { isActive: m.isActive } : {}),
        ...(m.productCategory !== undefined ? { productCategory: m.productCategory } : {}),
        ...(m.msrp !== undefined ? { msrp: m.msrp } : {}),
      })),
      suggestedSurvivorId: survivor.id,
    });
  }
  // Most-duplicated first.
  groups.sort((a, b) => b.members.length - a.members.length);
  return groups;
}
