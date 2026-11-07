#!/usr/bin/env bash
# Runs ON THE SERVER, from the repository checkout (the deploy workflow calls it over SSH):
#   deploy/deploy.sh <git sha>
# Order: update the code, take a backup, migrate, restart, check health. Migrations are forward-only, so a bad
# release is undone by deploying a fixed one, or by restoring the backup taken in step 2 (deploy/README.md).
set -euo pipefail
sha=${1:?usage: deploy.sh <git sha>}
cd "$(dirname "$0")/.."
[ -f deploy/.env ] || { echo "deploy/.env is missing: copy deploy/.env.example and fill it in" >&2; exit 2; }
cd deploy
export ERP_VERSION=${sha:0:12}

echo "== 1/5 code at $sha"
git -C .. fetch --prune origin
git -C .. checkout --detach "$sha"

echo "== 2/5 backup before migrating"
if docker compose ps --status running --services 2>/dev/null | grep -qx db; then
  docker compose build backup
  # Fails the deploy if backups are configured but the base backup fails. Not configured (a first, empty server): warns and goes on.
  docker compose run --rm -e REQUIRE_BACKUP=0 backup base
else
  echo "no running database yet: first deploy, nothing to back up"
fi

echo "== 3/5 build"
docker compose build api web migrate
docker compose pull db caddy

echo "== 4/5 migrate and restart"
docker compose up -d db
docker compose run --rm migrate
docker compose up -d api web caddy backup

echo "== 5/5 health"
for i in $(seq 1 40); do
  if docker compose exec -T api node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "healthy: erp $ERP_VERSION"; docker image prune -f >/dev/null; exit 0
  fi
  sleep 3
done
echo "the API did not become healthy; recent logs:" >&2
docker compose logs --tail 80 api >&2
exit 1
