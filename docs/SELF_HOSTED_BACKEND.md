# Self-hosted BuzzKey backend

## Architecture and status

The supported path is native BuzzKey app → exact-body NIP-98 over an external HTTPS origin → Node 22 HTTP API → local SQLite → the North American VW service. Node is the sole backend and sole scheduler. The phone never calls VW directly. Cloudflare Worker, Wrangler, InstantDB and EAS are absent from the supported runtime. Expo remains for the native application; future iOS distribution uses a local Xcode build. This milestone prepared and tested the image locally but did **not** deploy, pair a real device, use real VW credentials or make a live VW request.

`backend/node/main.ts` loads and validates configuration before opening storage. `backend/node/runtime.ts` exposes public `/health`, narrowly scoped `/auth/pair`, and NIP-98-protected `/api/v1/*`; removed `/rpc/*` routes have no fallback. The authenticated account, passive data and durable control APIs compose against `backend/node/sqlite-store.ts`, `backend/storage/` and `backend/auth/`. The VW client and protocol remain unchanged. The normal startup is `node /app/main.mjs` in the container or `pnpm backend:node` for local use. The local admin bundle `node /app/auth-admin.mjs issue|list|revoke DEVICE_ID` manages pairing and revocation against the mounted database; use it only during a later authorized deployment.

## Configuration and secrets

`NODE_HOST` defaults to `127.0.0.1` locally and is `0.0.0.0` inside the container. `NODE_PORT` defaults to `8788`. `NODE_PUBLIC_ORIGIN` is mandatory and must be a canonical **HTTPS origin**, such as `https://buzzkey.example-tailnet.ts.net`, with no path. NIP-98 verifies the exact configured origin plus raw path/query; it never trusts arbitrary `Host` or `X-Forwarded-*` values. The app's `EXPO_PUBLIC_NODE_ORIGIN` must match it exactly. Future Tailscale Serve (or equivalent private HTTPS) should forward that origin to the host's loopback-published port. Do not enable Funnel or publish the port to the public Internet. No Tailscale configuration was made in this milestone.

`BUZZKEY_SQLITE_PATH` is mandatory and must name a persistent file in production. The container uses `/data/buzzkey.sqlite`. `BUZZKEY_MASTER_KEY_ID` is a short identifier. Supply exactly one of `BUZZKEY_MASTER_KEY_FILE` or `BUZZKEY_MASTER_KEY_B64`; Compose mounts a file at `/run/secrets/buzzkey_master_key`, separate from `/data` and the image. The file contains padded base64 of exactly 32 random bytes. At the later deployment, an operator can create it with `openssl rand -base64 32` and save it with restrictive permissions readable by container UID 1000. Do not commit, echo or paste a production key into a command argument or Compose file. Losing that key makes encrypted VW credentials and tokens unrecoverable even if the database survives. Rotating it requires the existing tested re-encryption flow and a verified backup, not a new key file dropped onto an old database.

`BUZZKEY_SCHEDULER_ENABLED` defaults to `false` for local/test runs. The production Compose service sets it to `true`; this is the single owner of periodic vehicle polling, climate/Camp Mode keepalive and reconciliation. The fixed cadence is 60 seconds. Ticks do not overlap; shutdown waits for in-flight scheduler and command work. On restart, durable command/Camp state is reconciled. A missing or invalid origin, database path or key fails startup before serving traffic. The basic `/health` response proves only HTTP liveness, not VW connectivity or vehicle freshness. Logs should not dump environment values, request bodies or keys.

## Build and Compose layout

Use the repository's pinned `pnpm@10.33.4` and lockfile to build the two production bundles. The Dockerfile pins `node:22.23.3-bookworm-slim` to the locally validated ARM64 image digest; its default `production` stage copies only the bundles and runs as the image's non-root `node` user. The separate `Dockerfile.smoke` builds a synthetic test image from the production image; the production Dockerfile never requires that test bundle. The `.dockerignore` sends only these bundles to the daemon; no source secrets, `.env`, fixtures or dependency tree enter the image. Keep package-manager and dependency installation outside the runtime image:

```bash
pnpm install --frozen-lockfile
pnpm backend:node:build
pnpm --filter @vwapp/backend auth:admin:build
docker build --platform linux/arm64 --target production -t buzzkey-backend:local .
```

`compose.yaml` builds the `production` target, restarts unless stopped, publishes only `127.0.0.1:${BUZZKEY_HOST_PORT:-8788}:8788`, mounts `${BUZZKEY_DATA_DIR}` to `/data`, and mounts `${BUZZKEY_MASTER_KEY_FILE_HOST}` read-only as the key file. Copy `.env.example` to a local ignored `.env` and set actual **non-secret** host paths, trusted origin, key ID and port. Create and permission the data directory and secret file for UID 1000 before starting. Do not put the master key or VW credentials in `.env`. The Compose healthcheck calls `http://127.0.0.1:8788/health` inside the container with no secret or vehicle data. No Docker socket, privileged mode or broad host mount is required. This is a portable Docker Compose service, not an Umbrel App Store package; `/home/umbrel/umbrel/app-data/vwapp/data` is one possible future host directory, never a hard-coded application path.

A future operator will transfer or build the validated image and Compose inputs on the ordinary UmbrelOS Linux/Docker host, provision the external key and data directory, configure private HTTPS/Tailscale Serve, confirm access restrictions, then start the service. That procedure is **not** part of this milestone.

## Persistence and backup

SQLite WAL files live beside `/data/buzzkey.sqlite`; keep the entire `/data` directory persistent and writable by UID 1000. `backend/storage/database.ts` applies immutable, checksum-verified migrations transactionally and offers a SQLite backup API. Prefer an application-consistent SQLite backup or stop the service before copying the database; copying only the main file while WAL writes are active can lose data. Back up the database and the separately protected AES key together, store them securely, and test a restore to an isolated host before relying on it. Preserve the key ID and exact key bytes. Restoration of an older DB may resurrect device authorizations, undo revocations, and restore stale replay/idempotency records; treat a restored auth state as sensitive, review/revoke devices and avoid replaying uncertain vehicle commands. Command history, vehicle observations, analytics, climate sessions and account state persist in SQLite; retention and pruning follow repository logic, so a backup should be sized and handled as sensitive location/activity history. There is no cloud backup service.

## Linux ARM64 validation

The local Docker daemon reported Linux `aarch64`; the validation explicitly built and ran `--platform linux/arm64` with `--network none`. Node v22.23.3 loaded built-in `node:sqlite`, created the external-volume database, applied seven migrations, encrypted and decrypted a synthetic secret, served public health and a signed protected API, rejected replay and revocation, ran scheduler lifecycle/failure checks, stopped cleanly on SIGTERM, and failed closed on missing origin. The production image and separate smoke image both built. The smoke command uses a disposable Docker volume and synthetic key; no VW endpoint was contacted. Production Umbrel/Tailscale/iPhone/VW interoperability remains unverified.

To repeat the synthetic test after building the two production bundles, build the test bundle with `pnpm --filter @vwapp/backend container:smoke:build`, then run:

```bash
docker build --pull=false --network=none --platform linux/arm64 --file Dockerfile.smoke -t buzzkey-backend:arm64-smoke .
docker run --pull never --rm --network none --platform linux/arm64 --tmpfs /data:uid=1000,gid=1000 buzzkey-backend:arm64-smoke
```

This uses the local pinned base image and an ephemeral data mount. The production image was also started directly with synthetic configuration; Docker reported it healthy, running as `node`, and it exited with code 0 after SIGTERM.

The local Docker installation did not include the Compose CLI plugin. `compose.yaml` was statically inspected/parsed and follows the service layout above, but `docker compose config` and an actual Compose start were not run. Treat Compose execution on the future host as a deployment gate.

## Residual operational risks

The Node 22 `node:sqlite` API remains marked experimental by Node. This is a single-writer design; do not run multiple backend replicas against one database. A compromised host or mounted master-key file can expose reusable VW secrets; the non-root user, narrow mounts and private network reduce accidental exposure but do not defend a compromised host. The Dockerfile is intentionally bundle-based: rebuild the pinned-pnpm bundles before `docker build` or Compose build; a raw Compose build from a fresh clone without `dist/node/*` is expected to fail, not download dependencies silently. Validate the bundle provenance before deployment. Container stdout may include application diagnostics; restrict log access and retention.
