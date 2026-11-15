---
title: Installation
description: Run PSArelay in Claude Desktop, Claude Code, Docker, or as a production service.
---

You need an Autotask **API user**: Admin → Resources, license type *API User*, with an API-tracking
integration code and a security level that allows what your tools do. The server finds your API zone from the
username.

## Claude Code

```bash
claude mcp add psarelay -e AUTOTASK_USERNAME=api-user@example.com -e AUTOTASK_SECRET=your-secret -e AUTOTASK_INTEGRATION_CODE=your-code -- npx -y github:GDSTechnology/psarelay
```

## Claude Desktop

Build the bundle from source, then open the `.mcpb` file it creates in the repo root and enter your
username, secret and integration code:

```bash
git clone https://github.com/GDSTechnology/psarelay.git && cd psarelay
npm ci && npm run build && npm run pack:mcpb
```

## Docker (HTTP)

For ChatGPT, n8n and other remote clients:

```bash
docker run -d --name psarelay -p 8080:8080 -e AUTOTASK_USERNAME=api-user@example.com -e AUTOTASK_SECRET=your-secret -e AUTOTASK_INTEGRATION_CODE=your-code --restart unless-stopped ghcr.io/gdstechnology/psarelay:latest
```

Clients connect to `http://<host>:8080/mcp` (MCP Streamable HTTP). `GET /health` returns the version, API usage
and backpressure.

## From source

```bash
npm ci && npm run build
node dist/entry.js                       # stdio
MCP_TRANSPORT=http node dist/index.js    # HTTP
```

## Production

Releases are cut on every merge to `main` and published to `ghcr.io/gdstechnology/psarelay`. In production
the server runs as a docker-compose service next to Postgres; the
[deploy runbook](https://github.com/GDSTechnology/psarelay/blob/main/DEPLOY.md) covers layout, environment,
verification and rollback.

Updating is one command on the host. Install it once from the image:

```bash
docker run --rm --entrypoint cat ghcr.io/gdstechnology/psarelay:latest /app/deploy/update-psarelay.sh > /usr/local/bin/update-psarelay && chmod +x /usr/local/bin/update-psarelay
```

```bash
update-psarelay
```

It updates only PSArelay service: pulls, keeps the previous image as `:rollback`, runs database
migrations, restarts, waits for `/health` and prints the version. It removes old PSArelay images (other
versions, and the pre-rename `autotask-mcp` name), keeping `:latest` and `:rollback`. It refuses while a bulk job is preparing,
and refreshes itself from each new image.

Then add the [Postgres layer](/guides/mirror/) and the [admin console](/guides/console/).
