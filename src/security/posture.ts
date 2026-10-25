// Security posture: what this instance exposes and who it trusts, as a checklist for the console (zero trust).

import { settingValue } from '../admin/settings.js';
import { getImpersonationMode } from '../utils/request-context.js';
import { isPermissionsEnabled } from '../utils/permissions.js';
import { corsOrigins } from './http.js';

export type CheckStatus = 'ok' | 'warn' | 'bad' | 'info';
export interface PostureCheck { id: string; label: string; status: CheckStatus; detail: string; fix?: string }
export interface PostureInput { pgEnabled: boolean; activeTokens: number | null; env?: NodeJS.ProcessEnv }

const on = (v: unknown) => String(v ?? '').toLowerCase() === 'true';

/** The checklist, worst first. */
export function securityPosture(i: PostureInput): PostureCheck[] {
  const env = i.env ?? process.env;
  const out: PostureCheck[] = [];
  const requireToken = settingValue<boolean>('security.requireMcpToken', env) === true;
  out.push(requireToken
    ? { id: 'mcp-token', label: 'MCP endpoint', status: 'ok', detail: `Every call needs a valid access token (${i.activeTokens ?? '?'} active).` }
    : { id: 'mcp-token', label: 'MCP endpoint', status: 'bad', detail: 'No access token required: anyone who can reach the MCP port can call every tool. Only the network (tunnel, firewall) protects it.', fix: 'Create a token per client on the Access page, give it to n8n / your scripts, then turn on Settings → Security → Require an access token.' });
  if (requireToken && !i.pgEnabled) out.push({ id: 'mcp-token-pg', label: 'Access tokens', status: 'bad', detail: 'Tokens are required but Postgres is off, so every call is refused.', fix: 'Enable the Postgres layer (MCP_PG_ENABLED) or turn the requirement off.' });

  const trustUnverified = settingValue<boolean>('security.trustUnverifiedIdentity', env) === true;
  const imp = getImpersonationMode();
  if (imp === 'caller' && trustUnverified) {
    out.push({ id: 'identity', label: 'Who a call runs as', status: 'bad', detail: 'Caller impersonation trusts the email a client declares: any client can write to Autotask as any technician.', fix: 'Turn off Settings → Security → Trust identities a client declares, and give person-bound or delegate tokens to the clients that act for people.' });
  } else {
    out.push({ id: 'identity', label: 'Who a call runs as', status: 'ok', detail: imp === 'caller' ? 'Writes run as a person only when an access token vouches for them; otherwise as the API user.' : 'Impersonation is off: every write runs as the API user.' });
  }

  out.push(isPermissionsEnabled(env)
    ? { id: 'roles', label: 'Role permissions', status: 'ok', detail: 'Mutations are limited by each caller\'s role.' }
    : { id: 'roles', label: 'Role permissions', status: 'warn', detail: 'Role gating is off: every caller may use every enabled tool, up to the API user\'s own Autotask permissions.', fix: 'Map roles (AUTOTASK_ROLE_MAP) and set MCP_PERMISSIONS_ENABLED=true; or keep the API user\'s security level minimal.' });

  const rawDelete = on(env.MCP_RAW_ALLOW_DELETE), rawReadonly = on(env.MCP_RAW_READONLY);
  out.push(rawDelete
    ? { id: 'raw', label: 'Raw API requests', status: 'warn', detail: 'autotask_raw_request may DELETE any record.', fix: 'Unset MCP_RAW_ALLOW_DELETE; use the typed delete tools (they are checked and audited).' }
    : { id: 'raw', label: 'Raw API requests', status: rawReadonly ? 'ok' : 'info', detail: rawReadonly ? 'autotask_raw_request is read-only.' : 'autotask_raw_request can create and update (not delete).', ...(rawReadonly ? {} : { fix: 'Set MCP_RAW_READONLY=true to allow only GET, or disable the tool group.' }) });

  out.push(settingValue<boolean>('tools.writesEnabled', env) === false
    ? { id: 'writes', label: 'Write tools', status: 'info', detail: 'Read-only: no tool can change Autotask.' }
    : { id: 'writes', label: 'Write tools', status: 'info', detail: 'Write tools are on; what they can change is bounded by the API user\'s Autotask security level.' });

  const cors = corsOrigins(env);
  out.push({ id: 'cors', label: 'Browser access (CORS)', status: 'ok', detail: cors.length ? `Only these web origins may call /mcp from a browser: ${cors.join(', ')} (MCP_CORS_ORIGINS).` : 'No web page may call /mcp from a browser (MCP_CORS_ORIGINS=none).' });
  out.push({ id: 'health', label: 'Public health check', status: 'ok', detail: 'From outside the host, /health answers only status and version.' });
  out.push((env.AUTOTASK_WEBHOOK_SECRET ?? '').trim()
    ? { id: 'webhook', label: 'Webhook receiver', status: 'ok', detail: 'Autotask webhooks are accepted only with a valid signature.' }
    : { id: 'webhook', label: 'Webhook receiver', status: 'info', detail: 'No webhook secret: the receiver refuses every webhook.' });

  const rank: Record<CheckStatus, number> = { bad: 0, warn: 1, info: 2, ok: 3 };
  return out.sort((a, b) => rank[a.status] - rank[b.status]);
}
