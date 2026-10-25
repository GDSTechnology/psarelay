#!/usr/bin/env bash
# update-psarelay — update PSArelay (only) to its latest published image.
#
# Named for this one server: a host often runs several MCPs, and this touches nothing but
# the PSArelay service. It refuses a container that isn't running the PSArelay image
# (or, during the rename, the image it was published under before: ghcr.io/gdstechnology/autotask-mcp).
#
# Run on the Docker host, as the user that runs the compose project. It:
#   1. refuses while a bulk job is PREPARING (a restart would fail the preparation;
#      running / paused jobs are fine and continue after the restart),
#   2. pulls the image; if nothing new, says so and changes nothing,
#   3. tags the image it is replacing as :rollback (before anything is pruned),
#   4. runs the database migrations (only what is new),
#   5. restarts the MCP, prunes old images, waits for /health and prints the version,
#   6. refreshes this script from the new image.
#
# Install once (the copy in the image — no download from the internet):
#   docker run --rm --entrypoint cat ghcr.io/gdstechnology/psarelay:latest /app/deploy/update-psarelay.sh > /usr/local/bin/update-psarelay
#   chmod +x /usr/local/bin/update-psarelay
# Then:   update-psarelay
#
# Options:
#   --recreate     restart even without a new image (after an env-file change)
#   --rollback     go back to the :rollback image (the one the last update replaced)
#   --force        update even while a bulk job is preparing
#   --dir <path>   compose project directory          (default: /opt/n8n, or MCP_DIR)
#   --service <s>  compose service                    (default: psarelay, else an existing autotask-mcp)
#   --container <c> MCP container                     (default: <project>-<service>-1)
#   --port <n>     host port of /health               (default: 18080)
#   --image <ref>  image repository                   (default: ghcr.io/gdstechnology/psarelay)

set -euo pipefail

DIR="${MCP_DIR:-/opt/n8n}"; SERVICE=""; CONTAINER=""; PORT="18080"
LEGACY_IMAGE="ghcr.io/gdstechnology/autotask-mcp"   # the name before the PSArelay rename (v4.0.0)
IMAGE="ghcr.io/gdstechnology/psarelay"; RECREATE=0; ROLLBACK=0; FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --recreate) RECREATE=1 ;;
    --rollback) ROLLBACK=1 ;;
    --force) FORCE=1 ;;
    --dir) DIR="$2"; shift ;;
    --service) SERVICE="$2"; shift ;;
    --container) CONTAINER="$2"; shift ;;
    --port) PORT="$2"; shift ;;
    --image) IMAGE="$2"; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

cd "$DIR"
# The service: psarelay on new installs; installs from before the rename keep their service name
# (n8n and tunnels reach the server by it), usually autotask-mcp.
if [ -z "$SERVICE" ]; then
  for s in psarelay autotask-mcp; do
    if docker inspect "$(basename "$DIR")-${s}-1" >/dev/null 2>&1; then SERVICE="$s"; break; fi
  done
  SERVICE="${SERVICE:-psarelay}"
fi
[ -n "$CONTAINER" ] || CONTAINER="$(basename "$DIR")-${SERVICE}-1"
# Only ever the PSArelay: the container must exist and run an image from ${IMAGE}.
RUNNING_IMAGE="$(docker inspect "$CONTAINER" --format '{{.Config.Image}}' 2>/dev/null || true)"
if [ -z "$RUNNING_IMAGE" ]; then echo "No container ${CONTAINER} — pass --dir / --service / --container for the PSArelay." >&2; exit 1; fi
case "$RUNNING_IMAGE" in
  "${IMAGE}"|"${IMAGE}:"*|"${LEGACY_IMAGE}"|"${LEGACY_IMAGE}:"*) ;;
  *) echo "${CONTAINER} runs ${RUNNING_IMAGE}, not the PSArelay (${IMAGE}) — refusing." >&2; exit 1 ;;
esac
say() { printf '\n== %s\n' "$*"; }
health() {
  local i out
  for i in $(seq 1 30); do
    out="$(curl -s --max-time 3 "http://127.0.0.1:${PORT}/health" || true)"
    if [ -n "$out" ]; then
      printf '%s\n' "$out" | sed -n 's/.*"version":"\([^"]*\)".*/version: \1/p'
      local level pct
      level="$(printf '%s\n' "$out" | sed -n 's/.*"backpressure":{"level":"\([a-z]*\)".*/\1/p')"
      pct="$(printf '%s\n' "$out" | sed -n 's/.*"backpressure":{.*"usedPct":\([0-9][0-9.]*\).*/\1/p')"
      # Right after a restart there is no usage reading yet (usedPct null): say so rather than print a blank.
      [ -n "$pct" ] && pct="${pct}%" || pct="not read yet (just restarted — the first sync takes it)"
      [ -n "$level" ] && echo "backpressure: ${level}, Autotask API usage ${pct}"
      return 0
    fi
    sleep 2
  done
  echo "/health did not answer within 60 s — check: docker compose logs --tail 50 ${SERVICE}" >&2
  return 1
}
running_version() { curl -s --max-time 3 "http://127.0.0.1:${PORT}/health" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' || true; }

# Bulk jobs still preparing? (asked inside the running MCP, with its own database settings)
preparing() {
  docker exec -w /app "$CONTAINER" node --input-type=module -e "
    const { getPool } = await import('/app/dist/db/pool.js');
    const quiet = { info() {}, warn() {}, error() {}, debug() {} };
    const p = getPool(quiet);
    if (!p) { console.log(0); process.exit(0); }
    try { const r = await p.query(\"SELECT count(*)::int n FROM bulk_job WHERE status = 'preparing'\"); console.log(r.rows[0].n); }
    catch { console.log(0); }
    await p.end();" 2>/dev/null || echo 0
}

if [ "$ROLLBACK" = 1 ]; then
  docker image inspect "${IMAGE}:rollback" >/dev/null 2>&1 || { echo "No ${IMAGE}:rollback image on this host." >&2; exit 1; }
  say "Rolling back from $(running_version) to the :rollback image"
  echo "Set the ${SERVICE} image to ${IMAGE}:rollback in ${DIR}/docker-compose.yml, then run:"
  echo "  cd ${DIR} && docker compose up -d ${SERVICE}"
  echo "(The compose file is yours to edit; this script does not change it. Put :latest back afterwards.)"
  exit 0
fi

say "PSArelay (${CONTAINER}) running now: $(running_version || echo unknown)"
if [ "$FORCE" = 0 ]; then
  n="$(preparing)"
  if [ "${n:-0}" != "0" ]; then
    echo "${n} bulk job(s) are PREPARING — a restart would fail them. Wait until they are 'Ready' (console → Bulk jobs), or re-run with --force." >&2
    exit 1
  fi
fi

# The key that encrypts secrets saved in the console (MCP_SECRET_KEY): add one to the PSArelay env file when there
# is none. Only an env file holding AUTOTASK_USERNAME is touched (never n8n's .env), with a backup first.
KEY_ADDED=0
if ! docker exec "$CONTAINER" printenv MCP_SECRET_KEY >/dev/null 2>&1; then
  for f in "$DIR/psarelay.env" "$DIR/autotask-mcp.env"; do
    [ -f "$f" ] && grep -q '^AUTOTASK_USERNAME=' "$f" || continue
    if ! grep -q '^MCP_SECRET_KEY=' "$f"; then
      cp -p "$f" "$f.bak-$(date +%F-%H%M%S)"
      KEY="$(openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64)"
      printf '\n# Encrypts secrets saved in the console (added by update-psarelay). Keep it: without it they must be re-entered.\nMCP_SECRET_KEY=%s\n' "$KEY" >> "$f"
      unset KEY
      say "Added MCP_SECRET_KEY to $(basename "$f") (backup kept)"
    fi
    KEY_ADDED=1
    break
  done
fi
[ "$KEY_ADDED" = 1 ] && RECREATE=1

say "Pulling ${IMAGE}:latest"
OLD="$(docker inspect "$CONTAINER" --format '{{.Image}}')"
docker compose pull "$SERVICE"
NEW="$(docker image inspect "${IMAGE}:latest" --format '{{.Id}}')"

if [ "$OLD" = "$NEW" ] && [ "$RECREATE" = 0 ]; then
  say "PSArelay is already on the latest image — nothing changed"
  health
  exit 0
fi

if [ "$OLD" != "$NEW" ]; then
  say "New image: keeping the current one as :rollback"
  docker tag "$OLD" "${IMAGE}:rollback"
  say "Database migrations"
  docker compose run --rm --no-deps -T "$SERVICE" node dist/db/migrate.js
  say "Restarting ${SERVICE}"
  docker compose up -d "$SERVICE"
  docker image prune -f >/dev/null
else
  say "Same image — recreating ${SERVICE} (--recreate, e.g. after an env change)"
  docker compose up -d --force-recreate "$SERVICE"
fi

say "Health"
health

# Keep this script current: take the copy from the image that now runs.
SELF="$(readlink -f "$0" 2>/dev/null || echo "$0")"
if [ -w "$SELF" ] && docker run --rm --entrypoint cat "${IMAGE}:latest" /app/deploy/update-psarelay.sh > "${SELF}.new" 2>/dev/null && [ -s "${SELF}.new" ]; then
  if ! cmp -s "${SELF}.new" "$SELF"; then chmod +x "${SELF}.new" && mv "${SELF}.new" "$SELF" && echo "(update-psarelay itself was updated from the new image)"; else rm -f "${SELF}.new"; fi
else rm -f "${SELF}.new" 2>/dev/null || true; fi
