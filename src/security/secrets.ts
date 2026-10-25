// Encryption at rest for secrets the console stores (the Autotask API secret and integration code).
//
// AES-256-GCM with the key in MCP_SECRET_KEY (32 random bytes, base64 or hex) — kept in the env file, never in the
// database, so a database dump alone does not reveal the secrets. update-psarelay adds a key when there is none.
// Format: "v1:" + base64(iv 12 bytes | tag 16 bytes | ciphertext).

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function keyFrom(raw: string | undefined): Buffer | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  const b = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
  return b.length === 32 ? b : null;
}

/** Whether a usable key is configured (and why not). */
export function secretKeyStatus(env: NodeJS.ProcessEnv = process.env): { ok: boolean; detail: string } {
  if (!(env.MCP_SECRET_KEY ?? '').trim()) return { ok: false, detail: 'MCP_SECRET_KEY is not set — run update-psarelay once (it adds one to the env file), or set 32 random bytes (base64) yourself.' };
  return keyFrom(env.MCP_SECRET_KEY) ? { ok: true, detail: 'Secrets are encrypted at rest (AES-256-GCM).' } : { ok: false, detail: 'MCP_SECRET_KEY must be 32 bytes, base64 or 64 hex characters.' };
}

export function encryptSecret(plain: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = keyFrom(env.MCP_SECRET_KEY);
  if (!key) throw new Error(secretKeyStatus(env).detail);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

/** Decrypt; throws when the key is missing or wrong, or the value was tampered with. */
export function decryptSecret(sealed: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = keyFrom(env.MCP_SECRET_KEY);
  if (!key) throw new Error(secretKeyStatus(env).detail);
  if (!sealed.startsWith('v1:')) throw new Error('unknown secret format');
  const raw = Buffer.from(sealed.slice(3), 'base64');
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}
