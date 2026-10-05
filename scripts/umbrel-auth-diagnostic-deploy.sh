#!/usr/bin/env bash
# Deploy only the reviewed local diagnostic image. No VW requests or route changes.
set -euo pipefail
umask 077
cd /home/umbrel/umbrel/app-data/vwapp
revision=${1:-}
[[ "$revision" =~ ^[0-9a-f]{7,12}$ ]] || { echo 'Expected reviewed short Git revision' >&2; exit 1; }
[[ ! -e data/auth-diagnostic-20261004.used ]] || { echo 'Login budget already consumed; stop for review' >&2; exit 1; }
archive="buzzkey-backend-${revision}.tar"
(cd deployment && sha256sum -c "${archive}.sha256")
# Keep the existing runtime config/key and preserve a rollback config.
cp -p config/production.env config/auth-diagnostic-before.env
python3 - "$revision" <<'PY'
import pathlib,sys
p=pathlib.Path('config/production.env')
lines=p.read_text().splitlines()
assert sum(s.startswith('BUZZKEY_IMAGE=') for s in lines)==1
lines=[('BUZZKEY_IMAGE=buzzkey-backend:'+sys.argv[1]) if s.startswith('BUZZKEY_IMAGE=') else s for s in lines]
pathlib.Path('config/auth-diagnostic.env').write_text('\n'.join(lines)+'\n')
PY
chmod 600 config/auth-diagnostic.env
compose=(sudo docker compose --env-file config/auth-diagnostic.env -f deployment/compose.production.yaml -p buzzkey)
"${compose[@]}" config --format json | python3 -c 'import json,sys; s=json.load(sys.stdin)["services"]["buzzkey-backend"]; e=s["environment"]; assert e["BUZZKEY_SCHEDULER_ENABLED"]=="false"; assert e["NODE_PUBLIC_ORIGIN"]=="https://umbrel.taila7541.ts.net:8443"; assert e["BUZZKEY_AUTH_ATTEMPT_MARKER"]=="/data/auth-diagnostic-20261004.used"; assert s["user"]=="1000:1000"; assert len(s["ports"])==1 and s["ports"][0]["host_ip"]=="127.0.0.1"; print("Diagnostic safety configuration verified")'
sudo docker logs buzzkey-buzzkey-backend-1 > config/auth-diagnostic-before.log 2>&1
sudo docker exec tailscale_web_1 tailscale serve status --json > config/auth-diagnostic-before-serve.json
sudo docker load -i "deployment/${archive}"
expected=$(cat "deployment/${archive}.config-digest")
actual=$(sudo docker image inspect "buzzkey-backend:${revision}" --format '{{.Id}}')
[[ "$expected" == "$actual" ]] || { echo 'Image config digest mismatch; stop' >&2; exit 1; }
"${compose[@]}" up -d --force-recreate --no-build --pull never --wait --wait-timeout 90
cp config/auth-diagnostic.env config/production.env
chmod 600 config/production.env
sudo docker inspect buzzkey-buzzkey-backend-1 > config/auth-diagnostic-inspect.json
sudo docker exec tailscale_web_1 tailscale serve status --json > config/auth-diagnostic-serve.json
sudo docker logs buzzkey-buzzkey-backend-1 > config/auth-diagnostic.log 2>&1
sudo docker inspect buzzkey-buzzkey-backend-1 --format '{{.State.Health.Status}} image={{.Config.Image}} restarts={{.RestartCount}}'
printf 'Diagnostic deployment complete. No VW requests made by this helper.\n'
