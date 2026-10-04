# BuzzKey repository guidance

This is a personal, independent implementation of the North American myVW protocol for a 2025 ID. Buzz. `TODO.md` is a historical idea backlog and must be reconciled with the current architecture before use. Do not use real VW credentials or contact Volkswagen during offline development and validation.

## Supported runtime

The native Expo/React Native app uses `app/src/buzzkey-client.ts` and NIP-98 signing to call the Node API. `backend/node/main.ts` is the sole backend composition root; it persists state in SQLite, stores VW credentials and tokens as encrypted envelopes, and owns scheduled status polling and Camp Mode reconciliation when `BUZZKEY_SCHEDULER_ENABLED=true`. `/health` is public; API routes require authorized-device signatures. The public origin is configured, never inferred from forwarded headers. See `docs/SELF_HOSTED_BACKEND.md`.

## Commands

Use pinned pnpm 10.33.4 and Node 22. `pnpm test` is static validation. `pnpm test:vw`, `pnpm backend:node:test`, `pnpm backend:storage:test`, and `pnpm backend:auth:test` run deterministic offline tests. `pnpm backend:node:build` bundles the Node service; `pnpm --filter @vwapp/backend auth:admin:build` bundles the local pairing/revocation CLI. `pnpm --filter @vwapp/mobile start` runs Expo locally. Building the production container requires those two bundles; see the primary backend document. The scheduler defaults off outside production Compose.

## Boundaries

The VW protocol client in `backend/src/vw/client.ts` targets the North American identity/Car-Net stack. Keep protocol behavior fixed unless a separately authorized, characterized change requires it. VW responses are not proof of physical vehicle state. Commands and observations remain separate. The SQLite command ledger handles uncertain outcomes conservatively; see `docs/DOMAIN_MODEL.md`, `docs/VW_PROTOCOL_TEST_COVERAGE.md`, and `docs/CONTROL_CUTOVER.md`. `packages/poc` is exploratory and may issue live requests if run; it is not part of production or routine validation.

Keep credentials, key files, production SQLite data and local `.env` files out of Git and Docker build contexts. The master key must stay outside SQLite and outside the image. Pairing is a deliberate local operator action; never expose the admin CLI as an anonymous HTTP endpoint. Historical Phase 0 documents describe the removed Worker/InstantDB system and are not current operational instructions.
