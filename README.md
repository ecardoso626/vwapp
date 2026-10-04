# BuzzKey

BuzzKey is a personal native app for a North American VW ID. Buzz. It uses an independently implemented myVW protocol; Volkswagen does not endorse or support it.

The supported architecture is:

```text
BuzzKey iPhone app → NIP-98 signed HTTPS API → Node 22 → SQLite → Volkswagen
```

The Node service is the only backend, the only scheduler, and the only writer to its SQLite database. The phone reads cached state and submits commands through the same API. A local persistent directory holds SQLite data; the AES master key is supplied separately. Cloudflare, InstantDB and EAS are not required. The retained Expo libraries support the local native app workflow. No deployment or live VW validation has been performed for this container milestone.

## Local development and checks

Use the pinned pnpm 10.33.4 from `package.json` with Node 22. The service fails closed until a trusted external HTTPS origin, persistent database path and master key are configured. See [self-hosted backend](docs/SELF_HOSTED_BACKEND.md) for configuration and container instructions.

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm test:vw
pnpm backend:node:test
pnpm backend:storage:test
pnpm backend:auth:test
pnpm backend:node:build
pnpm --filter @vwapp/backend auth:admin:build
pnpm --filter @vwapp/mobile start
```

`pnpm test` runs static checks; the test commands run offline synthetic fixtures. Never put real VW credentials in test files or run the exploratory `packages/poc` probes as part of validation.

## Repository

- `app/`: Expo/React Native app, BuzzKey client, local device signing key and UI.
- `backend/node/`: Node HTTP API, account/control orchestration and single scheduler.
- `backend/auth/`, `backend/storage/`: authorized devices, replay/rate limits and SQLite with encrypted secrets.
- `backend/src/vw/`: North American VW protocol implementation, preserved by this cleanup.
- `packages/contract/`: shared domain and API types.
- `packages/poc/`: historical exploratory reference, not the production backend.

The production Docker image and standalone Compose file are prepared for a future ordinary Linux/Docker host, including an UmbrelOS machine. They have not been deployed. [Architecture](ARCHITECTURE_CURRENT.md), [security](SECURITY_NOTES.md), and [migration history](MIGRATION_PLAN.md) give further context.
