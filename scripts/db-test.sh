#!/usr/bin/env bash
# Runs the kernel test suite in a throwaway PostgreSQL 16 container. Needs Docker with Compose v2.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose up -d --wait kernel-test
docker compose exec -T kernel-test bash /kit/scripts/kernel-test-in-container.sh
