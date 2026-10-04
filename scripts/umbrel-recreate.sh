#!/usr/bin/env bash
# Operator helper for the approved BuzzKey deployment only. No VW/API calls.
set -euo pipefail
umask 077
cd /home/umbrel/umbrel/app-data/vwapp
phase=${1:-pre-vw}
case "$phase" in pre-vw|post-vw) ;; *) echo 'Usage: umbrel-recreate.sh [pre-vw|post-vw]' >&2; exit 1 ;; esac
compose=(sudo docker compose --env-file config/production.env -f deployment/compose.production.yaml -p buzzkey)
"${compose[@]}" config --format json | python3 -c 'import json,sys; s=json.load(sys.stdin)["services"]["buzzkey-backend"]; assert s["environment"]["BUZZKEY_SCHEDULER_ENABLED"]=="false"; assert s["environment"]["NODE_PUBLIC_ORIGIN"]=="https://umbrel.taila7541.ts.net:8443"; print("Disabled scheduler and exact origin verified")'
sudo docker logs buzzkey-buzzkey-backend-1 > "config/gate2-${phase}-before.log" 2>&1
"${compose[@]}" up -d --force-recreate --no-build --pull never --wait --wait-timeout 90
sudo docker inspect buzzkey-buzzkey-backend-1 > "config/gate2-${phase}-inspect.json"
sudo docker exec tailscale_web_1 tailscale serve status --json > "config/gate2-${phase}-serve.json"
sudo docker logs buzzkey-buzzkey-backend-1 > "config/gate2-${phase}.log" 2>&1
printf 'Recreate complete. Private verification reports saved. No VW requests made by this script.\n'
