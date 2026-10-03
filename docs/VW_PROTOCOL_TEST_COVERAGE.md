# VW protocol characterization — Phase 1

The offline suite captures behavior at the current `umbrel-selfhosted` source
boundary. It is not evidence that Volkswagen still accepts these requests or
that the vehicle executed a command. All credentials, VINs, IDs, tokens and
responses in the suite are synthetic.

## Run and isolation

From the repository root, run `pnpm test:vw`. This uses Node's built-in test
runner and TypeScript type stripping; no test framework dependency was added.
`backend/tests/register.mjs` installs a fail-closed global `fetch` before test
modules import production code. Each test supplies an exact ordered queue of
URLs, methods, inspectable headers/bodies and synthetic responses. Extra and
missing requests fail. The production VW client uses `fetch` for all HTTP
requests, and the suite never loads credential env files or starts a server.
`resolve-ts.mjs` only resolves the repository's extensionless local TypeScript
imports so Node can execute the existing modules unchanged. An isolation test
proves an unclaimed request is rejected. Fast history polling uses fake timers;
PKCE and selected expiry tests use fixed random/time values. This is test
process isolation, not a machine-wide network firewall.

Synthetic fixtures live in `backend/tests/fixtures/` with handling rules in
its README. They contain `TESTVIN0000000000`, `example.invalid` identities and
`synthetic-*` capability strings. Never replace these with captured live
responses or output from a credentialed probe.

## Protected modules

| Module                     | Current responsibility / preservation boundary                                                                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/src/vw/client.ts` | NA OAuth and cookie/redirect handling, PKCE, grant payloads, vehicle discovery, S-PIN challenge/hash/session, vehicle-scoped token use, raw status normalization, all VW reads and write requests, history/result parsing. |
| `backend/src/tokens.ts`    | Access reuse, expiry margin, refresh or password fallback, original PKCE verifier, cached carnet expiry/mint/persistence, retry after mint auth failure.                                                                   |
| `backend/src/status.ts`    | Parallel status reads and one forced carnet re-mint/retry on 401.                                                                                                                                                          |
| `backend/src/router.ts`    | Account/session convergence, command orchestration, retries, optimistic lock snapshot, wake best effort, charging and managed climate flows.                                                                               |
| `backend/src/poll.ts`      | Scheduled status collection, snapshot pruning, climate keepalive, pause/resume and expiry behavior.                                                                                                                        |
| `backend/src/store.ts`     | Instant account/token/session persistence, snapshot dedupe and climate state used by the orchestration.                                                                                                                    |
| `backend/src/crypto.ts`    | Current credential seal/unseal used by session setup; no new encryption was added.                                                                                                                                         |

The underlying protocol and production orchestration files were not edited.

## Coverage

| Area                 | Coverage | Tested behavior / limit                                                                                                                                                                                                                                                                       |
| -------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication       | GOOD     | OAuth authorize query/client IDs/PKCE/redirect URI, form fields, host-only cookie isolation, login exchange, malformed markup and token errors. Full redirect variants and changing real IdP HTML remain uncovered.                                                                           |
| Tokens/session       | GOOD     | Access reuse, 60-second expiry gate, refresh with original verifier, missing replacement refresh token, persistence shape, refresh failure/password login fallback, missing-verifier fallback and carnet reuse/margin. Account-sharing login/guest attachment has no full router fixture yet. |
| S-PIN                | GOOD     | Challenge GET, remaining-attempt guard, exact SHA-512 synthetic vector, idToken in body, access bearer, WCT, carnet response, 401 and incorrect PIN.                                                                                                                                          |
| Vehicle discovery    | GOOD     | Wrapped garage, UUID/VIN distinction, missing VIN filter; alternate unwrapped shape remains a small gap.                                                                                                                                                                                      |
| Status               | GOOD     | Parallel RVS/EV carnet reads; SoC preference, range units, odometer, security/closures, charge/plug, location and source timestamps; missing-data and 401/429/5xx behavior; `readStatus` forced carnet retry.                                                                                 |
| Lock/unlock          | GOOD     | Exact S-PIN→PUT sequence, carnet bearer, boolean body, acceptance/correlation/refusal, plus router's optimistic unconfirmed unlock path.                                                                                                                                                      |
| Charging             | PARTIAL  | Start/stop/target endpoint, bearer, body/settings preservation, EV busy/auth/generic failures. Router retry budget and snapshot tail are not fully exercised.                                                                                                                                 |
| Climate              | PARTIAL  | State read, start/stop, settings merge/temp write and carnet bearer. Managed-session/retry/keepalive loops are not exercised end to end.                                                                                                                                                      |
| Wake/refresh         | PARTIAL  | Bodyless S-PIN-gated refresh POST and accepted response. Router's best-effort swallowing and delayed vehicle response are not exercised.                                                                                                                                                      |
| Command confirmation | GOOD     | Correlation, pre-read delay, accepted/success/explicit failure, malformed/pending/5xx/network/no confirmation, typed 401; router returns success and overwrites contrary observed lock state after eight unconfirmed reads.                                                                   |
| Retry/error behavior | PARTIAL  | Refresh fallback, status forced re-mint, history polling, EV busy classification, generic 429/5xx and network failure. Router's busy/climate retry cadence, full-login throttling and no-deadline fetch behavior remain documented from source rather than comprehensively simulated.         |

## Current quirks preserved

- A VW `result: 0` is only acceptance. The raw lock/EV client requires a
  correlation ID but does not verify execution.
- History `responseBody` is a JSON string. Outcome `2` or a success code
  confirms; outcomes `0`/`3` reject; accepted `1` keeps polling. A string
  `responseStatus` is ignored. Non-401 history errors are swallowed, then the
  function returns `{confirmed:false}` at the attempt limit.
- The lock/unlock router ignores `{confirmed:false}`; after a status read it
  writes the requested lock state even when the synthetic RVS says otherwise,
  and returns `{ok:true}`. This is a characterization, not an endorsement.
- Charge start/stop/target use six history attempts in the router and may
  return `{ok:true}` without confirmation; explicit rejection propagates.
  Climate start stores a managed session after accepted start or a busy defer,
  without a start-history confirmation. Wake acceptance is not a vehicle
  response. These orchestration paths still need deeper fixture coverage.
- S-PIN challenge stops when remaining attempts are below three. Status reads
  require carnet bearer. Cached carnet is re-minted three minutes before
  expiry, with a 25-minute fallback when the JWT lacks `exp`.
- `apiGet` maps only 401 to `VwAuthError`; 429/5xx are generic. EV busy gets a
  specialized error only for `EV_THRESHOLD_EXCEEDED`. No general Retry-After,
  deadline, cooldown or circuit breaker exists.
- Missing closures become empty lists; unknown `secure` strings become false.
  The `capturedAt` preference may hide older category timestamps.

## Remaining protocol risks

No live interoperability or current VW attestation acceptance was checked.
The login HTML scrape, server-only attestation placeholder, password/S-PIN
throttling, vehicle-specific capabilities, real correlation timing, climate
keepalive and runtime restart behavior still need separate future validation.
Do not add real VW probes to `pnpm test:vw`. Phase 2 can add more synthetic
coverage while introducing narrow interfaces, and must keep any behavior
change explicit and reviewable.
