// HTTP exposure rules for the MCP port (zero trust): who gets CORS, and who gets the detailed /health.

import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

/** Private / loopback / link-local addresses (IPv4, IPv6, IPv4-mapped IPv6). */
export function isPrivateAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/i, '');
  if (isIP(a) === 4) {
    const [p, q] = a.split('.').map(Number) as [number, number];
    return p === 10 || p === 127 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 169 && q === 254);
  }
  if (isIP(a) === 6) { const l = a.toLowerCase(); return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80'); }
  return false;
}

/**
 * Did this request come from outside the host's private network? A request relayed by a proxy or tunnel
 * (Cloudflare adds CF-Connecting-IP; proxies add X-Forwarded-For) counts as outside even though the relay itself is
 * on the private network — the person behind it is not.
 */
export function isExternalRequest(req: Pick<IncomingMessage, 'headers' | 'socket'>): boolean {
  if (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.headers['forwarded']) return true;
  return !isPrivateAddress(req.socket?.remoteAddress);
}

/** The web AI clients whose connectors call /mcp from the browser (claude.ai sends a CORS preflight). */
export const DEFAULT_CORS_ORIGINS = ['https://claude.ai', 'https://chatgpt.com', 'https://chat.openai.com'];

/**
 * Browser origins allowed to call /mcp: MCP_CORS_ORIGINS (comma-separated), `none` for no browser access, unset for
 * the known AI clients. Never `*` — any other web page a user visits can't drive the MCP from their browser.
 */
export function corsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.MCP_CORS_ORIGINS;
  if (raw == null || raw.trim() === '') return DEFAULT_CORS_ORIGINS;
  if (raw.trim().toLowerCase() === 'none') return [];
  return raw.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}
/** The Access-Control-Allow-Origin value for this request, or null (no CORS). Never `*`. */
export function allowedOrigin(origin: string | string[] | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  const o = (Array.isArray(origin) ? origin[0] : origin)?.replace(/\/+$/, '');
  if (!o) return null;
  return corsOrigins(env).includes(o) ? o : null;
}
