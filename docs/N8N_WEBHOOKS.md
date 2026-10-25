# Receiving Autotask webhooks in n8n

How to receive an Autotask webhook that this MCP created (`autotask_create_webhook`) in an n8n workflow, and verify that it really came from Autotask before acting on it.

## 1. Prerequisites (n8n service environment)

Autotask signs every callout with the webhook's secret key. The receiver needs the **same** secret. The MCP reads it from `AUTOTASK_WEBHOOK_SECRET`, so give n8n that variable too ([DEPLOY.md §2](../DEPLOY.md#2-environment-variables) shows how to share it), plus two n8n settings so a Code node can use it:

| n8n env var | Value | Why |
|---|---|---|
| `AUTOTASK_WEBHOOK_SECRET` | the shared secret | the HMAC key |
| `N8N_BLOCK_ENV_ACCESS_IN_NODE` | `false` | lets the Code node read `$env.AUTOTASK_WEBHOOK_SECRET` (blocked by default in recent n8n) |
| `NODE_FUNCTION_ALLOW_BUILTIN` | `crypto` | lets the Code node `require('crypto')` |

Recreate the n8n container after adding them.

## 2. Workflow shape

```
Webhook (POST, Raw Body ON, Respond: "Using 'Respond to Webhook' node")
  → Code: verify signature          (snippet below)
  → IF signatureValid
       true  → Respond to Webhook (200) → … your flow, using $json.payload
       false → Respond to Webhook (401)   (and stop)
```

- **Raw Body must be ON** (Webhook node → Options → Raw Body). The signature is over the exact bytes Autotask sent; n8n's parsed-and-re-serialized JSON will not match.
- **Respond fast.** Autotask deactivates a webhook after repeated failed or slow deliveries and then calls its `deactivationUrl`. Answer 200 as soon as the signature checks out and do the slow work after it.
- **Deduplicate.** A delivery can be retried, so treat the payload's event id (`Guid`; confirm the field name on the first live payload) as an idempotency key.
- The MCP's own API user is excluded from the webhook by default, so writes the MCP makes (including ones n8n triggers through it) don't fire it again.

## 3. Signature check: Code node

Mode: **Run Once for All Items**. Paste as-is. It outputs one item per delivery: `{ signatureValid, reason, payload }`.

<!-- n8n-code-node:start -->
```js
// Verify Autotask's X-Hook-Signature: "sha1=" + base64(HMAC-SHA1(secret, raw body)).
// Needs: Webhook node "Raw Body" ON; n8n env AUTOTASK_WEBHOOK_SECRET,
// N8N_BLOCK_ENV_ACCESS_IN_NODE=false, NODE_FUNCTION_ALLOW_BUILTIN=crypto.
const crypto = require('crypto');
const secret = $env.AUTOTASK_WEBHOOK_SECRET;
if (!secret) {
  throw new Error('AUTOTASK_WEBHOOK_SECRET is not visible here: set it on the n8n service and N8N_BLOCK_ENV_ACCESS_IN_NODE=false');
}

const out = [];
const items = $input.all();
for (let i = 0; i < items.length; i++) {
  const item = items[i];
  const headers = (item.json && item.json.headers) || {};
  const header = String(headers['x-hook-signature'] || '').trim();

  if (!item.binary || !item.binary.data) {
    throw new Error('No raw body: turn on "Raw Body" in the Webhook node options');
  }
  // Works whether n8n keeps binary data in memory or on disk.
  const raw = await this.helpers.getBinaryDataBuffer(i, 'data');

  const expected = 'sha1=' + crypto.createHmac('sha1', secret).update(raw).digest('base64');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  const signatureValid = header !== '' && a.length === b.length && crypto.timingSafeEqual(a, b);

  let payload = null;
  if (signatureValid) {
    try { payload = JSON.parse(raw.toString('utf8')); } catch (e) { payload = null; }
  }
  out.push({
    json: {
      signatureValid,
      reason: signatureValid ? 'ok' : (header ? 'signature mismatch' : 'missing X-Hook-Signature header'),
      payload,
    },
  });
}
return out;
```
<!-- n8n-code-node:end -->

The payload is parsed **only** after the signature checks out, so nothing downstream ever sees an unverified body.

## 4. Troubleshooting

| Symptom | Cause |
|---|---|
| `AUTOTASK_WEBHOOK_SECRET is not visible here` | env var missing on the n8n service, or `N8N_BLOCK_ENV_ACCESS_IN_NODE` not `false` |
| `Cannot find module 'crypto'` / not allowed | `NODE_FUNCTION_ALLOW_BUILTIN` doesn't include `crypto` |
| `No raw body` | Webhook node "Raw Body" is off |
| Every delivery is `signature mismatch` | n8n and the MCP have different secrets. Compare without printing them: `printf %s "$AUTOTASK_WEBHOOK_SECRET" \| sha256sum \| cut -c1-8` in each container. Or the webhook was created with a different secret: rotate it with `autotask_update_webhook` `useEnvSecret: true` |
| Webhook stops firing | Autotask deactivated it after failures; it called the `deactivationUrl`. Fix the receiver, then reactivate with `autotask_update_webhook` `isActive: true` |

The snippet above is exercised by `tests/n8n-webhook-signature-doc.test.ts`, which extracts it from this file and runs it against signed sample payloads, so the documented code is the tested code.

## 5. Forward to the MCP audit ledger

For the resource-activity audit, forward each verified callout to the MCP over
the internal Docker network. The MCP checks Autotask's signature itself, so
forward the **raw body unchanged** with the original header:

```
Webhook (Raw Body ON) → [verify, as above] → HTTP Request
  Method:  POST
  URL:     http://psarelay:8080/ingest/autotask-webhook   (installs from before the rename: http://autotask-mcp:8080/…)
  Send Headers:  X-Hook-Signature = {{ $('Webhook').item.json.headers['x-hook-signature'] }}
                 Content-Type     = application/json
  Send Body:     n8n Binary File, input field "data"   (the raw body, byte for byte)
```

Responses: `200 {ok, events, stored, duplicate}` (a re-delivered callout is
stored once), `202` for an entity type that isn't audited, `401` bad signature,
`503` when the MCP has no secret or no Postgres. The endpoint is not exposed
publicly — n8n reaches it by service name.
