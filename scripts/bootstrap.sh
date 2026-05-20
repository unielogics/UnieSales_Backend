#!/usr/bin/env bash
# One-shot bootstrap for the UnieSales backend on a fresh EC2 clone.
# Assumes node 20, npm, pm2, git, and the AWS instance role are already in place
# (set up by the production configuration phase).
set -euo pipefail

cd "$(dirname "$0")/.."

echo "== npm install =="
npm ci || npm install

echo "== build =="
npm run build

echo "== migrate (will be a no-op until Phase 1) =="
npm run migrate

echo "== start under PM2 =="
pm2 startOrReload ecosystem.config.cjs
pm2 save

echo "== status =="
pm2 status

echo
echo "Done. Tail logs with: pm2 logs uniesales-api"
