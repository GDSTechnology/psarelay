// POST /ingest/autotask-webhook — Autotask webhook callouts, forwarded by n8n
// (which owns the public URL) over the internal Docker network.
//
// The MCP re-verifies Autotask's own signature (X-Hook-Signature: "sha1=" +
// base64 HMAC-SHA1 of the RAW body with AUTOTASK_WEBHOOK_SECRET), so the
// ledger only ever records genuine callouts, whatever path they took. Each
// callout becomes audit events: PersonID = the resource who acted in the UI;
// new values from the callout, OLD values from the mirrored row as it was
// before the change. The row is then queued for a re-read on the next sync run
// (markStale: searches keep using the mirror meanwhile).

import { createHmac, timingSafeEqual } from 'crypto';
import { getShadowRuntime } from './shadow-runtime.js';
import { webhookEntity, webhookEvents, type WebhookPayload } from '../utils/audit-events.js';

export interface IngestResult { status: number; body: Record<string, unknown> }

export function verifyAutotaskSignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const expected = Buffer.from(`sha1=${createHmac('sha1', secret).update(raw).digest('base64')}`);
  const got = Buffer.from(header.trim());
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export async function ingestAutotaskWebhook(raw: Buffer, signature: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<IngestResult> {
  const secret = (env.AUTOTASK_WEBHOOK_SECRET ?? '').trim();
  if (!secret) return { status: 503, body: { error: 'AUTOTASK_WEBHOOK_SECRET is not set on the MCP' } };
  if (!verifyAutotaskSignature(raw, signature, secret)) return { status: 401, body: { error: 'invalid X-Hook-Signature' } };
  const rt = getShadowRuntime();
  if (!rt) return { status: 503, body: { error: 'the audit ledger needs the Postgres shadow (MCP_PG_ENABLED + MCP_PG_SHADOW_ENABLED)' } };
  let p: WebhookPayload;
  try { p = JSON.parse(raw.toString('utf8')) as WebhookPayload; } catch { return { status: 400, body: { error: 'body is not JSON' } }; }
  const ent = webhookEntity(p.EntityType);
  if (!ent) return { status: 202, body: { ok: true, ignored: `entity type "${p.EntityType}" is not audited` } };
  const id = Number(p.Id);
  const oldRow = ent.shadow && Number.isFinite(id) ? await rt.store.getRow(ent.shadow, id) : null;
  const events = webhookEvents(p, oldRow);
  const stored = await rt.ledger.insert(events);
  if (ent.shadow && Number.isFinite(id)) rt.sync.markStale(ent.shadow, id);
  return { status: 200, body: { ok: true, events: events.length, stored, duplicate: events.length > 0 && stored === 0 } };
}
