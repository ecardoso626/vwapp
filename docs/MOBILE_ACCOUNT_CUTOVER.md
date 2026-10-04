# Phase 8A: mobile Volkswagen account cutover

## Boundary recorded before implementation

| Flow                        | Phase 7 mobile caller                                                                     | Legacy server/persistence                                                                                                                | Phase 8A boundary                                                                                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Username/password           | `app/src/app/login.tsx`, `orpc.auth.checkCredentials`                                     | `backend/src/router.ts` compare-first session establishment; encrypted Worker credential blob and token fields in InstantDB `vwAccounts` | Signed Node account credential endpoint, encrypted SQLite provisional session; no owner link until S-PIN completion.                                                             |
| S-PIN and login             | `login-pin.tsx`, in-memory `providers/login-flow.tsx`, `orpc.auth.login`                  | Same session reuse, `saveLogin` attaches Instant `$users` to `vwAccounts`, garage vehicles and initial status snapshot                   | Signed Node completion endpoint links the local `owner`, local account and discovered vehicles; S-PIN is encrypted.                                                              |
| Account status              | `providers/session-provider.tsx`, Worker `auth.me`                                        | Instant guest token, `$users.vwAccount`, single `loggedIn` Boolean                                                                       | Typed Node connection state; device pairing stays separate.                                                                                                                      |
| Logout                      | Session provider, `orpc.auth.logout`                                                      | `clearUserData` detaches user; credentials, tokens, vehicles, history and climate sessions persist                                       | Node disconnect removes only the active owner link and records a reconnect candidate. Device authorization is retained.                                                          |
| Reconnect/credential change | Repeat legacy two-screen flow                                                             | Digest compare, garage validation, refresh with original verifier, full password authentication only if reuse fails                      | Explicit signed Node reconnect using encrypted stored credentials; new credential submission keeps compare-first behavior.                                                       |
| Controls                    | Lock/charge/climate/Updates screens via `app/src/rpc.ts`; climate subscribes to InstantDB | Worker guest identity and its linked account/vehicle                                                                                     | Remain Worker calls. A separate optional legacy provider checks exact VW reference and VIN against the Node vehicle before enabling actions; no automatic Worker login fallback. |

Node already provides `NodeSqliteStore`, an encrypted `SecretRepository`, `owner_account_link`, normalized cached state, and NIP-98 authorization. Phase 8A adds the account HTTP/application boundary and connection metadata, reusing existing protocol/session operations. It does not move vehicle commands or enable a scheduler. All development validation is synthetic/offline.

## Pairing and account state

Pairing authorizes this phone's dedicated Nostr key. It does not sign into VW. All authorized devices act as the single local `owner`, without an Instant user ID. The app's pairing guard follows Node device authorization; an authorized owner can open the app without any VW account. A VW authentication rejection is HTTP 422, distinct from the generic NIP-98 HTTP 401 that requires pairing recovery.

`packages/contract/src/account.ts` defines the typed connection evidence:

- `state`: `unlinked`, `pin_required`, `connected`, `session_unusable`, `reauthentication_required`, `credentials_missing`, or `disconnected`.
- `linked`: whether the active owner/account relation exists; this alone does not prove a usable session.
- `credentialsPresent`, `spinPresent`: encrypted records exist, without returning their values.
- `session`: `missing`, `unverified`, `usable`, `expired`, or `unusable`; `verifiedAt` records successful garage verification. `usable` means previously verified and more than 60 seconds remain on the locally recorded access-token expiry. It is not a promise that VW still accepts the token.
- `vehicleAvailable`: an active linked account has cached discovered vehicle rows, independent of fresh telemetry.
- `reconnectAvailable`, `pendingPin`, `lastFailure`: explicit recovery evidence. A known failed PIN attempt remains distinct from successful garage authentication.

No configured/unknown/revoked device is represented as a VW account state: the pairing provider handles that authorization boundary separately. Existing version-3 owner links are retained by migration 4 but are unverified until explicit reconnect succeeds. Cached status never performs VW traffic.

## Signed credential and session boundary

| Operation                 | Signed route                                                  | Behavior                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection status         | `GET /api/v1/account`                                         | SQLite metadata only; no login, token refresh or vehicle wake.                                                                                                                              |
| Submit/update credentials | `POST /api/v1/account/credentials` with `{username,password}` | Compare-first session resolution and garage discovery; immediately encrypt persisted credentials/tokens, then issue a device-bound 10-minute opaque attempt. No new owner link yet.         |
| Complete S-PIN step       | `POST /api/v1/account/connect` with `{attemptId,spin}`        | Require this device's unexpired attempt; reuse session logic, encrypt PIN, atomically update the owner link and connection metadata, then make upstream's best-effort initial status reads. |
| Explicit reconnect        | `POST /api/v1/account/reconnect` with `{}`                    | Use remembered encrypted credentials/session; require a new PIN attempt if missing or previously rejected. No repeated automatic mutation retries.                                          |
| Disconnect                | `POST /api/v1/account/disconnect` with `{}`                   | Remove active owner/account link; retain a remembered account for explicit reconnect. No VW request.                                                                                        |

Only the configured external HTTPS origin is used by the phone and NIP-98 verifier; forwarded host/scheme values are ignored. HTTPS termination must be configured separately before live use. Credentials/PIN are JSON body fields, never URL parameters. Account routes reject query strings and unknown body fields. Body bytes are authenticated before parsing; existing body limits, replay consumption, revocation and per-device request limits apply. Status is read-class; account mutations use the existing control-class limit. Concurrent account mutations return safe HTTP 409 rather than issuing duplicate logins. No new general retry loop or upstream timeout was added.

The Node-only HTTP boundary retires `/rpc/auth/checkCredentials`, `/rpc/auth/login`, and `/rpc/auth/logout` with safe HTTP 410 after NIP-98 verification. This prevents bypassing connection metadata and prevents raw legacy account error messages entering the Node account surface. Worker routes are unchanged. `backend/src/account-session.ts` extracts the existing compare-first resolver for both runtimes; default Worker errors/logs and VW requests are preserved, while Node selects redacted errors. The Node status/token path also selects redacted error logging. `backend/src/vw/client.ts` is unchanged.

Username, password, PIN, access/refresh/ID/carnet tokens and PKCE verifier use the existing purpose-bound AES-256-GCM `SecretRepository`. The external master key is not the Nostr device key. SQLite receives encrypted envelopes, never the transient credential seal or plaintext reusable capabilities. Authentication-envelope errors fail closed. Missing account/session fields can be repaired only through explicitly supplied or existing encrypted credentials; no plaintext fallback is introduced.

The mobile login screen sends credentials through `requireBuzzKey()` and clears its password field on success. Only the opaque attempt crosses into `login-pin`; PIN exists in the secure input's React memory until submission/clear/unmount and is never written to ordinary mobile storage. Mutation variables do not contain credentials or PIN. This is not a guarantee of zeroization of JavaScript process memory or control of the OS password manager.

## Session reuse and S-PIN evidence

Matching password digests first permit the saved access token to be tested against the garage. Expired/rejected access tokens use the stored refresh token and original PKCE verifier, then garage validation. Failure falls back once to the existing password login; changed passwords require that login directly. Explicit reconnect uses exactly this sequence. A credential check can persist a provisional session even when PIN entry is abandoned, matching upstream's cache-before-link behavior; reconnect can create a new attempt. Attempts survive Node restart but remain device-bound and expire; the phone does not persist its attempt.

PIN derivation, challenge, remaining-tries guards, cached carnet reuse and initial status retry behavior are unchanged. Saving the PIN and owner link precedes initial status, as upstream. A known `VwCommandError` during initial status now produces an explicit `pin_required` state and another opaque attempt; other initial-status failures report safe `status_read_failed` evidence. Garage connection with no vehicles or a cached carnet does not independently prove the newly entered PIN was accepted. No extra PIN challenge or control/wake request is invented. Failed initial telemetry does not delete discovered vehicles or credentials.

The existing optimistic unlock behavior remains: eight unconfirmed history reads can still yield success and a persisted unlocked compatibility state. Phase 8A neither fixes nor migrates it. Passive domain mapping continues to avoid treating command intent as observed lock truth. Identical initial/reconnect observations remain deduplicated.

## Logout retention policy

Disconnect is an owner-level operation shared by all authorized devices, not a device revocation or account erasure:

| Item                                                             | Disconnect effect                                                                                         |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Local owner and paired device                                    | Retained, including the phone key, authorization, replay and revocation records.                          |
| Active VW owner link                                             | Removed; remembered account ID retained for explicit reconnect.                                           |
| Credentials, PIN, access/refresh/ID/carnet tokens, PKCE verifier | Encrypted records retained. No remote token revocation or deletion.                                       |
| Discovered vehicles/current state/history/telemetry/messages     | Retained; account-scoped passive vehicle/history/message endpoints hide detached data until linked again. |
| Managed climate sessions                                         | Retained; disconnect does not send a stop command.                                                        |
| Pending account attempt                                          | Cleared; new explicit reconnect is required.                                                              |
| Existing Worker session/data                                     | Unchanged; Node connection gate disables this phone's controls while disconnected.                        |

The Node scheduler stays off by default. If deliberately enabled in a future phase, its existing account iteration can still see retained accounts, including disconnected/provisional accounts, and retained climate sessions. Disconnect is not a scheduler-stop guarantee. An erase/revoke/automation-stop workflow requires a separate reviewed scope.

## Remaining mobile Worker/InstantDB boundary

`LegacyControlProvider` restores only an existing Instant identity, using the SDK's persisted state or Keychain token mirror. It does not create guests, submit VW credentials, sign out of VW, or silently fall back from a Node account error. With no legacy Instant app ID or Worker API URL, this provider is disabled and Node pairing/account/passive functionality remains available. Packages remain installed.

The remaining mobile Worker callers are `auth.me` for this optional control session, `chargeStart`, `chargeStop`, `setChargeLimit`, `climateInfo`, `climateStart`, `climateStop`, `refresh` for explicit wake, and `parkedMapUrl`. Instant queries retain the authorized legacy vehicle list and active climate sessions. Worker login/logout endpoints remain for other legacy clients/rollback; no current mobile screen calls them. There is no new rollback UI or Review Mode.

Every remaining mobile Worker command entry point checks a usable, linked Node connection plus an exact VW reference **and VIN** match in the authorized legacy vehicle list. Calls carry the explicit protocol UUID, including wake. The climate sheet checks the same gate for deep links. Account mutations temporarily disable controls. Failure/missing data/mismatch disables actions and explains the transitional requirement. SQLite and Instant vehicle row IDs are never compared as identity.

This is a transitional client guard, not server-enforced cross-store synchronization or atomic account identity. Matching the same vehicle does not prove identical VW credentials. Worker commands still persist only Worker state; they do not update Node cache, so passive telemetry can remain stale. Newly paired phones can use Node lock/unlock; charging/climate/wake require an existing matched Worker account until those commands migrate. No new live Worker session is created automatically. Worker protocol/control regression tests remain intact.

## Offline validation and future live gates

Phase 8A adds 17 Node/mobile account tests and one version-3-to-4 migration test. They exercise actual NIP-98 HTTP verification and SQLite with invented credentials and the existing deterministic VW fetch queue: credential/PIN encryption (including DB/WAL byte checks), garage linkage, restart, passive reads, provisional/device-bound/expired attempts, valid reuse, refresh, one fallback, credential updates, missing fields, failed auth/PIN, disconnect retention/reconnect, concurrency, replay, revocation, body/URL/method tampering, rate limits, safe logs/errors, retired Node aliases and mismatch gating. The queue wrapper also surfaces unexpected requests that upstream best-effort branches catch. No real VW endpoint or InstantDB migration is used.

Existing VW/domain, Node lifecycle/scheduler/passive, SQLite and NIP-98 suites remain passing. Repository typecheck/lint/format validation, diff checks, Node bundle, Worker dry-run and offline iOS JavaScript export are required; the export uses a synthetic HTTPS origin with no InstantDB/Worker configuration. No dependencies or lockfile changes are needed.

Offline results do not verify current VW service acceptance, TLS proxy configuration, native Keychain/Hermes execution, simulator UI, or a physical phone. Those require separate future authorization/environment preparation. Before live use, validate HTTPS origin/body preservation and bounded session/PIN behavior, choose a single polling writer, and reconcile old Worker state; do not enable both schedulers. Phase 8B should move only lock/unlock with durable intent/idempotency and explicit confirmation/unknown states. No deployment occurs in this phase.

## Phase 8B update

The account boundary above remains unchanged. Mobile lock/unlock now uses the usable linked Node connection and authorized device directly, without the legacy provider or Instant identity. The Node command layer resolves account/vehicle identity authoritatively and persists durable device/key intent before invoking existing VW calls. Its receipt separates acceptance from fresh observed confirmation; it corrects optimistic unlock application semantics while leaving the old Worker characterization intact. Charging/climate/wake and map signing retain the matched legacy boundary. See [LOCK_CONTROL_CUTOVER.md](LOCK_CONTROL_CUTOVER.md) for idempotency, restart/lost-response recovery, timeout limitations and the future local unlock gate.
