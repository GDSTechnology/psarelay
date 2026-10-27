// Caller → Autotask resource resolution (Expansion Spec §4.1).
//
// A caller's login (Teams/ChatGPT/Telegram email or handle) must resolve to an
// Autotask resource before it can drive permissions or be used as the acting /
// proxy resource for data input. If it can't be resolved unambiguously, the
// caller is prompted to identify themselves rather than the MCP guessing.

import { CallerContext } from '../types/context';

export interface ResolvedResource {
  id: number;
  name: string;
  email?: string;
}

export interface ResourceCandidate {
  id: number;
  name: string;
  email?: string;
}

export type ResolveVia = 'explicit-id' | 'explicit-email' | 'explicit-name' | 'token' | 'static-map' | 'email-match' | 'cache';

export type CallerResolution =
  | { status: 'resolved'; via: ResolveVia; resource: ResolvedResource }
  | {
      status: 'user_identification_required';
      reason: 'no-identity' | 'not-found' | 'ambiguous';
      providedEmail?: string;
      candidates?: ResourceCandidate[];
      message: string;
    };

/**
 * Parse AUTOTASK_USER_MAP — JSON mapping an external identity key to an Autotask
 * resource id, for identities that don't match a resource email (e.g. Telegram
 * handles). Keys are lowercased. Supported forms:
 *   "jane@example.com": 123            (email)
 *   "telegram:jdoe": 456               (source:handle)
 *   "hermes-teams:<entra-guid>": 789   (source:teamsObjectId)
 */
export function parseUserMap(raw: string | undefined): Map<string, number> {
  const map = new Map<string, number>();
  if (!raw) return map;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        const id = typeof v === 'number' ? v : Number.parseInt(String(v), 10);
        if (Number.isFinite(id)) map.set(String(k).trim().toLowerCase(), id);
      }
    }
  } catch {
    /* ignore malformed map */
  }
  return map;
}

/** Lookup keys for a caller, most specific first (email, then source:objectId). */
export function callerMapKeys(ctx: CallerContext): string[] {
  const keys: string[] = [];
  if (ctx.requestingUserEmail) keys.push(ctx.requestingUserEmail.toLowerCase());
  if (ctx.teamsObjectId) keys.push(`${ctx.source}:${ctx.teamsObjectId}`.toLowerCase());
  if (ctx.conversationId) keys.push(`${ctx.source}:${ctx.conversationId}`.toLowerCase());
  return keys;
}

export function resourceDisplayName(r: {
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
}): string {
  const n = [r.firstName, r.lastName].filter(Boolean).join(' ').trim();
  return n || r.name || r.email || 'Unknown';
}

/** Build the structured "identify yourself" response the client surfaces to the human. */
export function identificationRequired(
  reason: 'no-identity' | 'not-found' | 'ambiguous',
  opts: { providedEmail?: string; candidates?: ResourceCandidate[] } = {}
): Extract<CallerResolution, { status: 'user_identification_required' }> {
  const base = {
    status: 'user_identification_required' as const,
    reason,
    ...(opts.providedEmail !== undefined ? { providedEmail: opts.providedEmail } : {}),
    ...(opts.candidates !== undefined ? { candidates: opts.candidates } : {}),
  };
  let message: string;
  if (reason === 'no-identity') {
    message = 'No caller identity was provided. Tell me who you are in Autotask — your name, email, or resource ID — so I can act on your behalf and apply your permissions.';
  } else if (reason === 'ambiguous') {
    message = `Your email${opts.providedEmail ? ` (${opts.providedEmail})` : ''} matched more than one Autotask resource. Pick which one you are (by id) from the candidates.`;
  } else {
    message = `I couldn't match ${opts.providedEmail ? opts.providedEmail : 'your login'} to an Autotask resource. Tell me your Autotask name or resource ID, or ask an admin to add you to AUTOTASK_USER_MAP.`;
  }
  return { ...base, message };
}

/**
 * Tools where `currentUser: true` means "act as me" — the field the resolved
 * caller resource id is written into (proxy data input, §4.1/§9). Ticket
 * assignment (#42) also needs a role; the role field is auto-filled separately
 * via ACTING_ROLE_FIELDS.
 */
export const ACTING_RESOURCE_TOOLS: Record<string, string> = {
  autotask_create_time_entry: 'resourceID',
  autotask_create_company_todo: 'assignedToResourceID',
  autotask_update_company_todo: 'assignedToResourceID',
  autotask_create_ticket: 'assignedResourceID',
  autotask_update_ticket: 'assignedResourceID',
  autotask_log_my_time: 'resourceID',
  autotask_get_my_day: 'resourceID',
  autotask_start_work_on_ticket: 'resourceID',
  autotask_add_ticket_update: 'resourceID',
};

/**
 * Tools that default to "act as the calling user" when no resource is named —
 * `currentUser` is set to true if the caller passed neither the resource field
 * nor an explicit currentUser (#42 slice 3). These are the "my" ergonomics.
 */
export const CURRENT_USER_DEFAULT_TOOLS: Record<string, string> = {
  autotask_log_my_time: 'resourceID',
  autotask_get_my_day: 'resourceID',
  autotask_start_work_on_ticket: 'resourceID',
  autotask_add_ticket_update: 'resourceID',
};

/**
 * Tools where setting the resource field also requires a role (#42). When the
 * resource field is populated (via currentUser or explicitly) and the role field
 * is empty, the role is auto-filled from the resource's default role
 * (Resources.defaultServiceDeskRoleID); an explicitly-passed role always wins.
 */
export const ACTING_ROLE_FIELDS: Record<string, { resourceField: string; roleField: string }> = {
  autotask_create_ticket: { resourceField: 'assignedResourceID', roleField: 'assignedResourceRoleID' },
  autotask_update_ticket: { resourceField: 'assignedResourceID', roleField: 'assignedResourceRoleID' },
  autotask_create_time_entry: { resourceField: 'resourceID', roleField: 'roleID' },
  autotask_log_my_time: { resourceField: 'resourceID', roleField: 'roleID' },
};

/** Classify the outcome of an exact-email Resources search. */
export function classifyEmailMatch(
  providedEmail: string | undefined,
  candidates: ResourceCandidate[]
): CallerResolution {
  if (!providedEmail) return identificationRequired('no-identity');
  if (candidates.length === 1) {
    const c = candidates[0];
    return {
      status: 'resolved',
      via: 'email-match',
      resource: { id: c.id, name: c.name, ...(c.email !== undefined ? { email: c.email } : {}) },
    };
  }
  if (candidates.length === 0) return identificationRequired('not-found', { providedEmail });
  return identificationRequired('ambiguous', { providedEmail, candidates });
}
