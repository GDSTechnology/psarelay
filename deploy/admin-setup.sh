#!/usr/bin/env bash
# PSArelay — admin console setup wizard.
#
# Run on the Docker host that runs the MCP (over SSH). It:
#   1. finds the MCP service in your compose project,
#   2. checks the Postgres layer is on (the console stores users there),
#   3. turns the console on (MCP_ADMIN_ENABLED / MCP_ADMIN_PORT in the env file),
#   4. runs the database migrations and restarts the MCP,
#   5. creates the first administrator with a GENERATED password (shown once),
#   6. optionally publishes the console through a Cloudflare Tunnel.
#
# Get the copy that matches your running image (no download from the internet):
#   docker run --rm --entrypoint cat ghcr.io/gdstechnology/psarelay:latest /app/deploy/admin-setup.sh > admin-setup.sh
#   less admin-setup.sh        # read it first
#   bash admin-setup.sh
#
# Re-running is safe: settings already in place are kept, migrations only apply
# what is new, and the first-admin step never overwrites an existing user.
#
# Options (all optional; the wizard asks for anything not given):
#   --dir <path>          compose project directory     (default: current dir)
#   --service <name>      PSArelay compose service      (default: psarelay, or an existing autotask-mcp)
#   --env-file <path>     env file the service reads    (default: detected)
#   --port <n>            console port in the container (default: 8090)
#   --admin <username>    first administrator           (default: admin)
#   --tunnel new|existing|none
#   -y, --yes             accept defaults, ask nothing that has a default

set -euo pipefail

# ── output helpers ─────────────────────────────────────────────────────────
if [ -t 1 ]; then B=$'\e[1m'; D=$'\e[2m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'; else B= D= G= Y= R= C= N=; fi
step()  { printf '\n%s━━ %s%s\n' "$B$C" "$1" "$N"; }
ok()    { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
warn()  { printf '  %s!%s %s\n' "$Y" "$N" "$1"; }
fail()  { printf '\n  %s✗ %s%s\n\n' "$R" "$1" "$N" >&2; exit 1; }
info()  { printf '  %s\n' "$1"; }

DIR="" SERVICE="" ENV_FILE="" PORT="" ADMIN_USER="" TUNNEL="" YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --service) SERVICE="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --admin) ADMIN_USER="$2"; shift 2 ;;
    --tunnel) TUNNEL="$2"; shift 2 ;;
    -y|--yes) YES=1; shift ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) fail "Unknown option: $1 (see --help)" ;;
  esac
done

# ask VAR "Question" "default"
ask() {
  local __var="$1" __q="$2" __def="${3:-}" __ans
  if [ -n "${!__var:-}" ]; then return; fi
  if [ "$YES" = 1 ] && [ -n "$__def" ]; then printf -v "$__var" '%s' "$__def"; return; fi
  read -r -p "  $__q${__def:+ [$__def]}: " __ans </dev/tty || true
  printf -v "$__var" '%s' "${__ans:-$__def}"
}
confirm() { # confirm "Question" (default yes)
  [ "$YES" = 1 ] && return 0
  local a; read -r -p "  $1 [Y/n]: " a </dev/tty || true
  [[ -z "$a" || "$a" =~ ^[Yy] ]]
}

printf '\n%sPSArelay — admin console setup%s\n' "$B" "$N"
info "${D}Nothing is changed until you confirm. Secrets are never printed.${N}"

# ── 1. find the service ────────────────────────────────────────────────────
step "1/6  Find the MCP"
command -v docker >/dev/null || fail "docker is not installed or not on PATH."
docker compose version >/dev/null 2>&1 || fail "The Docker Compose plugin (docker compose) is required."
docker info >/dev/null 2>&1 || fail "Cannot talk to Docker. Run as a user in the docker group, or with sudo."

ask DIR "Compose project directory" "$(pwd)"
[ -d "$DIR" ] || fail "No such directory: $DIR"
cd "$DIR"
[ -f docker-compose.yml ] || [ -f docker-compose.yaml ] || [ -f compose.yml ] || [ -f compose.yaml ] || fail "No docker-compose.yml / compose.yml in $DIR."
# psarelay on new installs; installs from before the rename keep their service name (autotask-mcp).
DEFAULT_SERVICE=psarelay
if [ -z "$(docker compose ps -q psarelay 2>/dev/null || true)" ] && [ -n "$(docker compose ps -q autotask-mcp 2>/dev/null || true)" ]; then DEFAULT_SERVICE=autotask-mcp; fi
ask SERVICE "PSArelay service name" "$DEFAULT_SERVICE"
CID="$(docker compose ps -q "$SERVICE" 2>/dev/null || true)"
[ -n "$CID" ] || fail "Service '$SERVICE' is not running in $DIR. Start it first (docker compose up -d $SERVICE)."
ok "Found '$SERVICE' (container $(docker inspect -f '{{.Name}}' "$CID" | sed 's#^/##'))"

dexec() { docker compose exec -T "$SERVICE" "$@"; }
dexec test -f dist/admin/cli.js 2>/dev/null || fail "This image has no admin console. Deploy a newer release first (see DEPLOY.md §4), then re-run."
ok "Image includes the admin console ($(dexec node -e "process.stdout.write(require('./package.json').version)" 2>/dev/null || echo '?'))"

# ── 2. Postgres ────────────────────────────────────────────────────────────
step "2/6  Check Postgres"
if [ "$(dexec printenv MCP_PG_ENABLED 2>/dev/null | tr -d '\r' | tr 'A-Z' 'a-z')" != "true" ]; then
  fail "The Postgres layer is off for '$SERVICE' (MCP_PG_ENABLED is not true).
    The console keeps its users and settings in Postgres. Set Postgres up first —
    docs/POSTGRES.md and DEPLOY.md (\"Postgres shadow\") — then re-run this wizard."
fi
[ -n "$(dexec printenv MCP_PG_MIGRATOR_PASSWORD 2>/dev/null)" ] || fail "MCP_PG_MIGRATOR_PASSWORD is not set for '$SERVICE' — migrations need it (see docs/POSTGRES.md)."
ok "Postgres layer is on"

# ── 3. env file ────────────────────────────────────────────────────────────
step "3/6  Turn the console on"
if [ -z "$ENV_FILE" ]; then
  DETECTED="$(docker compose config 2>/dev/null | awk -v s="  $SERVICE:" '
    $0==s {in_s=1; next}
    in_s && /^  [^ ]/ {in_s=0}
    in_s && /env_file:/ {in_e=1; next}
    in_s && in_e && /path:/ {sub(/.*path: */,""); gsub(/"/,""); print; exit}
    in_s && in_e && /^ +- / {sub(/^ +- /,""); gsub(/"/,""); print; exit}
    in_s && in_e && !/^ +(- |path:|required:)/ {in_e=0}')"
  if [ -z "$DETECTED" ]; then
    for f in "$DIR/psarelay.env" "$DIR/autotask-mcp.env" "$DIR/.env"; do [ -f "$f" ] && { DETECTED="$f"; break; }; done
  fi
  ask ENV_FILE "Env file the service reads (its env_file)" "${DETECTED:-$DIR/psarelay.env}"
fi
[ -f "$ENV_FILE" ] || fail "Env file not found: $ENV_FILE"
ask PORT "Console port inside the container" "8090"
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || fail "Port must be 1024–65535."
[ "$PORT" != "$(dexec printenv MCP_HTTP_PORT 2>/dev/null | tr -d '\r' || echo 8080)" ] || fail "Port $PORT is the MCP's own port — pick another (default 8090)."

current() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
set_var() {
  if grep -qE "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; else printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"; fi
}
if [ "$(current MCP_ADMIN_ENABLED)" = "true" ] && [ "$(current MCP_ADMIN_PORT)" = "$PORT" ]; then
  ok "Already enabled in $(basename "$ENV_FILE") (port $PORT)"
  CHANGED=0
else
  info "Will set in $ENV_FILE:"
  info "  ${B}MCP_ADMIN_ENABLED=true${N}"
  info "  ${B}MCP_ADMIN_PORT=$PORT${N}"
  confirm "Apply (a backup copy is saved next to it)?" || fail "Stopped — nothing changed."
  cp -p "$ENV_FILE" "$ENV_FILE.bak-$(date +%Y%m%d%H%M%S)"
  [ -n "$(tail -c1 "$ENV_FILE")" ] && echo >> "$ENV_FILE"
  grep -q '^# Admin console' "$ENV_FILE" || printf '# Admin console (admin-setup.sh)\n' >> "$ENV_FILE"
  set_var MCP_ADMIN_ENABLED true
  set_var MCP_ADMIN_PORT "$PORT"
  ok "Updated $(basename "$ENV_FILE") (backup kept)"
  CHANGED=1
fi

# ── 4. migrate + restart ───────────────────────────────────────────────────
step "4/6  Database migrations and restart"
docker compose run --rm --no-deps -T "$SERVICE" node dist/db/migrate.js 2>&1 | sed 's/^/    /' || fail "Migrations failed (output above)."
ok "Migrations applied"
if [ "$CHANGED" = 1 ] || ! dexec wget -qO- "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  docker compose up -d "$SERVICE" 2>&1 | sed 's/^/    /'
fi
printf '  Waiting for the console'
for _ in $(seq 1 30); do
  if dexec wget -qO- "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then printf '\n'; ok "Console is up on port $PORT inside the container"; UP=1; break; fi
  printf '.'; sleep 2
done
[ "${UP:-0}" = 1 ] || fail "The console did not come up. Check: docker compose logs --tail 50 $SERVICE
    (If '$SERVICE' does not read $(basename "$ENV_FILE") as its env_file, the setting never reached it.)"
# The restart above replaced the container: look its ID up again.
CID="$(docker compose ps -q "$SERVICE")"

# ── 5. first administrator ─────────────────────────────────────────────────
step "5/6  First administrator"
ask ADMIN_USER "Administrator username" "admin"
set +e
dexec node dist/admin/cli.js init "$ADMIN_USER"
RC=$?
set -e
case "$RC" in
  0) ok "Write the password down now — it is not stored anywhere readable and will not be shown again." ;;
  3) warn "Users already exist, so no new administrator was created."
     info "Lost the password? Run: docker compose exec $SERVICE node dist/admin/cli.js reset-password <username>" ;;
  *) fail "Could not create the administrator (exit $RC)." ;;
esac

# ── 6. Cloudflare Tunnel ───────────────────────────────────────────────────
# Guided: each Cloudflare dashboard step is shown, the wizard waits for Enter,
# then checks what it can from here. The same walkthrough, in more detail:
# docs/ADMIN.md "Cloudflare Tunnel, step by step".
step "6/6  Publish with Cloudflare Tunnel (optional)"
NET="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$CID" | head -1)"
if [ -z "$TUNNEL" ]; then
  info "1) Set up a NEW Cloudflare Tunnel for the console (guided, step by step)"
  info "2) I already run cloudflared: guide me through adding the route"
  info "3) Skip: keep the console private (SSH port-forward only)"
  # No default: pressing Enter must not silently skip the tunnel.
  if [ "$YES" = 1 ]; then CHOICE=3; else CHOICE=""; fi
  while [[ ! "$CHOICE" =~ ^[123]$ ]]; do
    read -r -p "  Choose 1, 2 or 3: " CHOICE </dev/tty || CHOICE=3
  done
  case "$CHOICE" in 1) TUNNEL=new ;; 2) TUNNEL=existing ;; *) TUNNEL=none ;; esac
  info "Tip: jump straight to this step later with:  bash $(basename "$0") --tunnel new"
fi

pause() { [ "$YES" = 1 ] && return 0; read -r -p "  ${D}Press Enter when done (Ctrl+C stops; re-running resumes safely)...${N}" _ </dev/tty || true; }
sub()   { printf '\n  %s%s%s\n' "$B" "$1" "$N"; }
HOST=""
ACCESS_OK=0

# Ask for the public hostname once and test it end to end from this host.
check_hostname() {
  sub "Check the hostname"
  local CODE LOC attempt
  ask HOST "The hostname you chose (e.g. mcp-admin.example.com)" ""
  HOST="${HOST#https://}"; HOST="${HOST#http://}"; HOST="${HOST%%/*}"
  [ -n "$HOST" ] || { warn "No hostname given, skipping the check."; return 0; }
  command -v curl >/dev/null || { warn "curl is not installed; open https://$HOST in a browser instead."; return 0; }
  for attempt in 1 2 3 4 5 6; do
    CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$HOST/healthz" || true)"
    LOC="$(curl -s -o /dev/null -w '%{redirect_url}' --max-time 10 "https://$HOST/healthz" || true)"
    case "$CODE" in
      200) ok "https://$HOST reaches the console."
           [ "$ACCESS_OK" = 1 ] || warn "Anyone on the internet reaches the sign-in page. Add Cloudflare Access (next) as a second lock."
           return 0 ;;
      302|303)
           if printf '%s' "$LOC" | grep -q 'cloudflareaccess.com'; then ok "https://$HOST is up and protected by Cloudflare Access."; ACCESS_OK=1; return 0; fi
           warn "https://$HOST redirects to $LOC, which is unexpected. Check the route's URL."; return 0 ;;
      000) info "  No answer from $HOST yet (attempt $attempt/6); a new DNS record can take a minute..." ;;
      502|503|504) info "  Cloudflare answers but cannot reach the console (HTTP $CODE, attempt $attempt/6)..." ;;
      530) info "  Cloudflare says the tunnel is down (HTTP 530 / error 1033, attempt $attempt/6)..." ;;
      *)   info "  Got HTTP $CODE (attempt $attempt/6)..." ;;
    esac
    sleep 10
  done
  warn "Could not confirm https://$HOST yet. Usual causes:"
  info "   530 / error 1033 : the tunnel is not connected (check the cloudflared logs)"
  info "   502              : the route's URL is wrong; it must be  $SERVICE:$PORT  with type HTTP"
  info "   no answer        : no DNS record; the domain must use Cloudflare DNS"
  info "   Fix it in the dashboard, then re-run this wizard (finished steps are skipped)."
}

route_steps() {
  sub "Add the route to the console"
  info "Cloudflare dashboard: ${B}Zero Trust > Networks > Tunnels${N}, click the tunnel,"
  info "then the ${B}Public hostname${N} tab > ${B}Add a public hostname${N}"
  info "(newer dashboards: the tunnel's ${B}Routes${N} > ${B}Add route${N} > ${B}Published application${N})."
  info "Fill in:"
  info "    Subdomain : ${B}mcp-admin${N}   (any name you like)"
  info "    Domain    : pick your domain from the list"
  info "    Path      : leave empty"
  info "    Type      : ${B}HTTP${N}      (not HTTPS: the tunnel already encrypts it)"
  info "    URL       : ${B}$SERVICE:$PORT${N}"
  info "Save. Cloudflare creates the DNS record by itself."
  info "${D}Only the console is published; /mcp and the webhook receiver use another port.${N}"
  pause
  check_hostname
}

access_steps() {
  [ "$ACCESS_OK" = 1 ] && return 0
  sub "Recommended: Cloudflare Access in front (a second lock)"
  info "${B}Zero Trust > Access > Applications > Add an application > Self-hosted${N}"
  info "    Application name : PSArelay"
  info "    Session duration : 24 hours"
  info "    Public hostname  : the same subdomain and domain as the route"
  info "Next > ${B}Add a policy${N}:"
  info "    Policy name : Team"
  info "    Action      : ${B}Allow${N}"
  info "    Include     : ${B}Emails ending in${N}  @your-company.com   (or list exact e-mails)"
  info "Next > keep the defaults > ${B}Add application${N}."
  info "Sign-in method: Zero Trust > Settings > Authentication. 'One-time PIN' works with no"
  info "setup (a code is e-mailed). Microsoft Entra ID or Google can be added later."
  pause
  check_hostname
  [ "$ACCESS_OK" = 1 ] || warn "Access is not protecting the hostname yet; you can add it any time."
}

case "$TUNNEL" in
  new)
    TDIR="$DIR/psarelay-admin-tunnel"
    # Installs from before the rename keep their tunnel directory (and so its compose project).
    [ -d "$DIR/autotask-mcp-admin-tunnel" ] && TDIR="$DIR/autotask-mcp-admin-tunnel"
    sub "Before you start, you need"
    info " - a Cloudflare account (the free plan is fine): https://dash.cloudflare.com/sign-up"
    info " - a domain whose DNS is ON Cloudflare (nameservers point to Cloudflare)."
    info "   Check: dashboard > your domain > Overview says ${B}Active${N}."
    info " - Zero Trust switched on once: dashboard > ${B}Zero Trust${N} > choose a team name and"
    info "   the ${B}Free${N} plan (Cloudflare may ask for a card even on Free; it is not charged)."
    pause

    sub "Create the tunnel"
    info "${B}Zero Trust > Networks > Tunnels > Create a tunnel${N}  (newer: Networking > Tunnels)"
    info "    Connector   : ${B}Cloudflared${N}"
    info "    Tunnel name : ${B}psarelay-admin${N}"
    info "Save. The next page shows install commands; choose the ${B}Docker${N} tab. It looks like"
    info "    docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token ${B}eyJh...${N}"
    info "Copy only the long part after ${B}--token${N}. ${Y}Do not run that command yourself${N}:"
    info "this wizard runs cloudflared for you, wired so it can reach the MCP container."
    if [ -f "$TDIR/.env" ] && grep -q '^TUNNEL_TOKEN=.' "$TDIR/.env" && confirm "A tunnel token is already saved in $TDIR/.env. Keep it?"; then
      ok "Keeping the saved token"
    else
      TOKEN=""
      read -r -s -p "  Paste the token here (input hidden): " TOKEN </dev/tty; echo
      TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"
      TOKEN="${TOKEN##*--token}"
      [ "${#TOKEN}" -ge 80 ] || fail "That does not look like a tunnel token (too short). Copy just the part after --token and re-run."
      [[ "$TOKEN" =~ ^[A-Za-z0-9+/=_-]+$ ]] || fail "That does not look like a tunnel token (unexpected characters)."
      mkdir -p "$TDIR"; umask 077
      printf 'TUNNEL_TOKEN=%s\n' "$TOKEN" > "$TDIR/.env"; chmod 600 "$TDIR/.env"; umask 022
      unset TOKEN
      ok "Token saved to $TDIR/.env (readable by its owner only)"
    fi
    cat > "$TDIR/docker-compose.yml" <<YAML
# Cloudflare Tunnel for the PSArelay admin console (written by admin-setup.sh).
# Its own compose project, so MCP deploys and updates never touch it.
# Joins the MCP's Docker network so it can reach $SERVICE:$PORT by name.
# The token is in .env next to this file (chmod 600); never commit it.
name: $(basename "$TDIR")
services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: \${TUNNEL_TOKEN}
    restart: unless-stopped
    networks: [mcp]
networks:
  mcp:
    external: true
    name: $NET
YAML
    (cd "$TDIR" && docker compose up -d 2>&1 | sed 's/^/    /')
    printf '  Waiting for the tunnel to connect'
    TUP=0
    for _ in $(seq 1 15); do
      if docker compose -f "$TDIR/docker-compose.yml" logs cloudflared 2>&1 | grep -qi 'Registered tunnel connection'; then printf '\n'; ok "Tunnel connected to Cloudflare"; TUP=1; break; fi
      printf '.'; sleep 2
    done
    if [ "$TUP" != 1 ]; then
      printf '\n'; warn "The tunnel has not connected yet. Last log lines:"
      docker compose -f "$TDIR/docker-compose.yml" logs --tail 8 cloudflared 2>&1 | sed 's/^/      /'
      info "  'Unauthorized' or 'invalid token': copy the token again and re-run this wizard."
    fi
    info "Refresh the Tunnels page in the dashboard: the tunnel should show ${G}HEALTHY${N}."
    pause
    route_steps
    access_steps ;;
  existing)
    sub "Let your cloudflared reach the MCP"
    info "Your cloudflared container must share a Docker network with '$SERVICE'. Run once:"
    info "    ${B}docker network connect $NET <your-cloudflared-container>${N}"
    info "(skip this if cloudflared runs in the same compose project as the MCP)."
    pause
    route_steps
    access_steps ;;
  *)
    LP=$(( PORT < 10000 ? 10000 + PORT : PORT ))
    info "The console is not published. To use it privately, publish the port on"
    info "localhost only. In the compose file, under '$SERVICE:', add to ports:"
    info "    ${B}- \"127.0.0.1:$LP:$PORT\"${N}     (then: docker compose up -d $SERVICE)"
    info "and from your workstation:  ${B}ssh -L $LP:127.0.0.1:$LP <this-host>${N}"
    info "then open http://localhost:$LP"
    info "Run this wizard again any time to add a Cloudflare Tunnel later." ;;
esac

printf '\n%s✓ Done.%s Sign in as %s%s%s, choose your own password, then add users under\n' "$G$B" "$N" "$B" "$ADMIN_USER" "$N"
printf '  Users (choose "Read-only" for people who only need the metrics).\n'
printf '  Updates keep all of this: users and settings live in Postgres, the console switch in\n'
printf '  %s, and the tunnel in its own folder. The routine deploy recreates only the MCP.\n\n' "$(basename "$ENV_FILE")"
