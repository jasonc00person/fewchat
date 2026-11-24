#!/usr/bin/env bash
# Builds a fresh D1 database: schema.sql, then every migration in name order (the same order the tests use).
# Run once after `npx wrangler d1 create fewchat` (SETUP.md step 3). Pass --local to build the local dev DB instead.
set -euo pipefail
cd "$(dirname "$0")/.."
where="${1:---remote}"
npx wrangler d1 execute fewchat "$where" --file schema.sql -y
for f in $(ls migrations/*.sql | sort); do
  echo "→ $f"
  npx wrangler d1 execute fewchat "$where" --file "$f" -y
done
echo "Database ready."
