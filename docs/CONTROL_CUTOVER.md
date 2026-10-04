# Vehicle control cutover

The default mobile path now uses Node/SQLite/NIP-98 for account, passive data, lock/unlock, charging start/stop/target, climate start/stop/settings, Camp Mode and explicit wake. No Worker fallback runs on Node failure. The Worker and InstantDB infrastructure remain available for old clients and rollback; they are not synchronized with Node. No deployment or live data import accompanies this milestone.

## Boundary and durable intent

`packages/contract/src/control.ts` defines strict requests, receipts and cached Camp session responses. `NodeLockCommands` remains the single command coordinator; `LockCommandRepository` extends the existing SQLite ledger rather than creating a second command system. The older lock-oriented module/class names remain for compatibility. `control-executor.ts`, `climate-protocol.ts`, `wake-control.ts` and `camp.ts` own Node application orchestration around unchanged VW protocol functions.

Signed `POST /api/v1/commands` accepts a local vehicle ID, action, UUID idempotency key and action-specific parameters. Charging targets are integer 50–100 in steps of ten; temperatures are integer 60–85°F; sessions are 5–1440 minutes. Inputs cannot supply a trusted VIN, protocol reference or biometric claim. Device authorization, signature/URL/method/body validation, replay protection and control rate limits precede owner/account/vehicle resolution. `/health` stays public. Old Node RPC control aliases return 410; Worker routing is unchanged.

Uniqueness is device/key; conflicting action, vehicle, account or parameters returns 409. One active ledger command per vehicle spans all controls. Mobile stores a nonsecret intent before signing, scoped to origin/device/vehicle/channel. Duplicate taps coalesce; HTTP retries, lost responses and app/Node restarts reuse the saved key with fresh signatures. Queries return cached receipts; explicit reconciliation performs bounded reads, never repeats a mutation. An interrupted pre-acceptance stage becomes unknown, while accepted work requires reconciliation. There is no automatic record/key expiry. Account deletion or restoring an older backup can remove deduplication evidence.

Acceptance and physical confirmation are separate. Lifecycle states are requested, submitting, accepted, waiting_for_vehicle, confirmed, failed, timed_out and unknown. Receipts carry observed evidence and an evidence basis; intent and local session state never become normalized vehicle truth. Local schedule changes use `local_schedule` and show “Schedule updated,” not physical confirmation. Ambiguous submissions are not automatically repeated. Only explicit VW busy refusal permits the preserved bounded retry policy with a fresh S-PIN mint: three attempts for EV/start/stop and five for temperature settings.

## Charging

Start requires observed charging; stop requires an explicitly recognized stopped/completed state; target requires observed target SOC. Charge capture time must be at/after submission. Successful history alone cannot confirm charging, and explicit history rejection overrides a matching observation. Unknown charge strings and missing/stale timestamps cannot confirm. All request construction, headers, settings reads, VW response parsing and protocol functions remain unchanged.

## Climate

A climate start/stop normally requires successful command history plus matching subsequent climate activity; start also requires the authoritative settings target to match. Multi-step commands record the current execution stage and clear the prior sub-operation correlation before submitting the next step; a settings acknowledgement cannot confirm a later start after a crash. Partial acceptance can survive without a final-start correlation and permits read-only reconciliation, but cannot prove final completion. Already-running climate at the requested temperature skips redundant start and uses actual reads without inventing VW acceptance. Standalone temperature settings confirm only from a subsequent authoritative settings GET. A conflicting target remains uncertain.

Temperature changes around running climate preserve the stop/read-off/set/read-setting/start sequence. Node additionally refuses to proceed when off or the target cannot be established. The characterized settings GET 503/default-element PUT fallback remains inside the unchanged VW client; acceptance of that PUT never proves a setting applied.

The legacy DTO collapses missing/off climate into false. Node requires false **and zero remaining minutes** for an inactive observation; other false results stay unknown. This is stronger available DTO evidence, not a verified physical sensor or a new raw protocol field. Climate has a separate local `fetchedAt`; the current source exposes no usable climate capture timestamp. History plus a direct read cannot establish exact physical execution time. A temperature setpoint is not measured cabin temperature.

Status-only observations preserve the most recent separately observed climate evidence and its original fetch time. A climate-only Camp read preserves the general/category source times instead of pretending the rest of the vehicle was refreshed. Fetch-time-only changes do not generate duplicate meaningful observations.

## Server-owned Camp Mode

SQLite stores intent temperature/end time, device, current command, cycle number, automation eligibility and explicit control state: inactive, starting, active, waiting_for_restart, paused, stopping, expired, failed or unknown. Logical session state is separate from physical climate evidence. Creating intent is atomic with the ledger insertion. Same-temperature duration adjustments update one session locally and do not reissue start or extend VW's approximately 30-minute timer. A confirmed standalone setting also updates the persisted target for subsequent cycles without claiming climate became active.

The opt-in Node climate job owns continuation. It skips still-running climate; a positively stopped read permits a new durable cycle, including settings reapplication when needed. Accepted or uncertain prior work is reconciled without resubmission. Ignition rejection pauses starts until a later parked event or the existing ten-minute fallback. Explicit busy refusal defers a cycle; other rejection fails it. Expiry creates a durable stop and disables further restart; an unconfirmed stop remains physically unknown. User stop while paused preserves the existing local escape hatch and changes only the schedule. Revoked/missing device or disconnected account suppresses further mutations. Overlapping climate ticks coalesce.

Sessions and command stages survive Node restart. Startup itself performs no VW traffic; later opt-in ticks reconcile accepted work and do not blindly restart interrupted submissions. Phone backgrounding/offline state is irrelevant to server ticks. Historical SQLite sessions are preserved by migration 7 with automation disabled until an explicit new authorized intent adopts them; there is no live InstantDB import.

Node scheduling remains **off by default** while the Worker cron exists. The mobile card reports disabled automation: a saved schedule will neither restart nor stop climate automatically until an operator enables the single intended scheduler. No minimum-SOC cutoff exists in current source and none is silently added. Physical climate duration, reliable shutdown and battery safeguards require later controlled vehicle/native validation.

## Wake and refresh

Normal mobile refetch/pull-to-refresh reads Node's SQLite cache. Explicit wake submits the existing S-PIN refresh request, preserves the 401/forced-login behavior and failed-login cloud-read fallback, and polls status within the application budget. An accepted wake is not a response. `wake_freshness` means observed RVS capture time is at/after submission and newer than the pre-wake baseline; it does not prove the wake caused it. A failed acknowledgement may still be followed by fresh observed cloud data; the receipt keeps `acceptedAt` null. Old/missing vehicle timestamps leave the outcome uncertain.

Default command budgets retain eight lock history reads, six EV/climate reads, up to three observations, 2.5-second spacing and a 60-second application deadline. Test fixtures shorten waits. The unchanged protocol has no universal abort interface: a deadline fences Node writes and late confirmation but cannot cancel internal fetch work or an already issued physical command. No timed-out mutation is automatically retried.

## Mobile and remaining infrastructure

The mounted mobile import graph has no InstantDB client, legacy control provider or Worker RPC dependency. Climate session subscriptions are replaced with signed cached Node polling; control receipts poll every 1.5 seconds while pending, Camp sessions every five seconds. Errors stay on the Node path. Existing native pickers/buttons remain; Face ID and the full UI redesign are future work.

Parked location uses normalized coordinates and a temporary coordinate panel with the existing explicit native Maps chooser. It no longer requests Worker-signed snapshot images and introduces no hosted map service. Native MapKit rendering remains future work.

Dormant mobile files remain for the next cleanup: `app/src/db.ts`, `rpc.ts`, `providers/legacy-control-provider.tsx`, `auth-storage.ts` and `legacy-control-state.ts`, together with old environment templates, package declarations and compatibility tests. They are not reachable from the default screens. Globally retained infrastructure includes Worker entrypoint/router/maps/Instant store, Wrangler configuration and cron/deploy/dev scripts, Instant schema/permissions/admin utilities, `packages/db`, Instant packages and legacy contract/RPC paths. None is removed or deployed here.

## Offline verification and limits

The full milestone regression combines the existing 198 tests with 56 new tests: 16 charging, 16 climate, 12 Camp, seven wake, four mobile import/intent and one schema-upgrade test (254 total). All VW requests use the deterministic exact-request queue, and unexpected access fails even when older code catches errors. Only synthetic credentials and temporary databases are used. Validation includes repository typecheck/lint/formatting, Node build, Worker dry-run bundle and offline iOS JavaScript export. These checks do not establish live VW interoperability, native Keychain/AsyncStorage/UI behavior, Xcode compilation, proxy correctness or physical vehicle response.

The next milestone is removal of dormant Worker/InstantDB infrastructure and preparation of the production Docker/Linux ARM64 Node backend, with one scheduler owner and protected persistent SQLite/key storage. No deployment is authorized by this document.
