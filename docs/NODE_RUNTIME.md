# Node runtime (Phases 4–6B)

The long-lived Node HTTP process sits beside the existing Cloudflare Worker.
The mobile app still reads InstantDB and calls the Worker. Phase 6B moves only
Node application persistence to SQLite; the Worker entry and its InstantDB
store remain in place. Both runtimes reuse the existing oRPC router, VW protocol
client, status poll and climate keepalive. See [Node SQLite cutover](NODE_SQLITE_CUTOVER.md).

Phase 6A connects the offline-tested owner-device authentication module under
`backend/auth/` to the Node entrypoint. Every Node `/rpc` request now requires
an authorized NIP-98 signature; SQLite holds devices, pairing sessions, and
replay IDs. The Worker retains its previous authentication path. See
[authentication](AUTHENTICATION.md) for the signed-request and pairing policy.

## Start and configuration

From the repository root, `pnpm backend:node:build` bundles the Node entry into
ignored `dist/node/main.mjs`; `pnpm backend:node` builds and runs it.
Pass config through the process environment. Required values are
`NODE_PUBLIC_ORIGIN`, `BUZZKEY_SQLITE_PATH`, `BUZZKEY_MASTER_KEY_ID`, and
exactly one of `BUZZKEY_MASTER_KEY_FILE` or `BUZZKEY_MASTER_KEY_B64` (standard
padded base64 of exactly 32 bytes). Keep the master key outside Git and the
client. Node needs no InstantDB configuration. Optional Apple Maps signing values remain
`APPLE_MAPS_TEAM_ID`, `APPLE_MAPS_KEY_ID`, and `APPLE_MAPS_PRIVATE_KEY`; when
incomplete, parked-map URLs remain unavailable as in the Worker.

| Node setting                                          | Default     | Meaning                                                                                                                         |
| ----------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_HOST`                                           | `127.0.0.1` | Listen address. Set explicitly to `0.0.0.0` only behind a trusted private network or reverse proxy.                             |
| `NODE_PORT`                                           | `8788`      | TCP port, 1–65535 in production. Tests can use port 0 for an ephemeral listener.                                                |
| `NODE_SCHEDULER_ENABLED`                              | `false`     | Explicit opt-in to the Node poll and climate scheduler. Leave disabled while the Worker cron serves the same InstantDB account. |
| `NODE_PUBLIC_ORIGIN`                                  | required    | Exact external HTTPS origin used for NIP-98 URL checks; never derived from Host or forwarded headers.                           |
| `BUZZKEY_SQLITE_PATH`                                 | required    | Persistent SQLite path for device authentication and application state. Production rejects `:memory:`.                          |
| `BUZZKEY_MASTER_KEY_ID`                               | required    | Identifier for the active AES-256-GCM secret-encryption key.                                                                    |
| `BUZZKEY_MASTER_KEY_FILE` or `BUZZKEY_MASTER_KEY_B64` | required    | Supply exactly one protected 32-byte master key source.                                                                         |

`loadNodeConfig` validates config before the server starts and reports field
names without printing supplied secret values. Tests use synthetic config and
injected SQLite/jobs; that is the test configuration boundary. The normal
entry point can invoke existing VW jobs when explicitly configured, so do not
run it with real credentials during offline validation. No secrets or
machine-specific paths are embedded in the bundle.

## HTTP and lifecycle

The Node built-in HTTP server verifies the exact request bytes with NIP-98,
then passes an authenticated request to the existing oRPC fetch adapter. There
is no new web framework or application protocol. `/rpc` uses the same router
and context shape as the Worker. Each authorized NIP-98 device maps to the
single SQLite owner identity. Node does not verify an Instant guest token;
`X-Instant-Token` and old `Authorization: Bearer` headers cannot authorize Node
RPC. `POST /auth/pair` accepts only a signed candidate-key
request with a valid one-use token issued by the local operator tool.
`GET /health` returns only `{"status":"ok"}` and performs no database or VW
request. It is a process liveness check, not a database or vehicle readiness
claim. Unknown paths require authentication before returning 404.

The server listens before the optional scheduler starts. When enabled, the
scheduler ticks every 60 seconds, invoking the existing status poll and
climate keepalive concurrently. One tick must finish before another begins;
a missed interval is skipped rather than overlapped. Individual job failures
are reported and the next tick remains eligible. `SIGTERM` and `SIGINT` stop
future ticks, stop accepting requests, and wait for active requests/jobs to
finish. The current VW HTTP calls have no universal deadline, so an
indefinitely hung job could delay shutdown; command deadlines and durable
recovery belong to later phases.

The Worker continues to use its own `fetch` and `scheduled` handlers,
ExecutionContext, Wrangler config, generated types, and `waitUntil`. Node has
no Worker runtime globals. Both runtimes can exist in the repository, but
running both schedulers against the same VW account would duplicate VW
polling and climate work. Keep the Node scheduler disabled until the cutover
plan assigns one scheduler owner.

## Offline checks and current limits

Run `pnpm backend:node:test` for deterministic config, local HTTP, oRPC, fake
clock, signal, and fail-closed network tests. `pnpm test:vw` remains the 54 VW
protocol plus 13 adapter/domain regression gate. `pnpm test` runs package
static checks, including Node typecheck, lint, and formatting. The HTTP tests
bind an ephemeral loopback port and inject synthetic SQLite identity and
jobs; they do not contact InstantDB or Volkswagen.

The Node entrypoint uses SQLite for authentication and application persistence.
The mobile app still calls the Worker and reads InstantDB. Docker packaging,
live service credentials, reverse-proxy validation, mobile signed transport,
and deployment remain future work. Keep Node bound to loopback until the
private HTTPS and host access policy is reviewed and tested.
The esbuild tool is build-time only and has supported Linux ARM64 binaries in
the lockfile; the bundled runtime uses Node standard APIs and the existing
JavaScript dependencies. A future container must supply configuration and
secrets through its environment or mounted secret files.
