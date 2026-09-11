#!/usr/bin/env bash
# Runs ON the VPS (as the forced command of the deploy key): update the checkout, rebuild, restart, verify.
# Safe to run by hand too:  bash deploy/vps-self-update.sh
set -euo pipefail
cd "$(dirname "$0")/.."
echo "== $(date -u +%FT%TZ) updating $(pwd)"
git fetch -q origin main && git reset -q --hard origin/main
echo "== at $(git log -1 --format='%h %s' | cut -c1-80)"
mkdir -p data && chown 1000:1000 data 2>/dev/null || true   # hosted-mode database volume, owned by the container's node user
docker compose up -d --build --remove-orphans 2>&1 | tail -2
for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
    echo "== healthy after ${i}x2s"; docker compose ps --format 'table {{.Name}}\t{{.Status}}'
    # Reclaim what rebuilds leave behind: dangling images older than a day and build cache beyond 4 GB (recent cache of other projects on the host stays).
    docker image prune -f --filter "until=24h" >/dev/null 2>&1 || true
    docker builder prune -f --reserved-space 4GB >/dev/null 2>&1 || true
    exit 0
  fi
  sleep 2
done
echo "!! container did not become healthy"; docker compose logs --tail 40; exit 1
