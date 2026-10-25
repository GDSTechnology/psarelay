// Setup check: is this PSArelay instance connected and allowed to do what its modules need?
//
// The most common way a setup goes wrong is the Autotask API user's security level: a tool fails mid-task with
// "insufficient permissions". This check probes READ access live — one tiny query per entity, straight to
// Autotask (noCache: never answered by the mirror or the cache) — and lists, per module, what is readable, what
// isn't, and the write access each module will need (writes can't be probed without writing; they are named so
// the security level can be set up front). ~30 Autotask calls; run it at setup and after changing the user.

export type Op = 'read' | 'create' | 'update';
export interface ModuleNeed { entity: string; ops: Op[]; why: string }
export interface ModuleSpec { id: string; name: string; needs: ModuleNeed[] }

/** What each module reads and writes in Autotask. */
export const MODULES: ModuleSpec[] = [
  { id: 'core', name: 'Service desk & time', needs: [
    { entity: 'Tickets', ops: ['read', 'create', 'update'], why: 'search, create and update tickets' },
    { entity: 'TicketNotes', ops: ['read', 'create'], why: 'ticket notes' },
    { entity: 'TimeEntries', ops: ['read', 'create', 'update'], why: 'time entries' },
    { entity: 'Companies', ops: ['read', 'update'], why: 'company lookups and updates' },
    { entity: 'Contacts', ops: ['read', 'create', 'update'], why: 'contacts' },
    { entity: 'Resources', ops: ['read'], why: 'technicians and names' },
    { entity: 'Projects', ops: ['read'], why: 'projects' },
    { entity: 'Tasks', ops: ['read'], why: 'project tasks' },
    { entity: 'ConfigurationItems', ops: ['read'], why: 'devices / CIs' },
    { entity: 'ServiceCalls', ops: ['read'], why: 'dispatch' },
    { entity: 'CompanyToDos', ops: ['read'], why: 'to-dos' },
  ] },
  { id: 'contracts', name: 'Contracts & financial', needs: [
    { entity: 'Contracts', ops: ['read', 'create', 'update'], why: 'contracts' },
    { entity: 'ContractServices', ops: ['read', 'update'], why: 'contract lines' },
    { entity: 'ContractServiceUnits', ops: ['read'], why: 'verifying contract changes by effect' },
    { entity: 'ContractCharges', ops: ['read', 'create'], why: 'contract charges' },
    { entity: 'Services', ops: ['read'], why: 'the service catalog' },
    { entity: 'BillingCodes', ops: ['read'], why: 'billing codes' },
    { entity: 'Quotes', ops: ['read'], why: 'quotes' },
    { entity: 'Opportunities', ops: ['read'], why: 'opportunities' },
  ] },
  { id: 'billing', name: 'Billing & reports', needs: [
    { entity: 'BillingItems', ops: ['read'], why: 'what was posted and invoiced' },
    { entity: 'Invoices', ops: ['read'], why: 'invoices and their paid date' },
    { entity: 'TicketCharges', ops: ['read', 'create'], why: 'ticket charges' },
    { entity: 'ProjectCharges', ops: ['read'], why: 'project charges' },
  ] },
  { id: 'vendor', name: 'Vendor billing reconciliation', needs: [
    { entity: 'Products', ops: ['read', 'create', 'update'], why: 'the product catalog' },
    { entity: 'Services', ops: ['read', 'create', 'update'], why: 'standardising services' },
    { entity: 'ContractServices', ops: ['read', 'update'], why: 'contract lines' },
  ] },
  { id: 'cleanup', name: 'Merges & bulk cleanup', needs: [
    { entity: 'Companies', ops: ['read', 'update'], why: 'inactivating placeholder companies' },
    { entity: 'Contacts', ops: ['read', 'update'], why: 'inactivating junk contacts' },
  ] },
  { id: 'commerce', name: 'Commerce (orders)', needs: [
    { entity: 'Companies', ops: ['read', 'create'], why: 'new customers' },
    { entity: 'Contacts', ops: ['read', 'create'], why: 'their users' },
    { entity: 'Contracts', ops: ['read', 'create'], why: 'recurring contracts' },
    { entity: 'Tickets', ops: ['read', 'create'], why: 'delivery tickets' },
    { entity: 'TicketCharges', ops: ['read', 'create'], why: 'one-time charges' },
    { entity: 'BillingItems', ops: ['read'], why: 'tracking to the invoice' },
    { entity: 'Invoices', ops: ['read'], why: 'tracking to payment' },
  ] },
];

export type ProbeOutcome = 'ok' | 'denied' | 'unavailable' | 'error';
export interface Probe { entity: string; outcome: ProbeOutcome; detail?: string }

/** Classify a failed read probe. */
export function classifyProbeError(e: unknown): { outcome: ProbeOutcome; detail: string; stop?: boolean } {
  const msg = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  const st = (e as { status?: number })?.status;
  if (st === 401 || /\b401\b|unauthori[sz]ed|login/i.test(msg)) return { outcome: 'error', detail: `login rejected: ${msg}`, stop: true };
  if (st === 429 || /\b429\b|threshold exceeded|cooldown/i.test(msg)) return { outcome: 'error', detail: `Autotask is throttling: ${msg}`, stop: true };
  if (st === 403 || /permission|not authori[sz]ed|access denied|security level|insufficient/i.test(msg)) return { outcome: 'denied', detail: msg };
  if (st === 404 || /not found|does not exist|unknown entity/i.test(msg)) return { outcome: 'unavailable', detail: msg };
  return { outcome: 'error', detail: msg };
}

export interface ModuleResult {
  id: string; name: string; status: 'ready' | 'blocked' | 'unknown';
  readable: string[]; denied: Array<{ entity: string; detail?: string }>; unchecked: Array<{ entity: string; detail?: string }>;
  /** Write access the security level must also grant (not probed). */
  writes: Array<{ entity: string; ops: Op[]; why: string }>;
}

/** Fold per-entity probes into per-module results. */
export function moduleResults(probes: Map<string, Probe>, modules: ModuleSpec[] = MODULES): ModuleResult[] {
  return modules.map((m) => {
    const readable: string[] = [], denied: ModuleResult['denied'] = [], unchecked: ModuleResult['unchecked'] = [];
    for (const n of m.needs) {
      const p = probes.get(n.entity);
      if (!p) { unchecked.push({ entity: n.entity, detail: 'not probed' }); continue; }
      if (p.outcome === 'ok') { if (!readable.includes(n.entity)) readable.push(n.entity); }
      else if (p.outcome === 'denied') denied.push({ entity: n.entity, ...(p.detail ? { detail: p.detail } : {}) });
      else unchecked.push({ entity: n.entity, ...(p.detail ? { detail: p.detail } : {}) });
    }
    const writes = m.needs.filter((n) => n.ops.some((o) => o !== 'read')).map((n) => ({ entity: n.entity, ops: n.ops.filter((o) => o !== 'read'), why: n.why }));
    return { id: m.id, name: m.name, status: denied.length ? 'blocked' : unchecked.length ? 'unknown' : 'ready', readable, denied, unchecked, writes };
  });
}

export interface ProbeFn { (entity: string): Promise<void> }

/** Probe every entity the modules need (once each), stopping on a login problem or throttling. */
export async function probeEntities(probe: ProbeFn, modules: ModuleSpec[] = MODULES): Promise<{ probes: Map<string, Probe>; stopped?: string }> {
  const entities = [...new Set(modules.flatMap((m) => m.needs.map((n) => n.entity)))];
  const probes = new Map<string, Probe>();
  for (const entity of entities) {
    try { await probe(entity); probes.set(entity, { entity, outcome: 'ok' }); }
    catch (e) {
      const c = classifyProbeError(e);
      probes.set(entity, { entity, outcome: c.outcome, detail: c.detail });
      if (c.stop) return { probes, stopped: c.detail };
    }
  }
  return { probes };
}

/** How to connect AI clients to this instance's MCP endpoint. */
export function connectionGuide(mcpUrl: string): Array<{ client: string; how: string }> {
  return [
    { client: 'ChatGPT', how: `Settings → Connectors → Create → URL ${mcpUrl}, Authentication OAuth → sign in with your console login (console → Connect). After a PSArelay update, ask ChatGPT to refresh its tool list.` },
    { client: 'Claude Desktop / claude.ai', how: `Settings → Connectors → Add custom connector → ${mcpUrl} → Connect → sign in with your console login.` },
    { client: 'Codex', how: `codex mcp add psarelay --url ${mcpUrl}, then codex mcp login psarelay (signs in with your console login).` },
    { client: 'Claude Code', how: `claude mcp add --transport http psarelay ${mcpUrl} — then /mcp to sign in.` },
    { client: 'n8n', how: `MCP Client node (or HTTP Request) → ${mcpUrl}; header Authorization: Bearer <token> (create one on the Access page); call tools/call with the tool name and arguments. Use autotask_get_backpressure before bulk work.` },
  ];
}
