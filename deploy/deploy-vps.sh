#!/usr/bin/env bash
# One-command update of a Docker deployment on a VPS.
#   deploy/deploy-vps.sh user@host [/opt/google-seo-mcp]
# Pulls the latest main, rebuilds the image, restarts the container and checks /healthz.
set -euo pipefail
HOST="${1:?usage: deploy-vps.sh user@host [remote_dir]}"
DIR="${2:-/opt/google-seo-mcp}"
ssh "$HOST" "set -e; cd '$DIR'; git pull --ff-only; docker compose up -d --build --remove-orphans; sleep 3; curl -fsS http://127.0.0.1:8787/healthz && echo && docker compose ps --format 'table {{.Name}}\t{{.Status}}'"
