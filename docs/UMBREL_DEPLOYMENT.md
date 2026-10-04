# First Umbrel deployment

This is the approved first-deployment configuration, with the scheduler disabled.
Use `compose.production.yaml` explicitly; the older `compose.yaml` enables scheduled
VW polling and is not appropriate for this milestone. No VW credentials or requests
are permitted before the separate Gate 2 approval. This file records the deployment
procedure, not evidence that deployment has succeeded.

## Approved host layout

Host: `umbrel.taila7541.ts.net` (Linux ARM64). Application root:
`/home/umbrel/umbrel/app-data/vwapp/`. All application directories are owned by
UID/GID 1000:1000 and mode 0700; configuration and key files are mode 0600.

- `data/`: persistent SQLite, mounted at `/data`; database is `buzzkey.sqlite`.
- `config/production.env`: non-secret Compose inputs, below.
- `secrets/master-key.b64`: fresh padded-base64 32-byte AES key, mounted read-only
  at `/run/secrets/buzzkey_master_key`. Generate with a cryptographic random source
  using exclusive file creation. Never overwrite an existing key, print it, store it
  in Git/image/SQLite, or include it in an ordinary database backup.
- `deployment/`: committed deployment configuration, bundled image archive and
  SHA-256 checksum/provenance. No production secrets belong in this directory.

The non-secret environment file contains:

```dotenv
BUZZKEY_IMAGE=buzzkey-backend:COMMITTED_REVISION
NODE_PUBLIC_ORIGIN=https://umbrel.taila7541.ts.net:8443
BUZZKEY_DATA_DIR=/home/umbrel/umbrel/app-data/vwapp/data
BUZZKEY_MASTER_KEY_FILE_HOST=/home/umbrel/umbrel/app-data/vwapp/secrets/master-key.b64
BUZZKEY_MASTER_KEY_ID=primary
```

Replace `COMMITTED_REVISION` with the exact commit used for the locally built ARM64
image. Build the main and auth-admin bundles with pinned pnpm, then the production
Dockerfile. Transfer the image with `docker save`/`docker load` and compare SHA-256
checksums. The production Compose file does not build or pull images implicitly.

## Operator start

Docker requires sudo on this host. Enter any sudo password only in the operator's
terminal. Before starting, verify the image archive checksum, free ports 8788/8443,
key ownership/permissions, and the existing Tailscale Serve configuration. A new
installation must have no previous BuzzKey database or container to replace.

From the application root, after loading the reviewed image:

```bash
sudo docker compose --env-file config/production.env -f deployment/compose.production.yaml -p buzzkey config --quiet
sudo docker compose --env-file config/production.env -f deployment/compose.production.yaml -p buzzkey up -d --no-build --pull never --wait --wait-timeout 90
```

The backend runs as UID/GID 1000:1000 with restart policy `unless-stopped`, a
90-second shutdown grace, and an HTTP healthcheck. Host port 8788 is bound only to
127.0.0.1. The scheduler is hard-coded false in this deployment file. No Docker
socket or privileged mode is exposed to BuzzKey.

## Private HTTPS

The existing port 443 Funnel route is unrelated and must remain untouched. The
approved route is private Tailscale Serve on port 8443, forwarding to loopback:

```bash
sudo docker exec tailscale_web_1 tailscale serve --bg --https=8443 http://127.0.0.1:8788
sudo docker exec tailscale_web_1 tailscale serve status
```

Do not run Serve reset or enable Funnel for BuzzKey. Capture Serve status as JSON
before and after the change and verify that only the new 8443 route was added,
that 8443 is not allowed in Funnel, and that the original 443 route is unchanged.
See [Tailscale Serve documentation](https://tailscale.com/docs/reference/tailscale-cli/serve).

`NODE_PUBLIC_ORIGIN` and the client origin must both be exactly
`https://umbrel.taila7541.ts.net:8443`, including the port. NIP-98 never derives this
from forwarded headers. Verify TLS and `/health` from an authorized tailnet client,
then anonymous rejection and signed device authentication without calling VW.
Any validation client needs its own dedicated private key kept only on that client;
it does not count as native iPhone validation.

## Gate 2 and persistence

Stop after deployment, private HTTPS, storage and device-auth checks. Request the
separate Gate 2 approval before provisioning or using real VW credentials. Keep
the scheduler disabled, even after that gate. Vehicle control/wake requests require
another explicit authorization after passive VW validation.

SQLite migrations must apply and `PRAGMA integrity_check` must report `ok`. Verify
non-root execution, narrow mounts, key read-only status, restart policy and absence
of restart loops. Check metadata/counts rather than dumping encrypted records or
credentials. A restart/recreate must retain application and authorized-device state.
Use the SQLite backup API (or stop the service before copying); keep the master
key separately protected and preserve its key ID. Never restore over the live
production database as part of this deployment check.
