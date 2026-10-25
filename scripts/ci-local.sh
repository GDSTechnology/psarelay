#!/usr/bin/env bash
# Run the CI workflow (.github/workflows/ci.yml) locally with Docker, before pushing.
#
#   scripts/ci-local.sh            # Node 20 + 22 test jobs and the Docker image build, one after another
#   scripts/ci-local.sh --parallel # all three at once (heavy: two full Jest runs + a build crashed Docker Desktop once)
#   scripts/ci-local.sh --quick    # one Node 22 test job only
#   scripts/ci-local.sh --arm64    # also build the arm64 image (QEMU; slow)
#
# Each test job runs in a clean node:<version> container on a COPY of the working tree (git-tracked files plus
# untracked ones that are not ignored), so local node_modules, dist and .env never leak in — like a fresh checkout.
# Exit code 0 only when every job passed. Logs: .ci-local/<job>.log
set -uo pipefail
# Git Bash on Windows rewrites /paths in arguments (docker -v / -w); turn that off and give Docker a native path.
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
QUICK=0; ARM=0; PAR=0
for a in "$@"; do case "$a" in --quick) QUICK=1 ;; --arm64) ARM=1 ;; --parallel) PAR=1 ;; -h|--help) sed -n '2,10p' "$0"; exit 0 ;; *) echo "unknown option $a" >&2; exit 2 ;; esac; done

OUT="$ROOT/.ci-local"; rm -rf "$OUT"; mkdir -p "$OUT/src"
# The source the jobs see: what a checkout of this commit (plus new files) would contain.
git ls-files -z --cached --others --exclude-standard | while IFS= read -r -d '' f; do [ -f "$f" ] && printf '%s\0' "$f"; done \
  | tar --null -T - -cf - | tar -xf - -C "$OUT/src"

HOST_SRC="$OUT/src"; command -v cygpath >/dev/null 2>&1 && HOST_SRC="$(cygpath -m "$OUT/src")"

test_job() { # $1 = node major
  docker run --rm -v "$HOST_SRC:/src:ro" -w /work "node:$1-bookworm" bash -c '
    set -e; cp -a /src/. /work/
    npm ci --no-audit --no-fund >/dev/null
    echo "== lint";        npm run lint 2>&1 | tail -3
    echo "== destructive"; node scripts/lint-destructive-warnings.mjs src
    echo "== build";       npm run build >/dev/null
    echo "== test"; set +e; npx jest --maxWorkers=50% > /tmp/test.log 2>&1; rc=$?; set -e
    grep -E "^(Tests|Test Suites):|FAIL|✕|●.*›" /tmp/test.log || tail -30 /tmp/test.log
    exit $rc' > "$OUT/node$1.log" 2>&1
}
docker_job() {
  local platforms="linux/amd64"; [ "$ARM" = 1 ] && platforms="linux/amd64,linux/arm64"
  docker buildx build --platform "$platforms" --provenance=false --build-arg VERSION=ci-local --build-arg COMMIT_SHA="$(git rev-parse HEAD)" "$HOST_SRC" > "$OUT/docker.log" 2>&1
}

JOBS=(node22); [ "$QUICK" = 1 ] || JOBS=(node20 node22 docker)
run() { case "$1" in node20) test_job 20 ;; node22) test_job 22 ;; docker) docker_job ;; esac; }
FAIL=0
report() { if [ "$2" = 0 ]; then echo "PASS  $1"; else echo "FAIL  $1  (see .ci-local/$1.log)"; FAIL=1; fi; }
if [ "$PAR" = 1 ]; then
  declare -A PIDS; for j in "${JOBS[@]}"; do run "$j" & PIDS[$j]=$!; done
  for j in "${JOBS[@]}"; do wait "${PIDS[$j]}"; report "$j" $?; done
else
  for j in "${JOBS[@]}"; do run "$j"; report "$j" $?; done
fi
for j in node20 node22; do [ -f "$OUT/$j.log" ] && grep -E "^(Tests|Test Suites):" "$OUT/$j.log" | sed "s/^/  $j  /"; done
exit $FAIL
