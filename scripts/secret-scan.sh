#!/usr/bin/env bash
# Lightweight secret scan over tracked files (run before every push).
# Uses gitleaks if available, otherwise a grep-based fallback.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if command -v gitleaks >/dev/null 2>&1; then
  gitleaks detect --source . --no-banner --redact
  exit $?
fi

echo "gitleaks not found; using grep fallback" >&2
status=0
# Files that must never be tracked.
for pattern in '^\.env$' '^\.env\.[^e]' '(^|/)runtime/' 'id_(rsa|ed25519|ecdsa)$' '\.pem$' '\.key$' '\.zip$'; do
  if git ls-files | grep -Eq "$pattern"; then
    echo "TRACKED SENSITIVE FILE matches /$pattern/:" >&2
    git ls-files | grep -E "$pattern" >&2
    status=1
  fi
done
# Content patterns.
if git grep -nIE \
  -e 'BEGIN (RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY' \
  -e 'ghp_[A-Za-z0-9]{36}' -e 'github_pat_[A-Za-z0-9_]{20,}' \
  -e 'AKIA[0-9A-Z]{16}' -e 'sk-[A-Za-z0-9]{32,}' \
  -e 'xox[baprs]-[A-Za-z0-9-]{10,}' \
  -e 'Bearer [A-Za-z0-9._~+/=-]{40,}' \
  -- ':!scripts/secret-scan.sh' ':!*package-lock.json'; then
  echo "possible secret material above" >&2
  status=1
fi
[[ $status -eq 0 ]] && echo "secret scan: clean"
exit $status
