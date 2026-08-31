#!/usr/bin/env bash
# Deploy = test + restart, in that order, always. The restart matters even for
# public/*-only changes: index.html's /js-<ver>/ cache-bust prefix is stamped at
# server startup, so without it clients (and Cloudflare) keep the old JS.
set -euo pipefail
cd "$(dirname "$0")"

npm test

sudo systemctl restart dowith
sleep 2
if systemctl is-active --quiet dowith; then
  echo "✓ deployed — dowith is active"
else
  echo "✗ dowith is NOT active — check: journalctl -u dowith -n 50" >&2
  exit 1
fi

# Publish committed work so the remote never drifts behind the Pi.
# Non-fatal: a deploy shouldn't fail because we're offline.
git push github master --quiet && echo "✓ pushed to github" || echo "⚠ push to github failed"
