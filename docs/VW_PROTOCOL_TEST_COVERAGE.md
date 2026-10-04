# VW protocol and Node control coverage

All VW tests are deterministic and offline. `backend/tests/register.mjs` installs a fail-closed global `fetch`; the ordered synthetic request queue in `backend/tests/harness.mjs` rejects any unexpected URL or call. No credentials, VINs or responses in fixtures come from a live account. `pnpm test:vw` does not start a server. The Node/storage/auth suites use synthetic keys, an in-memory or temporary SQLite database, and their own offline network harnesses.

## Retained protocol characterization

The current `pnpm test:vw` suite runs 44 test cases, including adapter/domain cases. The core VW protocol cases in `backend/tests/auth.test.mjs`, `commands.test.mjs`, `session.test.mjs` and `status.test.mjs` remain intact apart from adapting the session test's persistence mock to the sole SQLite store interface. The production VW protocol source `backend/src/vw/client.ts` was not changed. The Worker-only router fixture and its 16 tests were removed because the Worker router no longer exists; equivalent permanent-path charging, climate/Camp, lock, wake and command/error coverage lives under `backend/node/tests/`. One mobile legacy Worker gate test was also removed because that provider was deleted.

| Area | Current offline evidence |
| --- | --- |
| OAuth, tokens and S-PIN | Exact NA login/PKCE/cookie redirects, refresh and original verifier, S-PIN challenge/hash, remaining-attempt guard, carnet token reuse/re-mint and status retry. |
| Discovery and status | Garage UUID/VIN selection, wrapped response normalization, RVS/EV reads, security/closures, battery/charge, location and timestamps, missing and malformed data. |
| Lock/unlock | Raw request construction and S-PIN token; Node durable command authorization, accepted/rejected/unconfirmed history and later observations. |
| Charging | Raw start/stop/limit requests and settings, accepted/rejected/history states; Node durable start/stop/target, busy/error handling, retries and reconciliation. |
| Climate and Camp Mode | Raw climate start/stop/settings/status; Node temperature, same-target rescheduling, persistent Camp session, restart/pause/expiry, rejection and restart reconciliation. |
| Wake/refresh | Raw bodyless wake, 401/retry/error handling; Node wake acceptance, subsequent reads, timeout/no-response, durable intent and restart behavior. |
| NIP-98 and persistence | Authorized device signing, replay, revocation, exact URL/method/body binding, rate limits, SQLite secrets/observations/command history. |

The removed Worker tests characterized an older optimistic router, not the supported Node route. Its notable defect—returning a successful unlock and overwriting observed locked state after eight unconfirmed history reads—remains documented here as **historical behavior** to avoid mistaking that old result for verified physical unlock. The Node command path keeps submitted intent separate from observed state and has offline tests for uncertain outcomes. VW command acceptance alone still is not physical confirmation.

## Linux ARM64 image check

The separate Docker `smoke` target tests the production bundle in Linux ARM64 with Docker networking disabled and synthetic data. It covers Node startup, `node:sqlite`, seven migrations, external `/data` SQLite creation, AES envelope round-trip, signed API, replay/revocation, public health, scheduler overlap/recovery/stop, SIGTERM and fail-closed missing configuration. It is not shipped in the production image. This proves local container behavior, not real VW/iPhone/Tailscale/Umbrel interoperability.

For historical Phase 1–2 scope and limits, see the Git history before the Node cutover. Representative protocol limitations remain: HTTP 429/5xx are often generic errors, some confirmation polling is bounded but inconclusive, and no offline fixture can prove that VW still accepts this reverse-engineered protocol today.
