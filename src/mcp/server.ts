// Main MCP Server Implementation
// Handles the Model Context Protocol server setup and integration with Autotask
// Single tenant: Autotask credentials come from the environment.
//
// Serving is built on the v2 SDK's dual-era entries: one shared
// McpServerFactory feeds createMcpHandler (HTTP, modern 2026-07-28 envelope
// traffic natively + 2025-era traffic via the default stateless legacy
// fallback) and serveStdio (stdio, same factory, era pinned per connection).

import { getShadowRuntime, initShadow } from '../db/shadow-runtime.js';
import { startNotifyWatch } from '../services/notify-watch.js';
import { startVendorMonitor } from '../vendors/monitor.js';
import { startBulkWorker } from '../bulk/worker.js';
import { startCommerceTracker } from '../commerce/tools.js';
import { flushCallStats, startCallStatsPersistence } from '../db/call-stats-store.js';
import { ingestAutotaskWebhook } from '../db/webhook-ingest.js';
import { startAdminConsole, adminHealth, type AdminConsole } from '../admin/server.js';
import { initAuthBlockStore } from '../db/auth-block-store.js';
import { getPool } from '../db/pool.js';
import { isPgEnabled } from '../db/config.js';
import {
  createMcpHandler,
  Server,
  ProtocolError,
  ProtocolErrorCode,
  type McpHttpHandler,
  type McpServerFactory,
} from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { toNodeHandler } from '@modelcontextprotocol/node';

import { createServer, IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import { AutotaskService } from '../services/autotask.service.js';
import { Logger } from '../utils/logger.js';
import { McpServerConfig } from '../types/mcp.js';
import { EnvironmentConfig, getServerVersion } from '../utils/config.js';
import { AutotaskResourceHandler } from '../handlers/resource.handler.js';
import { AutotaskToolHandler } from '../handlers/tool.handler.js';
import { registerPromptHandlers } from './prompts.js';
import { extractRequestOrigin } from '../utils/origin.js';
import { runWithRequestContext } from '../utils/request-context.js';
import { usageSnapshot } from '../services/http-cache.js';
import { authBlockStatus } from '../services/autotask-http.js';
import { backpressure } from '../services/backpressure.js';
import { settingValue } from '../admin/settings.js';
import { allowedOrigin, isExternalRequest } from '../security/http.js';
import { bearerToken, tokenStore, type TokenAuth } from '../security/tokens.js';
import { CredentialStore, setCredentialSource } from '../setup/credentials.js';
import { handleOAuth, oauthBase, resourceMetadataUrl } from '../oauth/server.js';
import type { Pool } from 'pg';

export class PsarelayServer {
  private config: McpServerConfig;
  private autotaskService: AutotaskService;
  private resourceHandler: AutotaskResourceHandler;
  private toolHandler: AutotaskToolHandler;
  private logger: Logger;
  private envConfig: EnvironmentConfig | undefined;
  private httpServer?: HttpServer;
  private mcpHandler: McpHttpHandler | undefined;
  private stdioHandle: StdioServerHandle | undefined;
  private lazyLoading: boolean;
  private adminConsole: AdminConsole | null = null;

  constructor(config: McpServerConfig, logger: Logger, envConfig?: EnvironmentConfig) {
    this.logger = logger;
    this.config = config;
    this.envConfig = envConfig;

    // Initialize Autotask service
    this.autotaskService = new AutotaskService(config, logger);
    this.lazyLoading = envConfig?.lazyLoading ?? false;

    // Initialize handlers
    this.resourceHandler = new AutotaskResourceHandler(this.autotaskService, logger);
    this.toolHandler = new AutotaskToolHandler(this.autotaskService, logger, this.lazyLoading);
  }

  /**
   * The shared per-request/per-connection server factory consumed by every
   * serving entry (createMcpHandler for Node HTTP, serveStdio for stdio). One
   * factory backs both protocol eras, so the tool surface can never drift
   * between legacy (2025) and modern (2026-07-28) clients.
   */
  public requestFactory(): McpServerFactory {
    return () => this.createFreshServer();
  }

  /**
   * Create a fresh MCP Server with all handlers registered.
   * Called per-request in HTTP (stateless) mode so each initialize gets a clean server.
   */
  private createFreshServer(): Server {
    const server = new Server(
      {
        name: this.config.name,
        version: this.config.version,
      },
      {
        capabilities: {
          resources: {
            subscribe: false,
            listChanged: true
          },
          tools: {
            listChanged: true
          },
          prompts: {
            listChanged: false
          }
        },
        instructions: this.getServerInstructions()
      }
    );

    server.onerror = (error) => {
      this.logger.error('MCP Server error:', error);
    };

    server.oninitialized = () => {
      this.logger.info('MCP Server initialized and ready to serve requests');
    };

    this.setupHandlers(server, this.toolHandler, this.resourceHandler);
    this.toolHandler.setServer(server);

    return server;
  }

  /**
   * Set up all MCP request handlers
   */
  private setupHandlers(
    server: Server,
    toolHandler: AutotaskToolHandler,
    resourceHandler: AutotaskResourceHandler,
  ): void {
    this.logger.info('Setting up MCP request handlers...');

    // List available resources
    server.setRequestHandler('resources/list', async () => {
      try {
        this.logger.debug('Handling list resources request');
        const resources = await resourceHandler.listResources();
        return { resources };
      } catch (error) {
        this.logger.error('Failed to list resources:', error);
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          `Failed to list resources: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    });

    // Read a specific resource
    server.setRequestHandler('resources/read', async (request) => {
      try {
        this.logger.debug(`Handling read resource request for: ${request.params.uri}`);
        const content = await resourceHandler.readResource(request.params.uri);
        return { contents: [content] };
      } catch (error) {
        this.logger.error(`Failed to read resource ${request.params.uri}:`, error);
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          `Failed to read resource: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    });

    // List available tools
    server.setRequestHandler('tools/list', async () => {
      try {
        this.logger.debug('Handling list tools request');
        const tools = await toolHandler.listTools();
        return { tools };
      } catch (error) {
        this.logger.error('Failed to list tools:', error);
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          `Failed to list tools: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    });

    // Call a tool
    server.setRequestHandler('tools/call', async (request) => {
      try {
        this.logger.debug(`Handling tool call: ${request.params.name}`);
        const result = await toolHandler.callTool(
          request.params.name,
          request.params.arguments || {},
          // MCP-standard place for caller context (source/user/correlation); see §3.5.
          (request.params as { _meta?: Record<string, any> })._meta
        );
        return {
          content: result.content,
          isError: result.isError
        };
      } catch (error) {
        this.logger.error(`Failed to call tool ${request.params.name}:`, error);
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          `Failed to call tool: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    });

    // Register prompt handlers
    registerPromptHandlers(server);

    this.logger.info('MCP request handlers set up successfully');
  }

  /**
   * Start the MCP server with the configured transport
   */
  async start(): Promise<void> {
    const transportType = this.envConfig?.transport?.type || 'stdio';
    this.logger.info(`Starting PSArelay with ${transportType} transport...`);

    // Restore any saved Autotask login-protection pause BEFORE the first
    // Autotask call, so a restart during a lockout doesn't spend more logins.
    if (isPgEnabled()) {
      const pool = getPool(this.logger);
      if (pool) await initAuthBlockStore(pool, this.logger);
      // The API user entered and verified in the console wins over the AUTOTASK_* environment variables.
      if (pool) await this.applyStoredCredentials(pool);
    }

    // Postgres shadow (no-op unless MCP_PG_ENABLED + MCP_PG_SHADOW_ENABLED).
    try { initShadow(this.autotaskService, this.logger); } catch (err) { this.logger.error('Postgres shadow failed to start (continuing without it)', err); }

    if (transportType === 'http') {
      await this.startHttpTransport();
      // Admin console on its own port (no-op unless MCP_ADMIN_ENABLED=true).
      // HTTP deployments only: a stdio server is one per desktop client.
      try {
        this.adminConsole = await startAdminConsole({
          logger: this.logger, service: this.autotaskService,
          version: getServerVersion(this.envConfig?.server?.version),
          apiUsername: this.envConfig?.autotask?.username,
        });
      } catch (err) { this.logger.error('Admin console failed to start (continuing without it)', err); }
      // Notifications (console → Notifications): watch for trips and post them to the configured channels.
      const tenant = this.envConfig?.autotask?.username;
      if (tenant) {
        startNotifyWatch({ tenant, lastRun: () => getShadowRuntime()?.lastRun() ?? null, lastVerify: () => getShadowRuntime()?.lastVerify() ?? null });
        // Vendor monitor (stale imports, renewals, contracts ending, sync drift) — daily at MCP_VENDOR_MONITOR_HOUR_UTC; off when unset.
        if (isPgEnabled()) startVendorMonitor(this.autotaskService, () => getPool(this.logger), this.logger);
        // Bulk jobs (placeholder cleanup): pushes approved, running jobs at their pace.
        if (isPgEnabled()) startBulkWorker(this.autotaskService, () => getPool(this.logger), this.logger, tenant);
        // Orders: follow each one to its invoice and payment (reads only).
        if (isPgEnabled()) startCommerceTracker(this.autotaskService, () => getPool(this.logger), this.logger);
        // Console traffic counts (Reads by entity, Tool gaps): kept 7 days across restarts.
        const statsPool = isPgEnabled() ? getPool(this.logger) : null;
        if (statsPool) void startCallStatsPersistence(statsPool, this.logger);
      }
    } else {
      await this.startStdioTransport();
    }
  }

  /**
   * Start with stdio transport (default)
   *
   * serveStdio owns the era decision for the connection: a classic 2025
   * `initialize` handshake pins a legacy-era instance, a modern opening pins
   * a 2026-07-28 instance — both built by the same factory.
   */
  private async startStdioTransport(): Promise<void> {
    this.stdioHandle = serveStdio(this.requestFactory(), {
      onerror: (error) => this.logger.error('MCP stdio serving error:', error),
    });
    this.logger.info('PSArelay started and connected to stdio transport');
  }

  /** Use the console-stored Autotask credentials (migration 0020) when there are any and they decrypt. */
  private async applyStoredCredentials(pool: Pool): Promise<void> {
    try {
      const has = await pool.query<{ t: string | null }>(`SELECT to_regclass('autotask_credential')::text AS t`);
      if (!has.rows[0]?.t) return;
      const c = await new CredentialStore(pool).get();
      if (!c) return;
      this.autotaskService.reconfigure(c);
      if (this.envConfig) this.envConfig.autotask = { username: c.username, secret: c.secret, integrationCode: c.integrationCode, ...(c.apiUrl ? { apiUrl: c.apiUrl } : {}) };
      setCredentialSource('console');
      this.logger.info(`Autotask credentials: from the console (${c.username}, verified ${c.verifiedAt})`);
    } catch (err) {
      setCredentialSource('environment', `The credentials saved in the console could not be used (${err instanceof Error ? err.message : String(err)}) — using the environment variables.`);
      this.logger.error('Console-stored Autotask credentials could not be used; falling back to the environment', err);
    }
  }

  /**
   * The verified access token of an /mcp request (zero trust), null when it carried none and none is required, or
   * 'refused' after answering 401 / 503. A presented token must be valid even when tokens are optional, so a revoked
   * client never silently keeps working.
   */
  private async authenticateMcp(req: IncomingMessage, res: ServerResponse): Promise<TokenAuth | null | 'refused'> {
    const presented = bearerToken(req.headers.authorization);
    const required = settingValue<boolean>('security.requireMcpToken') === true;
    if (!presented && !required) return null;
    const store = tokenStore(isPgEnabled() ? getPool(this.logger) : null);
    if (!store) { refuseMcp(res, 503, 'Access tokens need the Postgres layer (MCP_PG_ENABLED).'); return 'refused'; }
    if (!presented) { refuseMcp(res, 401, 'Unauthorized: this MCP requires an access token (Authorization: Bearer psr_…).'); return 'refused'; }
    const auth = await store.verify(presented);
    if (!auth) { refuseMcp(res, 401, 'Unauthorized: the access token is not valid (unknown, revoked or expired).'); return 'refused'; }
    // A sign-in token is accepted only by the MCP it was issued for (audience, RFC 8707).
    const base = oauthBase();
    if (auth.audience && (!base || auth.audience.toLowerCase() !== base.resource.toLowerCase())) { refuseMcp(res, 401, 'Unauthorized: this token was issued for a different server.'); return 'refused'; }
    return auth;
  }

  /**
   * Start with HTTP Streamable transport
   */
  private async startHttpTransport(): Promise<void> {
    const port = this.envConfig?.transport?.port || 8080;
    const host = this.envConfig?.transport?.host || '0.0.0.0';
    // One dual-era handler for the process: modern (2026-07-28 envelope)
    // traffic is served natively; legacy 2025-era traffic is served by the
    // default stateless fallback ('stateless') — a fresh factory-built server
    // per request, exactly the per-request stateless idiom this server has
    // always used. Legacy GET/DELETE session operations answer 405 by design.
    this.mcpHandler = createMcpHandler(this.requestFactory(), {
      legacy: 'stateless',
      onerror: (error) => this.logger.error('MCP handler error:', error),
    });
    const nodeMcpHandler = toNodeHandler(this.mcpHandler, {
      onerror: (error) => this.logger.error('MCP node adapter error:', error),
    });

    this.httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      // CORS only for the browser origins an operator lists (MCP_CORS_ORIGINS) — never '*'. AI connectors
      // (ChatGPT, Claude) and n8n call server-to-server and don't need it.
      const corsOrigin = allowedOrigin(req.headers.origin);
      if (corsOrigin) {
        res.setHeader('Access-Control-Allow-Origin', corsOrigin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version');
        res.setHeader('Access-Control-Max-Age', '86400');
      }

      // CORS preflight — respond before routing so every path (including /mcp)
      // answers OPTIONS with 204 and the headers above.
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Sign-in for AI clients (OAuth discovery, registration, sign-in page, tokens).
      if (url.pathname.startsWith('/.well-known/oauth-') || url.pathname.startsWith('/oauth/')) {
        handleOAuth(req, res, url, { pool: isPgEnabled() ? getPool(this.logger) : null, logger: this.logger }).catch((err) => {
          this.logger.error('OAuth request failed:', err);
          if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'server_error' })); }
        });
        return;
      }

      // Autotask webhook ingest (forwarded by n8n on the internal network). No
      // MCP auth: authenticity is Autotask's own HMAC signature, re-verified here.
      if (url.pathname === '/ingest/autotask-webhook') {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => { size += c.length; if (size <= 1_000_000) chunks.push(c); });
        req.on('end', () => {
          if (size > 1_000_000) { res.writeHead(413); res.end(); return; }
          const sig = req.headers['x-hook-signature'];
          ingestAutotaskWebhook(Buffer.concat(chunks), Array.isArray(sig) ? sig[0] : sig)
            .then((r) => { res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r.body)); })
            .catch((err) => { this.logger.error('webhook ingest failed', err); res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'ingest failed' })); });
        });
        return;
      }

      // Health endpoint - no auth required. From outside the private network (through a tunnel or proxy) it
      // answers only status + version: API usage, backpressure and login state are for the host's own services.
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        if (isExternalRequest(req)) {
          res.end(JSON.stringify({ status: 'ok', version: getServerVersion(this.envConfig?.server?.version) }));
          return;
        }
        // `mcpTransport` (not `transport`) to avoid confusion with the network
        // scheme — the value refers to the MCP transport type (stdio vs
        // Streamable HTTP), not whether the service is served over HTTP/HTTPS.
        // `version` is included so operators can curl-check which build is
        // running without going through the MCP handshake.
        // A compact Autotask-budget summary (counts only — the per-entity
        // breakdown is behind the autotask_get_api_usage tool).
        const apiUser = this.envConfig?.autotask?.username;
        const u = apiUser ? usageSnapshot(apiUser.toLowerCase(), 0) : null;
        res.end(JSON.stringify({
          status: 'ok',
          version: getServerVersion(this.envConfig?.server?.version),
          mcpTransport: 'http',
          timestamp: new Date().toISOString(),
          ...(u ? { apiUsage: { upstreamLastHour: u.upstreamLastHour, upstreamLastFiveMinutes: u.upstreamLastFiveMinutes, savedPct: u.savedPct, rateLimited: u.rateLimited, cacheEnabled: u.cacheEnabled } } : {}),
          ...shadowHealth(),
          ...(adminHealth() ? { admin: adminHealth() } : {}),
          ...(apiUser && authBlockStatus(apiUser) ? { autotaskAuth: authBlockStatus(apiUser) } : {}),
          // MCP-008: one verdict for dispatchers (n8n) — ok / slow / stop, why, and how long to wait.
          ...(apiUser ? { backpressure: ((b) => ({ level: b.level, reasons: b.reasons, retryAfterSeconds: b.retryAfterSeconds, usedPct: b.autotask.usedPct }))(backpressure(apiUser)) } : {}),
        }));
        return;
      }

      // MCP endpoint — dual-era handler (fresh factory-built server per
      // request in both eras; nothing is shared between requests)
      if (url.pathname === '/mcp') {
        // Capture the transport-derived origin (peer address / X-Forwarded-For
        // / User-Agent) once, at the entry, and run the whole request dispatch
        // inside a per-request context carrying it. AsyncLocalStorage keeps it
        // available to callTool/audit for calling-container attribution without
        // threading `req` through the stack — and without leaking between
        // concurrent requests.
        const origin = extractRequestOrigin(req);

        // Delegate to the dual-era handler. Legacy (2025) traffic is served
        // per-request statelessly; modern (2026-07-28) traffic natively.
        // Legacy-era GET/DELETE answer 405 inside the handler, as before.
        // Cast: the adapter's duck-typed NodeIncomingMessageLike declares
        // `method?: string`, which node:http's IncomingMessage doesn't satisfy
        // under exactOptionalPropertyTypes (v2.0.0-beta.5 typings papercut).
        // The access token is checked first (zero trust); the body stream stays paused until the handler reads it.
        this.authenticateMcp(req, res).then((auth) => {
          if (auth === 'refused') return;
          runWithRequestContext({ ...(origin ? { origin } : {}), ...(auth ? { auth } : {}) }, () => {
            nodeMcpHandler(req as unknown as Parameters<typeof nodeMcpHandler>[0], res).catch((err) => {
              this.logger.error('MCP transport error:', err);
              if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  jsonrpc: '2.0',
                  error: { code: -32603, message: 'Internal error' },
                  id: null,
                }));
              }
            });
          });
        }, (err) => {
          this.logger.error('MCP access-token check failed:', err);
          refuseMcp(res, 503, 'Access tokens could not be checked (database unavailable).');
        });

        return;
      }

      // A person opening the address in a browser: say what it is (no version, no tenant details — zero trust).
      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" });
        res.end(MCP_ROOT_PAGE);
        return;
      }

      // 404 for everything else
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', endpoints: ['/mcp', '/health'] }));
    });

    await new Promise<void>((resolve) => {
      this.httpServer!.listen(port, host, () => {
        this.logger.info(`PSArelay listening on http://${host}:${port}/mcp`);
        this.logger.info(`Health check available at http://${host}:${port}/health`);
        resolve();
      });
    });
  }

  /**
   * Stop the server gracefully
   */
  async stop(): Promise<void> {
    this.logger.info('Stopping PSArelay...');
    // Keep the last minutes of the console's traffic counts across the restart.
    await Promise.race([flushCallStats().catch(() => undefined), new Promise((r) => setTimeout(r, 3000))]);
    getShadowRuntime()?.stop();
    await this.adminConsole?.stop();
    if (this.httpServer) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer!.close((err) => err ? reject(err) : resolve());
      });
    }
    if (this.mcpHandler) {
      await this.mcpHandler.close();
      this.mcpHandler = undefined;
    }
    if (this.stdioHandle) {
      await this.stdioHandle.close();
      this.stdioHandle = undefined;
    }
    this.logger.info('PSArelay stopped');
  }

  /**
   * Get server instructions for clients
   */
  private getServerInstructions(): string {
    return `
# PSArelay

This server provides access to Kaseya Autotask PSA data and operations through the Model Context Protocol.

## Available Resources:
- **autotask://companies/{id}** - Get company details by ID
- **autotask://companies** - List all companies
- **autotask://contacts/{id}** - Get contact details by ID  
- **autotask://contacts** - List all contacts
- **autotask://tickets/{id}** - Get ticket details by ID
- **autotask://tickets** - List all tickets

## Progressive Discovery (Lazy Loading):
When LAZY_LOADING=true, only 3 meta-tools are exposed initially:
- **autotask_list_categories** - List all available tool categories with descriptions and tool counts
- **autotask_list_category_tools** - Get full tool schemas for a specific category
- **autotask_execute_tool** - Execute any tool by name with arguments (used in lazy loading mode)

Use autotask_list_categories to discover available tool categories, then autotask_list_category_tools to get full schemas for a category, then autotask_execute_tool to call the desired tool.

## Available Tools (39 total):
- Companies: search, create, update
- Contacts: search, create
- Tickets: search, get details, create
- Time entries: create
- Projects: search, create
- Resources: search
- Notes: get/search/create for tickets, projects, companies
- Attachments: get/search ticket attachments
- Financial: expense reports, quotes, quote items (CRUD), invoices, contracts
- Sales: opportunities, products, services, service bundles
- Configuration items: search
- Tasks: search, create
- Picklists: list queues, list ticket statuses, list ticket priorities, get field info
- Utility: test connection

## Picklist Discovery:
Use autotask_list_queues, autotask_list_ticket_statuses, or autotask_list_ticket_priorities to discover valid IDs before filtering. Use autotask_get_field_info for any entity's field definitions and picklist values.

## When no tool does it:
Call **autotask_report_gap** (title = what was needed, detail = what the user asked and why the tools fell short, toolsTried) and tell the user it was logged. Don't guess, and don't work around it with raw_request writes. It lands on the admin console's Requests page, where it gets built. (action=list shows what is already requested.)

## ID-to-Name Mapping:
All search and detail tools automatically include human-readable names for company and resource IDs in an _enhanced field on each result.

## Authentication:
This server requires valid Autotask API credentials. Ensure you have:
- AUTOTASK_USERNAME (API user email)
- AUTOTASK_SECRET (API secret key)
- AUTOTASK_INTEGRATION_CODE (integration code)

For more information, visit: https://github.com/GDSTechnology/psarelay
`.trim();
  }
}

/** Compact shadow status for /health — in-memory only, never a database round-trip. */
function shadowHealth(): Record<string, unknown> {
  const rt = getShadowRuntime();
  if (!rt) return {};
  const last = rt.lastRun();
  return { shadow: { enabled: true, serveReads: rt.serveReads, lastRunAt: last?.at ?? null, lastRunCalls: last?.report.calls ?? null, ...(last?.report.skipped ? { lastRunSkipped: last.report.skipped } : {}) } };
}

/** Answer an /mcp request that may not proceed (JSON-RPC error body; 401 says a Bearer token is expected). */
function refuseMcp(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  // On 401, point AI clients at the sign-in (RFC 9728) so they can connect by themselves.
  const base = oauthBase();
  const challenge = base ? `Bearer realm="psarelay", resource_metadata="${resourceMetadataUrl(base)}"` : 'Bearer realm="psarelay"';
  res.writeHead(status, { 'Content-Type': 'application/json', ...(status === 401 ? { 'WWW-Authenticate': challenge } : {}) });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }));
}

/** What a browser sees at the MCP address: this is for AI clients, and where to go instead. */
const MCP_ROOT_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PSArelay</title>
<style>:root{color-scheme:light dark}body{font:16px/1.55 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e7e9ee}
@media (prefers-color-scheme:light){body{background:#f4f5f7;color:#16181d}main{background:#fff!important;border-color:#dfe2e8!important}}
main{width:min(520px,calc(100vw - 32px));background:#171a21;border:1px solid #2a2f3a;border-radius:12px;padding:28px}h1{font-size:22px;margin:0 0 8px}a{color:#3b82f6}code{font-size:14px}</style></head>
<body><main><h1>PSArelay</h1><p>This address is for <strong>AI clients</strong> — ChatGPT, Claude, Microsoft 365 Copilot, Codex or n8n connect to <code>/mcp</code> here and sign in. There is nothing to open in a browser.</p>
<p>To connect yours, open your PSArelay console → <strong>Connect</strong>, or read <a href="https://docs.psarelay.app/guides/connect/">Connect your AI</a>.</p></main></body></html>`;
