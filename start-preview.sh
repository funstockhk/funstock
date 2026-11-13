#!/usr/bin/env bash
# Start the FUNSTOCK internal preview (website + admin + local API).
# Does not change DNS, the live site, or the production spreadsheet.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
PORT="${PORT:-8787}"
export PORT
echo "Starting FUNSTOCK internal preview on http://127.0.0.1:${PORT}/"
echo "Admin login: http://127.0.0.1:${PORT}/admin/login.html"
echo "Test password is only in credentials.local.md (gitignored)."
echo "This is an internal preview. Production traffic is NOT switched on."
exec node "$ROOT/server/server.js"
