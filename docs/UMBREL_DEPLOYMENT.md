# First Umbrel deployment

This is the approved first-deployment configuration, with the scheduler disabled.
Use `compose.production.yaml` explicitly; the older `compose.yaml` enables scheduled
VW polling and is not appropriate for this milestone. No VW credentials or requests
are permitted before the separate Gate 2 approval. The verification record below distinguishes completed checks from the remaining
live-account milestone.

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
checksums. Docker image stores can report different kinds of image ID: the development
containerd store reports the OCI manifest digest, while a classic Docker store may
report the configuration digest referenced by that manifest. For a load-time ID
check, derive the expected configuration digest from the verified archive; do not
assume the development machine's `.Id` is portable. Record both digests in deployment
provenance. The production Compose file does not build or pull images implicitly.

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

## Gate 1 verification — 2026-10-04

The approved image built from commit `a4885656568eb0210ab34748ea8e62420d8a2ba6`
is running on Umbrel. Host Docker is 28.5.0, Compose is 5.5.1, architecture is
ARM64. The image archive SHA-256 matched after transfer. The initial deployment
stopped safely at an image-ID check because the two Docker image stores expose
different digests; the corrected check accepts the verified manifest or config
digest. No application or VW protocol change was needed.

Verified remotely and from the authorized Mac tailnet client:

- Container healthy, UID/GID 1000:1000, restart policy `unless-stopped`, zero
  restarts at inspection, 90-second stop timeout, no privileged mode or Docker
  socket, only loopback port 8788 published.
- Private HTTPS health returns 200 with successful TLS verification. Tailscale
  configuration comparison confirms all preexisting routes, including the public
  port 443 Funnel route, are unchanged; BuzzKey port 8443 has no Funnel permission.
- Seven SQLite migrations applied; integrity check returns `ok`. Data resides on
  the approved persistent mount. Directories are 0700 and config/key files 0600,
  owned by 1000:1000. The 32-byte master key is external and mounted read-only.
- Thirteen real-environment readiness checks passed: health, anonymous and
  unpaired-client rejection, dedicated-client pairing, pairing-token reuse
  rejection, signed API success, replay rejection, incorrect origin despite
  forwarded headers, URL/method/body tampering, expired signature, and a fresh
  signed request after the rejection checks. These use only pairing, health and
  SQLite-only passive endpoints.
- One dedicated Mac validation client and replay records persisted after opening
  SQLite separately. The private client key stays on the Mac with mode 0600 in a
  private directory; it was not sent to the backend. The consumed pairing token
  file was removed. Native iPhone validation remains pending.
- Startup log inspection found the expected scheduler-disabled message and no
  master-key exposure. Post-authentication container logs have not been separately
  collected. Twenty-five existing offline auth tests also passed.
- Scheduler remains disabled. Account, account-secret, vehicle, command and
  climate-session tables remain empty. No Volkswagen requests or vehicle controls
  were issued.

Gate 2 is the next mandatory stop: real VW credential provisioning and passive
VW validation require separate approval. Real VW encryption/persistence, a
container restart/recreate persistence test and a production backup check remain
pending; the current checks do not claim those later milestones are complete.

## Gate 2 local credential entry

Gate 2 was explicitly approved on 2026-10-04. Before credential entry, a forced
container recreate passed: the container ID changed, HTTPS health and the existing
Mac client's signed request succeeded, migrations and device records persisted,
the protected external key remained identical, and scheduler/Serve settings were
unchanged. No VW account existed at this check.

Run `scripts/provision-vw.py` directly in the Mac terminal with `--origin` set to
the approved HTTPS origin and `--device-key` pointing to the dedicated paired Mac
client's protected key file. Python hides username, password and S-PIN input and
refuses noninteractive input or an echo fallback. Values are sent through child
stdin to the local signing client, then through exact-body NIP-98 over verified
HTTPS; they are never command-line arguments, environment variables or files.
The helper prints only a sanitized success summary or failure category.

The client checks public health and cached account state, refuses an already
provisioned account, and submits at most one credentials request followed by one
S-PIN connect request. The existing backend authenticates, immediately stores the
successful reusable session/credentials in AES-256-GCM envelopes, then performs
its existing initial passive status read. Existing backend token/session fallback
behavior remains unchanged. The helper has no reconnect/retry loop and calls no
vehicle control, wake or forced-refresh endpoint. A failure or client timeout
requires sanitized server-state review before any further attempt; a client timeout
does not prove that an already-running server request was cancelled.

Nine deterministic offline helper tests cover signed payloads, fixed request scope,
failed authentication/connect without retries, existing-account refusal, missing
attempt/status failures, invalid input/origin, sanitized transport errors and
noninteractive-input refusal. These do not claim live VW compatibility.

For the later post-authentication recreate and log capture, the committed helper
`scripts/umbrel-recreate.sh post-vw` (staged under `deployment/` on Umbrel) saves the
old container logs before recreating, then records the new container and Serve
configuration and startup logs. It verifies disabled scheduling before starting.
Passwords for sudo are entered only into the operator's terminal.
