# Phase 4 Node runtime

Phase 4 adds a long-lived Node HTTP process alongside the existing Cloudflare
Worker. The mobile app still reads InstantDB and calls the Worker. No mobile
route, VW protocol request, token policy, persistence model, or deployed Worker
was switched to Node. The Node runtime uses the same oRPC `router.ts`, InstantDB
`store.ts`, status poll and climate keepalive as the Worker. Its Node-specific
composition lives under `backend/node/`; the Worker entry remains
`backend/src/index.ts`.

## Start and configuration

From the repository root, `pnpm backend:node:build` bundles the Node entry into
ignored `dist/node/main.mjs`; `pnpm backend:node` builds and runs it.
Pass config through the process environment. Required values are
`INSTANT_APP_ID`, `INSTANT_ADMIN_TOKEN`, and `CREDS_ENC_KEY` (standard padded
base64 of exactly 32 bytes). The latter two are secrets; do not commit, log, or
expose them to the client. Optional Apple Maps signing values remain
`APPLE_MAPS_TEAM_ID`, `APPLE_MAPS_KEY_ID`, and `APPLE_MAPS_PRIVATE_KEY`; when
incomplete, parked-map URLs remain unavailable as in the Worker. These map to
the existing `AppEnv` type, so the current InstantDB integration is preserved.

| Node setting             | Default     | Meaning                                                                                                                         |
| ------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_HOST`              | `127.0.0.1` | Listen address. Set explicitly to `0.0.0.0` only behind a trusted private network or reverse proxy.                             |
| `NODE_PORT`              | `8788`      | TCP port, 1–65535 in production. Tests can use port 0 for an ephemeral listener.                                                |
| `NODE_SCHEDULER_ENABLED` | `false`     | Explicit opt-in to the Node poll and climate scheduler. Leave disabled while the Worker cron serves the same InstantDB account. |

`loadNodeConfig` validates config before the server starts and reports field
names without printing supplied secret values. Tests use synthetic config and
injected `Db`/job functions; that is the test configuration boundary. The
normal entry point uses the existing InstantDB admin client and VW jobs, so do
not run it with real credentials during offline validation. No secrets or
machine-specific paths are embedded in the bundle.

## HTTP and lifecycle

The Node built-in HTTP server uses the existing `@orpc/server/node` adapter;
there is no new web framework or API protocol. `/rpc` uses the same router,
Instant guest-token verification, context, and CORS plugin as the Worker.
`GET /health` returns only `{"status":"ok"}` and performs no database or VW
request. It is a process liveness check, not a database or vehicle readiness
claim. Other unknown paths return 404.

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
running both schedulers against the same InstantDB account would duplicate VW
polling and climate work. Keep the Node scheduler disabled until the cutover
plan assigns one scheduler owner.

## Offline checks and current limits

Run `pnpm backend:node:test` for deterministic config, local HTTP, oRPC, fake
clock, signal, and fail-closed network tests. `pnpm test:vw` remains the 54 VW
protocol plus 13 adapter/domain regression gate. `pnpm test` runs package
static checks, including Node typecheck, lint, and formatting. The HTTP tests
bind an ephemeral loopback port and inject synthetic InstantDB identity and
jobs; they do not contact InstantDB or Volkswagen.

This phase does not provide SQLite, device authentication, a mobile API cutover,
Docker packaging, live service credentials, or deployment. The Node API is
therefore a portability and lifecycle proof, not a safe public control API.
The esbuild tool is build-time only and has supported Linux ARM64 binaries in
the lockfile; the bundled runtime uses Node standard APIs and the existing
JavaScript dependencies. A future container must supply configuration and
secrets through its environment or mounted secret files.
