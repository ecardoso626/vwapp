# Phase 2 vehicle domain and VW adapter

Phase 2 adds a typed, additive boundary in `packages/contract/src/vehicle-domain.ts` and
`backend/src/vw/adapter.ts`. The existing Cloudflare Worker, InstantDB schema,
oRPC responses, mobile queries, VW client, token manager, router, and climate
keepalive still run through their existing paths. This model is a seam for later
application work, not a replacement for the current snapshot schema or a claim
that a vehicle has executed a submitted command.

## Preservation boundary

| Layer                               | Current files                                                          | Responsibility                                                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| A. VW transport/protocol            | `backend/src/vw/client.ts`                                             | NA OAuth and S-PIN request shapes, VW URLs/headers/bodies, response parsing, raw status normalization, correlation/history reads.       |
| B. VW authentication/session        | `backend/src/tokens.ts`, `backend/src/status.ts`                       | Refresh/re-login policy, cached carnet tokens, and status retry after a token failure; these still use current Instant account records. |
| C. VW command orchestration         | `backend/src/router.ts`, `backend/src/poll.ts`                         | Busy retry budgets, climate sessions and keepalive, history windows, optimistic lock snapshot, and best-effort wake fallback.           |
| D. Application/router orchestration | `backend/src/router.ts`                                                | oRPC ownership checks, input validation, response/error mapping, and calls to current command flows.                                    |
| E. Persistence coupling             | `backend/src/store.ts`, `packages/db`                                  | InstantDB account/vehicle/token/session/snapshot operations and live-query data shapes.                                                 |
| F. New domain-facing boundary       | `packages/contract/src/vehicle-domain.ts`, `backend/src/vw/adapter.ts` | Domain types and a typed adapter that delegates one protocol operation at a time, mapping results into application concepts.            |

The adapter takes session callbacks for access tokens, a cached read
authorization, a fresh command authorization, and the S-PIN. Those callbacks
are an internal VW adapter supply contract; `VwAdapter` methods expose no
Cloudflare or InstantDB types. Existing router/poll call sites are deliberately
unchanged because moving their retry and persistence tails into this first
adapter would change observed command behavior. No new persistence interface
was introduced in Phase 2.

## Domain types and semantics

`VehicleIdentity` has a nullable `localId`, opaque adapter `reference`, VIN,
nullable name, and nullable model. Discovery cannot assign the future local ID;
the current adapter maps VW's vehicle UUID to `reference`, which callers should
not parse. A later persistence layer can assign `localId` without changing
protocol routing.

`VehicleState` contains identity, capabilities, battery, security, climate,
odometer, location, and freshness. Battery values use percent, kilometers,
kilowatts, minutes, and nullable plug/target fields. Known raw
`chargingHVBattery` maps to `charging`; unrecognized charge-state strings map
to `unknown`. Security uses `locked | unlocked | unknown`, plus nullable lists
of observed open doors/windows and unlocked doors. Climate uses
`active | inactive | unknown`, target °F and remaining minutes. Status reads do
not include climate, so a status-only `VehicleState` starts with unknown climate;
`readClimate` is a separate existing VW read. Location is present only when
both coordinates are finite and in latitude/longitude bounds.

`null` means no supported observation, not zero, false, empty, safe, or closed.
The current `StatusDTO` maps an unrecognized or missing VW security value to
`locked: false`; it also maps absent closure maps to empty arrays. That DTO
cannot distinguish genuine unlocked/closed from absent or unknown. The Phase 2
mapper therefore maps `false` lock to `unknown`, and empty closure lists to
`null`. A positive lock or a nonempty closure list remains usable evidence.
The existing climate reader similarly maps explicit off and missing status to
`on: false`; the adapter maps that value to `unknown`, while `on: true` maps to
`active`. The domain unions reserve `unlocked`, `inactive`, and
`not_charging` for future unambiguous evidence; this adapter does not infer
them. These conservative mappings do **not** change the legacy Worker responses
or stored snapshots.

`VehicleCapabilities` uses `supported | unsupported | unknown` per operation.
Having a command method does not prove that this particular vehicle supports
it. Lock, unlock, charging, charge target, and climate remain `unknown` until
per-vehicle evidence exists. Valid observed parked coordinates support only the
`location` telemetry capability at that observation; missing coordinates leave
it `unknown`, not `unsupported`. Capability support is distinct from temporary
availability, token state, throttling, or command success.

## Freshness

`freshness.fetchedAt` is local adapter time immediately after a successful VW
status read. `sourceCapturedAt` is the existing normalized DTO's preferred
source capture timestamp; it may favor charge over RVS and does not mean all
fields were captured together. RVS, charge, door, lock, and window update times
are copied separately when finite. A fresh cloud fetch can still contain old
vehicle data. This model computes no fresh/stale judgment, persists no fetch
time, and invents no vehicle-response time. `WakeSubmission.acceptedAt` is only
the local time when VW accepted the wake HTTP request; it is not evidence that
the vehicle responded. `CommandSubmission.acceptedAt` has the same local
submission meaning.

## Commands and current behavior

`CommandSubmission` carries a command kind, opaque vehicle reference, VW
correlation ID, and local acceptance time. `CommandConfirmation` is returned
separately by `awaitCommandResult`. Neither alters `VehicleState`. This avoids
the future anti-pattern of turning `unlock requested` into `observed unlocked`.
The current production router still overwrites its lock snapshot after eight
unconfirmed history reads, exactly as the Phase 1 tests document. It also
keeps the observed climate settings 503 fallback, wake 401 forced-login
attempt, and wake request without a fetch deadline. Phase 2 neither fixes nor
reinterprets those behaviors.

The adapter wraps existing one-attempt protocol functions. It does not copy
HTTP construction, token caching, busy retries, managed climate sessions,
optimistic snapshots, or wake-error swallowing. Those policies remain in the
current session/router/poll modules until an explicitly tested later migration.
The adapter's status read does not itself implement `status.ts`'s forced carnet
retry, and its command submissions do not claim physical completion. A future
application service must preserve or deliberately redesign those policies
before replacing current call sites.
