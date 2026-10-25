// AI-client sign-in (OAuth 2.1 in the instance): the pure rules. The full flow against Postgres is run locally
// (register → sign in → PKCE → /mcp → rotating refresh → replay revokes the sign-in).

import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleOAuth, oauthBase, pkceOk, redirectUriOk, resourceMetadataUrl } from '../src/oauth/server';
import { Logger } from '../src/utils/logger';

describe('where sign-in is offered', () => {
  test('only with an https MCP_PUBLIC_URL; the resource is the /mcp address', () => {
    expect(oauthBase({ MCP_PUBLIC_URL: 'https://mcp.example.com' } as NodeJS.ProcessEnv)).toEqual({ origin: 'https://mcp.example.com', resource: 'https://mcp.example.com/mcp' });
    expect(oauthBase({ MCP_PUBLIC_URL: 'https://mcp.example.com/mcp/' } as NodeJS.ProcessEnv)!.resource).toBe('https://mcp.example.com/mcp');
    expect(oauthBase({ MCP_PUBLIC_URL: 'http://mcp.example.com' } as NodeJS.ProcessEnv)).toBeNull();
    expect(oauthBase({} as NodeJS.ProcessEnv)).toBeNull();
    expect(resourceMetadataUrl({ origin: 'https://mcp.example.com' })).toBe('https://mcp.example.com/.well-known/oauth-protected-resource');
  });
});

describe('redirect URIs a client may register', () => {
  test('https or loopback http; nothing else, no fragments', () => {
    for (const u of ['https://chatgpt.com/connector_platform_oauth_redirect', 'https://claude.ai/api/mcp/auth_callback', 'http://127.0.0.1:1455/callback', 'http://localhost:8976/cb']) expect(redirectUriOk(u)).toBe(true);
    for (const u of ['http://evil.example/cb', 'https://x.example/cb#frag', 'javascript:alert(1)', 'not a url', 'ftp://x.example/']) expect(redirectUriOk(u)).toBe(false);
  });
});

describe('PKCE S256', () => {
  test('the verifier must hash to the challenge', () => {
    const v = randomBytes(32).toString('base64url');
    const c = createHash('sha256').update(v).digest('base64url');
    expect(pkceOk(v, c)).toBe(true);
    expect(pkceOk(randomBytes(32).toString('base64url'), c)).toBe(false);
    expect(pkceOk('short', c)).toBe(false);
  });
});

describe('without the prerequisites', () => {
  test('every sign-in endpoint says it is not available (no Postgres / no https URL)', async () => {
    let status = 0, sent = '';
    const res = { writeHead: (s: number) => { status = s; }, end: (b: string) => { sent = b; } } as unknown as ServerResponse;
    const handled = await handleOAuth({ method: 'GET', headers: {} } as IncomingMessage, res, new URL('http://x/.well-known/oauth-authorization-server'), { pool: null, logger: new Logger('error'), env: {} as NodeJS.ProcessEnv });
    expect(handled).toBe(true);
    expect(status).toBe(404);
    expect(JSON.parse(sent).error).toBe('not_available');
    expect(await handleOAuth({ method: 'GET', headers: {} } as IncomingMessage, res, new URL('http://x/mcp'), { pool: null, logger: new Logger('error') })).toBe(false);
  });
});
