// Per-request context carried across async calls (#42 native impersonation).
//
// Autotask supports acting "on behalf of" a standard user via the
// `ImpersonationResourceId` header on the outbound REST call — the integration
// (API) user tunnels the write so Autotask attributes it to that resource
// (createdByResourceID / last-modified-by / audit), even though standard users
// have no API access.
//
// The acting resource id is resolved once per tool call (from the caller's
// identity) and must reach AutotaskHttpClient.headers() without threading it
// through every method signature — and without leaking between concurrent
// requests that share one client (env mode). AsyncLocalStorage gives us exactly
// that: a store scoped to the async execution of one tool dispatch.
//
// The same store also carries the transport-derived request origin (captured at
// the HTTP entry) so audit logging can attribute the calling container without
// threading `req` through the whole stack.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { CallerSource } from '../types/context.js';
import type { RequestOrigin } from './origin.js';
import type { TokenAuth } from '../security/tokens.js';

export interface RequestContext {
  /** Autotask resource id to impersonate on outbound writes, if any. */
  impersonationResourceId?: number;
  /** Transport-derived origin of the request (server-captured, never from client). */
  origin?: RequestOrigin;
  /** The verified access token this request carried, if any (server-checked, never from client). */
  auth?: TokenAuth;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with the given per-request context in scope. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The impersonation resource id for the current async context, if set. */
export function getImpersonationResourceId(): number | undefined {
  return storage.getStore()?.impersonationResourceId;
}

/** The verified access token of the current request, if it carried one. */
export function getRequestAuth(): TokenAuth | undefined {
  return storage.getStore()?.auth;
}

/** The transport-derived origin for the current async context, if captured. */
export function getRequestOrigin(): RequestOrigin | undefined {
  return storage.getStore()?.origin;
}

/**
 * The deployment's impersonation posture — deliberately per-instance so an
 * operator can run one MCP container per consumer class and set the policy in
 * that container's env, rather than trusting a client-declared field:
 *
 *   off      never impersonate (e.g. the n8n / cron integration instance)
 *   caller   resolve the calling user and tunnel writes as them, degrading to
 *            the integration user when unidentified (the ChatGPT / Teams instance)
 *
 * Legacy compatibility: AUTOTASK_IMPERSONATION=on/true/1/yes (with no MODE set)
 * maps to `caller`; off/unset maps to `off`.
 */
export type ImpersonationMode = 'off' | 'caller';

export function getImpersonationMode(): ImpersonationMode {
  const mode = (process.env.AUTOTASK_IMPERSONATION_MODE || '').trim().toLowerCase();
  if (mode === 'off' || mode === 'caller') return mode;
  // Any other explicit value (the removed hosted-gateway mode included) fails closed.
  if (mode) return 'off';
  // Fall back to the legacy on/off flag when MODE isn't set.
  const legacy = (process.env.AUTOTASK_IMPERSONATION || '').trim().toLowerCase();
  if (legacy === 'on' || legacy === 'true' || legacy === '1' || legacy === 'yes') return 'caller';
  return 'off';
}

/**
 * Whether native Autotask impersonation is active at all for this deployment
 * (any mode other than `off`). Kept for call sites that only need the on/off
 * distinction; the API user's security level must permit impersonation, so it
 * stays inert until an operator opts in.
 */
export function isImpersonationEnabled(): boolean {
  return getImpersonationMode() !== 'off';
}

/**
 * In `caller` mode, optionally restrict which declared sources may impersonate.
 * AUTOTASK_IMPERSONATION_SOURCES is a comma-separated allowlist (e.g.
 * "chatgpt,hermes-teams"); unset means every source may impersonate. This is
 * defense-in-depth on top of per-instance isolation — a shared instance can
 * still refuse impersonation for, say, the n8n source.
 */
export function isImpersonationAllowedForSource(source: CallerSource): boolean {
  const raw = (process.env.AUTOTASK_IMPERSONATION_SOURCES || '').trim();
  if (raw === '') return true;
  const allow = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return allow.includes(source.toLowerCase());
}

/**
 * Operator-assigned label for THIS MCP instance/container (MCP_INSTANCE_LABEL),
 * e.g. "gpt-teams" or "n8n-cron". Stamped into every audit record so the
 * calling container is attributable by operator truth, independent of both the
 * client-declared source and the transport origin. Undefined when unset.
 */
export function getInstanceLabel(): string | undefined {
  const v = (process.env.MCP_INSTANCE_LABEL || '').trim();
  return v === '' ? undefined : v;
}
