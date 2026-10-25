# Multi-stage build for efficient container size
FROM node:26-alpine AS builder

# Build arguments
ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"

# node:22-alpine ships with npm 10.x — no need to install globally
# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies — public packages only, no registry token.
RUN npm ci --ignore-scripts

# Copy source code
COPY . .

# Bake the release VERSION (from the docker build-args) into package.json
# before `npm run build`. The runtime reads version from `import packageJson`
# (see src/utils/config.ts), so this is what ends up in serverInfo.version and
# the /health response. Necessary because @semantic-release/git's push-back to
# main is silently dropped by branch protection on this repo — package.json on
# main stays stale, so the release pipeline has to inject the real version at
# image-build time.
#
# Deliberately placed AFTER `npm ci` so the (expensive) dependency install
# layer stays cached across releases; only the build step is invalidated when
# VERSION changes. Skipped when VERSION="unknown" (local dev builds) so we
# don't clobber the checked-in version with a placeholder.
RUN if [ "${VERSION}" != "unknown" ]; then \
      npm pkg set version="${VERSION}" && \
      echo "Patched package.json version → ${VERSION}"; \
    fi

# Build the application
RUN npm run build

# Runtime dependencies only, installed straight from the lockfile. The
# production stage copies node_modules from HERE, not from the builder.
# It used to copy the builder's full node_modules (~370 MB with dev deps) and
# then `npm prune` it — but a later layer can't shrink an earlier one, so the
# dev deps stayed in the image (745 MB). --omit=dev skips the dev deps entirely.
FROM node:26-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Production stage
FROM node:26-alpine AS production

# Pull latest Alpine package fixes (e.g. OpenSSL) even when the base layer is cached
RUN apk -U upgrade --no-cache

# Create a non-root user for security
RUN addgroup -g 1001 -S autotask && \
    adduser -S autotask -u 1001 -G autotask

# Set working directory
WORKDIR /app

# Copy package files and built application from builder stage. package.json
# comes from the builder so it carries the VERSION patch applied above (not
# the stale on-disk version from the build context).
# --chown at COPY time: a later `chown -R /app` would rewrite every file into
# yet another layer and double the image again.
COPY --from=builder --chown=autotask:autotask /app/package*.json ./
COPY --from=builder --chown=autotask:autotask /app/dist ./dist
# SQL migrations for the optional Postgres layer (node dist/db/migrate.js reads ../../migrations).
COPY --chown=autotask:autotask migrations ./migrations
# Admin console web UI (served by dist/admin/server.js when MCP_ADMIN_ENABLED=true)
# and its host-side setup wizard (extract with: docker run --rm --entrypoint cat <image> /app/deploy/admin-setup.sh).
COPY --chown=autotask:autotask admin-ui ./admin-ui
COPY --chown=autotask:autotask deploy/admin-setup.sh ./deploy/admin-setup.sh
# Host-side updater (install: docker run --rm --entrypoint cat <image> /app/deploy/update-psarelay.sh > /usr/local/bin/update-psarelay).
COPY --chown=autotask:autotask deploy/update-psarelay.sh ./deploy/update-psarelay.sh
COPY --from=deps --chown=autotask:autotask /app/node_modules ./node_modules

# Remove the npm CLI from the production image — the runtime only needs `node`
# (CMD is `node dist/index.js`), and npm's bundled dependencies regularly trip
# vulnerability scanners. Done as root, before switching to the non-root user.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Create logs directory
RUN mkdir -p /app/logs && chown autotask:autotask /app /app/logs

# Switch to non-root user
USER autotask

# Expose port (if needed for future HTTP interface)
EXPOSE 8080

# Health check against the actual HTTP endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Set environment variables
ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV LOG_FORMAT=json
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_PORT=8080
ENV MCP_HTTP_HOST=0.0.0.0

# Define volume for logs
VOLUME ["/app/logs"]

# Start the application directly (HTTP transport doesn't need the stdio wrapper)
CMD ["node", "dist/index.js"]

# Build arguments for runtime
ARG VERSION="unknown"
ARG COMMIT_SHA="unknown" 
ARG BUILD_DATE="unknown"

# Labels for metadata
LABEL maintainer="GDS Technology"
LABEL version="${VERSION}"
LABEL description="PSArelay - Model Context Protocol server for Kaseya Autotask PSA"
LABEL org.opencontainers.image.title="psarelay"
LABEL org.opencontainers.image.description="Model Context Protocol server for Kaseya Autotask PSA integration"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.revision="${COMMIT_SHA}"
LABEL org.opencontainers.image.source="https://github.com/GDSTechnology/psarelay"
LABEL org.opencontainers.image.documentation="https://docs.psarelay.app"
LABEL org.opencontainers.image.url="https://github.com/GDSTechnology/psarelay/pkgs/container/psarelay"
LABEL org.opencontainers.image.vendor="GDS Technology"
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"

# MCP Registry ownership annotation (must match `name` in server.json)
LABEL io.modelcontextprotocol.server.name="io.github.gdstechnology/psarelay"
