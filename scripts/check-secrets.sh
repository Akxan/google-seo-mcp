#!/usr/bin/env bash
# Secret / personal-data scan. Fails (exit 1) when a pattern matches.
#   scripts/check-secrets.sh            # scan files staged for commit
#   scripts/check-secrets.sh --all      # scan every tracked file
#   scripts/check-secrets.sh --tree <rev>  # scan a git tree (used before push)
# Generic patterns live below; machine-specific identifiers (your IP, usernames,
# domains, project IDs) go one-per-line into .secret-patterns.local (gitignored).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

GENERIC='AIza[0-9A-Za-z_-]{30,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY|"private_key_id"|"client_secret"|ssh-(rsa|ed25519) AAAA|BSA[A-Za-z0-9_-]{20,}|pplx-[A-Za-z0-9]{20,}|/Users/[a-z]+/|/home/[a-z0-9]+/|[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}:[0-9]{2,5}|[A-Za-z0-9._%+-]+@gmail\.com'
LOCAL=""
if [ -f .secret-patterns.local ]; then LOCAL=$(grep -vE '^\s*(#|$)' .secret-patterns.local | paste -sd'|' -); fi
PATTERN="$GENERIC"; [ -n "$LOCAL" ] && PATTERN="$GENERIC|$LOCAL"

# Files that legitimately contain example IPs / paths are excluded from the IP/path rules only via allowlist below.
ALLOW='^(package-lock\.json|test/tools\.snap\.json|scripts/check-secrets\.sh|\.githooks/.*)$'
# Placeholder / loopback values that are fine to publish.
BENIGN='127\.0\.0\.1|0\.0\.0\.0|1\.2\.3\.4|example\.com|/Users/<|/home/<'

mode="${1:-staged}"
status=0
scan() { # $1 = label, stdin = content
  local label="$1"
  local path="${label#*:}"   # strip "<rev>:" prefix used in --tree mode
  if echo "$path" | grep -qE "$ALLOW"; then cat >/dev/null; return; fi
  local hits
  hits=$(grep -nEi "$PATTERN" | grep -vE "$BENIGN" || true)
  if [ -n "$hits" ]; then
    echo "!! $label"; echo "$hits" | cut -c1-160 | sed 's/^/   /'; status=1
  fi
}
case "$mode" in
  --all) while IFS= read -r f; do [ -f "$f" ] && scan "$f" < "$f"; done < <(git ls-files) ;;
  --tree) rev="${2:-HEAD}"; while IFS= read -r f; do scan "$rev:$f" < <(git show "$rev:$f" 2>/dev/null); done < <(git ls-tree -r --name-only "$rev") ;;
  *) while IFS= read -r f; do scan "$f" < <(git show ":$f"); done < <(git diff --cached --name-only --diff-filter=ACMR) ;;
esac
if [ "$status" -ne 0 ]; then echo "Secret scan FAILED: remove the matches above (or add a legitimate example to the allowlist in scripts/check-secrets.sh)."; exit 1; fi
echo "secret scan ok ($mode)"
