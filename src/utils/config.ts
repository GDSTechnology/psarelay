// Configuration Utility
// Handles loading configuration from environment variables and MCP client arguments

import { McpServerConfig } from '../types/mcp.js';
import { LogLevel } from './logger.js';
// `resolveJsonModule` is enabled in tsconfig. We read package.json so the
// runtime can report its actual built version in the MCP initialize handshake
// and the /health endpoint. The Dockerfile patches this file's `version` field
// with the release VERSION build arg before `npm run build`, so the published
// image always carries the real release version even though branch protection
// blocks @semantic-release/git from pushing version bumps back to main.
import packageJson from '../../package.json';

/**
 * Resolve the running server version. Single source of truth for both the
 * `serverInfo.version` MCP handshake value and the `/health` response.
 * Priority: explicit override > package.json (patched at Docker build time
 * with the release version) > 'unknown'.
 */
export function getServerVersion(override?: string): string {
  return override || packageJson.version || 'unknown';
}

export type TransportType = 'stdio' | 'http';

export interface EnvironmentConfig {
  autotask: {
    username?: string;
    secret?: string;
    integrationCode?: string;
    apiUrl?: string;
  };
  server: {
    name: string;
    version: string;
  };
  transport: {
    type: TransportType;
    port: number;
    host: string;
  };
  logging: {
    level: LogLevel;
    format: 'json' | 'simple';
  };
  lazyLoading?: boolean;
}

/**
 * Load configuration from environment variables
 */
export function loadEnvironmentConfig(): EnvironmentConfig {
  const creds = {
    username: process.env.AUTOTASK_USERNAME,
    secret: process.env.AUTOTASK_SECRET,
    integrationCode: process.env.AUTOTASK_INTEGRATION_CODE,
    apiUrl: process.env.AUTOTASK_API_URL,
  };

  // Filter out undefined values to satisfy exactOptionalPropertyTypes
  const autotaskConfig: { username?: string; secret?: string; integrationCode?: string; apiUrl?: string } = {};
  if (creds.username) autotaskConfig.username = creds.username;
  if (creds.secret) autotaskConfig.secret = creds.secret;
  if (creds.integrationCode) autotaskConfig.integrationCode = creds.integrationCode;
  if (creds.apiUrl) autotaskConfig.apiUrl = creds.apiUrl;

  const transportType = (process.env.MCP_TRANSPORT as TransportType) || 'stdio';
  if (transportType !== 'stdio' && transportType !== 'http') {
    throw new Error(`Invalid MCP_TRANSPORT value: "${transportType}". Must be "stdio" or "http".`);
  }

  return {
    autotask: autotaskConfig,
    server: {
      name: process.env.MCP_SERVER_NAME || 'psarelay',
      version: getServerVersion(process.env.MCP_SERVER_VERSION)
    },
    transport: {
      type: transportType,
      port: parseInt(process.env.MCP_HTTP_PORT || '8080', 10),
      host: process.env.MCP_HTTP_HOST || '0.0.0.0'
    },
    logging: {
      level: (process.env.LOG_LEVEL as LogLevel) || 'info',
      format: (process.env.LOG_FORMAT as 'json' | 'simple') || 'simple'
    },
    lazyLoading: process.env.LAZY_LOADING === 'true' || process.env.LAZY_LOADING === '1'
  };
}

/**
 * Merge environment config with MCP client configuration
 */
export function mergeWithMcpConfig(envConfig: EnvironmentConfig, mcpArgs?: Record<string, any>): McpServerConfig {
  // MCP client can override server configuration through arguments
  const serverConfig: McpServerConfig = {
    name: mcpArgs?.name || envConfig.server.name,
    version: mcpArgs?.version || envConfig.server.version,
    autotask: {
      username: mcpArgs?.autotask?.username || envConfig.autotask.username,
      secret: mcpArgs?.autotask?.secret || envConfig.autotask.secret,
      integrationCode: mcpArgs?.autotask?.integrationCode || envConfig.autotask.integrationCode,
      apiUrl: mcpArgs?.autotask?.apiUrl || envConfig.autotask.apiUrl
    }
  };

  return serverConfig;
}

/**
 * In-memory cache of resolved zone URLs keyed by username (lowercased).
 * Populated by resolveAutotaskApiUrl on successful zone info lookup.
 * Never persisted to disk — lifetime == process lifetime.
 */
const zoneUrlCache = new Map<string, string>();

/**
 * The tenant's Autotask WEB UI base (zoneInformation `webUrl`, e.g.
 * https://ww3.autotask.net/), keyed like zoneUrlCache. Used to build "open in
 * Autotask" links; captured from the same lookup, so it costs nothing extra.
 */
const zoneWebUrlCache = new Map<string, string>();

/**
 * Reset the zone URL cache. Intended for tests only.
 */
export function _resetZoneUrlCache(): void {
  zoneUrlCache.clear();
  zoneWebUrlCache.clear();
}

/**
 * The Autotask web UI base URL (trailing slash), or null when unknown.
 * Precedence: AUTOTASK_WEB_URL env override → the zone lookup's `webUrl` →
 * derived from the API host (Autotask pairs webservicesN with wwN, e.g.
 * webservices3 → ww3; zoneInformation reports exactly that pair).
 */
export function resolveAutotaskWebUrl(username: string | undefined, apiUrl: string | undefined): string | null {
  const withSlash = (u: string) => (u.endsWith('/') ? u : `${u}/`);
  const override = process.env.AUTOTASK_WEB_URL?.trim();
  if (override) return withSlash(override);
  const cached = username ? zoneWebUrlCache.get(username.toLowerCase()) : undefined;
  if (cached) return withSlash(cached);
  const api = apiUrl ?? (username ? zoneUrlCache.get(username.toLowerCase()) : undefined);
  const m = api?.match(/^https:\/\/webservices(\d+)\.autotask\.net/i);
  return m ? `https://ww${m[1]}.autotask.net/` : null;
}

/**
 * Drop the cached zone URL for a single username. Call this when a real
 * Autotask API request (not the zoneInformation lookup itself) comes back
 * 401 — the cache has no TTL, so a data-center migration that moves a
 * tenant to a new zone after we've already cached the old one would
 * otherwise pin that tenant to the wrong host for the rest of the process
 * lifetime. The next resolveAutotaskApiUrl call re-resolves from scratch.
 */
export function invalidateZoneUrlCache(username: string): void {
  zoneUrlCache.delete(username.toLowerCase());
}

/**
 * Minimal logger shape accepted by resolveAutotaskApiUrl so we don't
 * have a hard dep on the Logger class (keeps this pre-auth bootstrap simple).
 */
export interface ZoneResolverLogger {
  info: (msg: string, ...args: any[]) => void;
  error: (msg: string, ...args: any[]) => void;
}

const ZONE_INFO_URL = 'https://webservices.autotask.net/atservicesrest/v1.0/zoneInformation';
const ZONE_DOCS_URL =
  'https://ww1.autotask.net/help/Content/AdminSetup/2ExtensionsIntegrations/APIs/REST/General_Topics/REST_Zones.htm';

/**
 * Resolve the Autotask API base URL.
 *
 * Precedence:
 *   1. If `explicitApiUrl` is set, return it (manual override always wins).
 *   2. Otherwise, if `username` is set, look up the tenant's zone via the
 *      unauthenticated zoneInformation endpoint, cache it, and return it.
 *   3. Otherwise, throw — caller must set AUTOTASK_API_URL manually.
 *
 * Intentionally uses native `fetch` (not the autotask-node SDK) because
 * this is a pre-auth bootstrap: the SDK needs a URL to construct itself.
 */
export async function resolveAutotaskApiUrl(
  username: string | undefined,
  explicitApiUrl: string | undefined,
  logger: ZoneResolverLogger,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  if (explicitApiUrl) {
    return explicitApiUrl;
  }

  if (!username) {
    throw new Error(
      'Cannot auto-detect Autotask zone: AUTOTASK_USERNAME is not set. ' +
        `Set AUTOTASK_API_URL manually — see ${ZONE_DOCS_URL}`
    );
  }

  const cacheKey = username.toLowerCase();
  const cached = zoneUrlCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const lookupUrl = `${ZONE_INFO_URL}?user=${encodeURIComponent(username)}`;
  let response: Response;
  try {
    response = await fetchImpl(lookupUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      `Failed to contact Autotask zone info endpoint: ${message}. ` +
        `Set AUTOTASK_API_URL manually — see ${ZONE_DOCS_URL}`
    );
    throw new Error(
      `Autotask zone auto-detection failed (network error: ${message}). ` +
        `Set AUTOTASK_API_URL manually — see ${ZONE_DOCS_URL}`,
      { cause: err }
    );
  }

  if (!response.ok) {
    logger.error(
      `Autotask zone info endpoint returned HTTP ${response.status} for user ${username}. ` +
        `Verify the username (API user email) is correct, or set AUTOTASK_API_URL manually — see ${ZONE_DOCS_URL}`
    );
    throw new Error(
      `Autotask zone auto-detection failed (HTTP ${response.status}). ` +
        `Set AUTOTASK_API_URL manually — see ${ZONE_DOCS_URL}`
    );
  }

  let body: any;
  try {
    body = await response.json();
  } catch (err) {
    logger.error(
      `Autotask zone info response was not valid JSON. ` +
        `Set AUTOTASK_API_URL manually — see ${ZONE_DOCS_URL}`
    );
    throw new Error(
      `Autotask zone auto-detection failed (malformed response). ` +
        `Set AUTOTASK_API_URL manually — see ${ZONE_DOCS_URL}`,
      { cause: err }
    );
  }

  const url: unknown = body?.url;
  if (typeof url !== 'string' || url.length === 0) {
    logger.error(
      `Autotask zone info response missing "url" field. ` +
        `Set AUTOTASK_API_URL manually — see ${ZONE_DOCS_URL}`
    );
    throw new Error(
      `Autotask zone auto-detection failed (missing url in response). ` +
        `Set AUTOTASK_API_URL manually — see ${ZONE_DOCS_URL}`
    );
  }

  const zoneName = typeof body?.zoneName === 'string' ? body.zoneName : 'unknown';
  logger.info(`Auto-detected Autotask zone "${zoneName}" for user ${username}: ${url}`);

  zoneUrlCache.set(cacheKey, url);
  if (typeof body?.webUrl === 'string' && body.webUrl) zoneWebUrlCache.set(cacheKey, body.webUrl);
  return url;
}

/**
 * Get configuration help text
 */
export function getConfigHelp(): string {
  return `
PSArelay Configuration:

Required Environment Variables:
  AUTOTASK_USERNAME         - Autotask API username (email)
  AUTOTASK_SECRET          - Autotask API secret key
  AUTOTASK_INTEGRATION_CODE - Autotask integration code

=== Common Options ===
  AUTOTASK_API_URL         - Autotask API base URL (auto-detected if not provided)
  MCP_SERVER_NAME          - Server name (default: psarelay)
  MCP_SERVER_VERSION       - Override the reported server version. Defaults to the version baked into the image's package.json at build time. Useful for stamping a custom build identifier.
  MCP_TRANSPORT            - Transport type: stdio, http (default: stdio)
  MCP_HTTP_PORT            - HTTP port when using http transport (default: 8080)
  MCP_HTTP_HOST            - HTTP host when using http transport (default: 0.0.0.0)
  LOG_LEVEL                - Logging level: error, warn, info, debug (default: info)
  LOG_FORMAT               - Log format: simple, json (default: simple)
  AUTOTASK_ENHANCE_CONCURRENCY - Max concurrent Autotask API calls used to resolve company/resource names on search results (default: 3). Kept low to stay under Autotask's concurrent-thread limit.

Example (Local Mode):
  AUTOTASK_USERNAME=api-user@example.com
  AUTOTASK_SECRET=your-secret-key
  AUTOTASK_INTEGRATION_CODE=your-integration-code

`.trim();
}
