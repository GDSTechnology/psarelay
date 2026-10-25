// Run the setup check against this instance: connection + API user, live permission probes per module,
// mirror backfill progress, and how to connect AI clients. Shared by the tool and the console's Setup page.

import type { AutotaskService } from '../services/autotask.service.js';
import { getShadowRuntime } from '../db/shadow-runtime.js';
import { MODULES, connectionGuide, moduleResults, probeEntities, type ModuleResult, type Probe } from './check.js';

export interface SetupReport {
  at: string;
  connection: { ok: boolean; detail: string; apiUser: { id: number | null; name: string | null } | null; usage: { usedPct: number | null; used: number | null; limit: number | null } | null; webUrl: string | null };
  modules: ModuleResult[];
  probes: Probe[];
  stopped: string | null;
  mirror: { enabled: boolean; ready: number; total: number; entities: Array<{ entity: string; rows: number; ready: boolean }> } | null;
  connect: { mcpUrl: string; clients: Array<{ client: string; how: string }> };
}

let last: SetupReport | null = null;
export const lastSetupReport = () => last;

/** The MCP endpoint clients connect to: MCP_PUBLIC_URL, else the local HTTP port. */
export function mcpUrl(env: NodeJS.ProcessEnv = process.env): string {
  const pub = String(env.MCP_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
  if (pub) return /\/mcp$/.test(pub) ? pub : `${pub}/mcp`;
  return `http://<this-host>:${env.MCP_HTTP_PORT || '8080'}/mcp`;
}

export async function runSetupCheck(s: AutotaskService, o: { modules?: string[] } = {}): Promise<SetupReport> {
  const modules = o.modules?.length ? MODULES.filter((m) => o.modules!.includes(m.id)) : MODULES;
  const connection: SetupReport['connection'] = { ok: false, detail: '', apiUser: null, usage: null, webUrl: null };
  let probes = new Map<string, Probe>(); let stopped: string | null = null;
  try {
    const http = await s.httpClient();
    // Usage first: proves the login and the zone with one call.
    const u = await s.getApiUsage();
    if ('error' in u.autotask) throw new Error(u.autotask.error);
    connection.usage = { usedPct: u.autotask.usedPct, used: u.autotask.used, limit: u.autotask.limit };
    const id = await s.resolveApiUserResourceId().catch(() => null);
    let name: string | null = null;
    if (id != null) { const r = await http.get<Record<string, unknown>>('Resources', id).catch(() => null); name = r ? `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim() || null : null; }
    connection.apiUser = { id, name };
    connection.webUrl = s.getRecordWebUrl('company', 0)?.replace(/\?.*$/, '') ?? null;
    connection.ok = true; connection.detail = 'Signed in to Autotask.';
    // Live read probes — noCache: straight to Autotask, never the mirror or the cache.
    const r = await probeEntities((entity) => http.query(entity, [{ op: 'gt', field: 'id', value: 0 }] as never, { maxRecords: 1, includeFields: ['id'], noCache: true }).then(() => undefined), modules);
    probes = r.probes; stopped = r.stopped ?? null;
  } catch (e) {
    connection.detail = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  }
  const rt = getShadowRuntime();
  let mirror: SetupReport['mirror'] = null;
  if (rt) {
    const states = await rt.store.allStates().catch(() => [] as Array<Record<string, any>>);
    const entities = states.map((x: Record<string, any>) => ({ entity: String(x.entity), rows: Number(x.row_count ?? 0), ready: !!x.backfill_done }));
    mirror = { enabled: true, ready: entities.filter((x) => x.ready).length, total: entities.length, entities };
  }
  const url = mcpUrl();
  last = { at: new Date().toISOString(), connection, modules: moduleResults(probes, modules), probes: [...probes.values()], stopped, mirror, connect: { mcpUrl: url, clients: connectionGuide(url) } };
  return last;
}

/** One-line summary for a tool message. */
export function setupSummary(r: SetupReport): string {
  if (!r.connection.ok) return `Not connected to Autotask: ${r.connection.detail}`;
  const by = (st: string) => r.modules.filter((m) => m.status === st).map((m) => m.name);
  return `Connected as ${r.connection.apiUser?.name ?? `resource ${r.connection.apiUser?.id ?? '?'}`} (API usage ${r.connection.usage?.usedPct ?? '?'}%). Ready: ${by('ready').join(', ') || 'none'}.${by('blocked').length ? ` BLOCKED (no read access): ${by('blocked').join(', ')}.` : ''}${by('unknown').length ? ` Not fully checked: ${by('unknown').join(', ')}.` : ''}${r.stopped ? ` Stopped early: ${r.stopped}.` : ''}${r.mirror ? ` Mirror: ${r.mirror.ready}/${r.mirror.total} entities backfilled.` : ''}`;
}
