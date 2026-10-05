# VW North America authentication feasibility

Evidence reviewed **2026-10-04**. Scope: public-source/offline investigation; no new account login, token exchange, vehicle API request, deployment or mutation. Production remains at the prior healthy checkpoint with scheduler disabled and its consumed login-attempt marker intact. No automation was created.

## Decision, including the iOS priority

**The inherited Android-style server login is blocked in our deployment; Play Integrity enforcement is the highly likely cause. A legitimate replacement using BuzzKey's own iOS identity is not established by public evidence.** This is not proof that every possible VW integration is impossible.

The Android client is an implementation inherited from upstream, not a BuzzKey product requirement. Prefer replacing and eventually deleting it **if** a supported independent iOS grant and backend session lifecycle become demonstrable. Do not implement that replacement, swap identifiers, or perform another login now. The current conclusion for the official U.S. iOS path is **INSUFFICIENT EVIDENCE**, not a confirmed App Attest requirement and not a proven usable alternative.

Evidence labels below mean: **CONFIRMED** by our recorded observations or inspected code/documentation; **LIKELY** is an inference from matching independent reports; **SPECULATIVE** means a possible explanation with missing protocol evidence. A maintainer's assertion is attributed to that maintainer, not promoted to a VW specification.

## 1. Recorded live evidence

Two controlled VW login flows occurred across the project; **zero in this investigation**. The latest, at deployed diagnostic source `89f262b`, found the identifier/password fields, followed the login redirects to the callback and passed authorization-code extraction. The token endpoint then returned HTTP **401**, JSON category, classified `auth_token_exchange_failed`. No explicit password rejection appeared. BuzzKey returned HTTP 422 to the provisioning client.

The retained diagnostics do **not** contain VW's raw error code, origin, path or reason. In particular, we cannot claim our own response contained `INVALID_REQUEST`, `CarnetSPAuthorizationServer` or `/azs`: those are public comparison evidence. The diagnostic parser recognizes a small set of explicit attestation codes; not recognizing one does not rule attestation out, especially for nested or generic errors.

The prior checkpoint verified healthy SQLite, zero saved accounts/secrets/sessions/vehicles/observations/commands, one consumed empty 0600 attempt marker, safe logs and disabled scheduler. No discovery followed failure. See [controlled result](VW_AUTH_DIAGNOSIS.md#controlled-live-result--2026-10-04). This investigation did not access credentials or repeat production probes.

## 2. What BuzzKey actually sends

Inspected `backend/src/vw/client.ts`, `account-session.ts`, `tokens.ts`, and `app/app.config.ts` at `b3a7a59`:

| Property                | Current implementation, with no secret values                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Token endpoint          | POST `https://b-h-s.spr.us00.p.con-veh.net/oidc/v1/token`                                                                                              |
| Device OAuth client     | Public Android client `59992128-69a9-42c3-8621-7942041ba824_MYVW_ANDROID`; no client secret                                                            |
| Browser identity client | `b680e751-7e1f-4008-8ec1-3a528183d215@apps_vw-dilab_com` on `identity.na.vwgroup.io`                                                                   |
| Redirect / scope        | `kombi:///login` / `openid`                                                                                                                            |
| Initial grant           | `authorization_code`, with code, client ID, redirect URI and original PKCE verifier                                                                    |
| PKCE                    | 64 random bytes encoded as 128 uppercase hex characters; S256/base64url challenge; original `code_verifier` used at exchange and persisted for refresh |
| Refresh grant           | `refresh_token`, public client ID, original verifier when present                                                                                      |
| Integrity               | Literal `play_integrity_token=unavailable` on both grants; no genuine attestation obtained                                                             |
| Token headers           | `content-type: application/x-www-form-urlencoded`, `accept: application/json`, `user-agent: MyVW/1.0 Android`                                          |
| Login-page headers      | Android browser UA, HTML accept, English accept-language, `x-requested-with: com.volkswagen.weconnect`; private cookie jar                             |
| BuzzKey iOS identity    | `com.ecardoso626.buzzkey`; unrelated to the OAuth client asserted by the backend                                                                       |

Google integrity enters this flow because the **backend chooses an Android-specific VW grant**, not because React Native or iOS requires Google Play. Moving identical requests onto an iPhone would not change the identity or requirements of that grant.

## 3. Play Integrity requirement and its limits

Google documents device/app/account verdicts, including package identity and signing-certificate checks. Its standard flow obtains a request-bound token in the app and lets the receiving backend verify it. A server may verify tokens; that does not let it mint a genuine token for Volkswagen's signed app. Registering our own Android project would attest our app, not VW's. No legitimate server-only producer for the required VW attestation was found. [Google overview](https://developer.android.com/google/play/integrity/overview), [verdicts](https://developer.android.com/google/play/integrity/verdicts), [standard flow](https://developer.android.com/google/play/integrity/standard).

**HIGHLY LIKELY for our failure**, rather than independently confirmed VW policy: the evidence matches a documented transition from field-presence checks to validation. There is no verified current U.S. success with the placeholder in the sources reviewed. Historical success and earlier Canadian success are not evidence of current U.S. acceptance.

## 4. Upstream warning and current history

Public GitHub API confirms `sstur/vwapp` HEAD remains `15500a78ff6a33310e443c91a9b6c3e62554b2cc` (2026-08-01). The relevant 2026-07-30 commit is `1b70d553b824d61854f5c9dcbeee0454f44b7dc5`; no newer upstream fix or issue was found. Its documentation calls the placeholder a **“STOPGAP”**, anticipating failure if VW validates it and explaining that genuine attestation cannot be generated by an off-device client. That warning has become operationally relevant; the present-tense source comment about accepting any nonempty value is historical evidence, not a current guarantee. [Pinned upstream warning](https://github.com/sstur/vwapp/blob/15500a78ff6a33310e443c91a9b6c3e62554b2cc/CLAUDE.md), [auth commit](https://github.com/sstur/vwapp/commit/1b70d553b824d61854f5c9dcbeee0454f44b7dc5).

## 5. Independent project evidence

| Source and date                                                                                                                      | Evidence and limits                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [VW Group Connect #1215](https://github.com/its-me-prash/vwgroup-connect-ha/issues/1215), reports Aug 17; maintainer Aug 18          | Multiple U.S. accounts reached code exchange and got 401 `INVALID_REQUEST` from `CarnetSPAuthorizationServer`. Maintainer attributes enforcement to **Aug 13, 2026**. Its later NA MBB device-grant probe failed before issuing a device code; no working substitute established. |
| [Central #1165](https://github.com/its-me-prash/vwgroup-connect-ha/issues/1165), opened Aug 14, still open                           | Tracks initial/refresh rejection with working official login. Early comment conflates July field introduction and enforcement; later #1215 dating is more specific.                                                                                                               |
| [CarConnectivity NA #90](https://github.com/zackcornelius/CarConnectivity-connector-volkswagen-na/issues/90), Aug 14; updated Sep 21 | Independent U.S. token-failure report, also relevant to iOS below. Rooted-emulator failure is consistent with an adverse integrity verdict, not a stock-device control experiment.                                                                                                |
| [Canadian #1432](https://github.com/its-me-prash/vwgroup-connect-ha/issues/1432), Sep 22 report, onset Sep 18                        | Similar Canadian failure and working official app; useful corroboration, not proof about U.S. iOS.                                                                                                                                                                                |
| [Car Lease Tracker](https://www.curly-byte.de/apps/car_lease_tracker/)                                                               | Independent mobile developer currently marks U.S. VW connections unavailable while advertising other regional paths. This corroborates a practical block, not its exact mechanism.                                                                                                |

VW Group Connect inspected HEAD: `e17ecddc22300d88f8e77bc4970d18946e99450d` (Oct 4). Recent auth commits `64da8a43fae1` and `55f594b1292b` improve failure diagnosis/redaction; no supported independent U.S. iOS solution was found. Its [NA atlas](https://github.com/its-me-prash/vwgroup-connect-ha/blob/e17ecddc22300d88f8e77bc4970d18946e99450d/docs/research/app-atlas/volkswagen_na.md) is Android-oriented and has empty extraction findings, so it is not validation of an iOS grant.

CarConnectivity NA inspected HEAD: `044c7f3e48f796e6632295034a6137978392c8e0` (Aug 23). Its `VWWebSession` performs the browser leg of the same mobile grant, not a distinct owner-portal integration. A later [claimed working relay](https://github.com/zackcornelius/CarConnectivity-connector-volkswagen-na/issues/91#issuecomment-5721750788) depends on official-app instrumentation/token extraction and integrity modification. It falls outside the user's boundaries and is not a candidate. No binary, capture attachment or relay was downloaded or executed.

## 6. Priority: official U.S. iOS path and BuzzKey identity

There is public evidence of a separate iOS client, but **no established independent-client contract**:

| Question                                   | Public finding                                                                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| U.S. iOS client                            | #90 reports `720b402a-0348-489d-9ae9-eedbe24c1d88_MYVW_IOS`. Source-reported, not verified by us or supplied as a usable configuration. |
| Redirect and login                         | #90 reports `kombi:///login`, `openid`, the same NA identity client, plus `ui_locales=en-US`.                                           |
| Token endpoint/fields and PKCE differences | Native iOS token exchange was not observed in that report. A complete current iOS request and verifier/refresh contract remain unknown. |
| Client substitution                        | The reporter says substituting the iOS ID still returned 401 off-device. That does not establish the exact missing requirement.         |
| App Attest, DeviceCheck, other or none?    | Unknown for current U.S. myVW. The report explicitly treats iOS attestation as an inference.                                            |

Source: [U.S. iOS observations in #90](https://github.com/zackcornelius/CarConnectivity-connector-volkswagen-na/issues/90). We read public text only; we did not reproduce its interception techniques. Knowing a public client ID is not proof that VW registers or authorizes BuzzKey under it.

Other evidence is weaker for this decision. [Canadian #66](https://github.com/zackcornelius/CarConnectivity-connector-volkswagen-na/issues/66) reports an April 2026 iOS client `70e4f425-9ee8-4430-a5b1-b58b69a9b3bf_MYVW_IOS`, `kombi:///login` and PKCE, but did not observe native token exchange; this is a different region before the enforcement reports. [Historical Car-Net notes](https://github.com/thomasesmith/vw-car-net-api) describe a purported iOS client and `car-net:///oauth-callback` for the 2019-era service; the last commit `d32a334c849a5ca6f79d2038b29b7a4b29d35110` abandoned it in December 2021. Neither is evidence of a current working U.S. grant. EU examples using `emea.bff.cariad.digital` are also not U.S. iOS evidence.

### Could com.ecardoso626.buzzkey satisfy attestation?

**Not if Volkswagen requires its own app identity.** Apple App Attest validation checks an RP-ID hash derived from the App ID prefix (usually Team ID) and bundle identifier, plus the attested key, challenge and environment. An independently signed BuzzKey app can attest **BuzzKey**, not Volkswagen's app. A genuine iPhone, TestFlight installation or App Attest entitlement does not erase that distinction. [Apple verification requirements](https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server).

DeviceCheck is a separate Apple mechanism involving app/device tokens and developer-side server verification; it must not be treated as synonymous with App Attest. [Apple DeviceCheck](https://developer.apple.com/documentation/devicecheck). Public evidence reviewed does not establish which mechanism VW uses, its exact Team ID/bundle allowlist, signing requirements, entitlement, App Store receipt checks, or absence of such checks. No values were guessed. **VW-only attestation would mean BLOCKED; whether that is the actual iOS policy remains unproven.**

### Could login move to the iPhone and the session move to Umbrel?

Architecturally reasonable **only if VW permits it**. A native OAuth flow can use an external browser session and PKCE; that is a platform capability, not permission to use another application's registered identity. [OAuth for native apps, RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252).

Before the preferred chain can be called viable, establish all of these:

1. VW-issued/approved client registration and callback for BuzzKey, or an explicitly supported independent-app channel for U.S. owners.
2. Any app/device checks accept `com.ecardoso626.buzzkey` under its own signing team.
3. Issued tokens have the correct U.S. garage/telemetry/control audiences and scopes; a login success alone does not establish these.
4. VW permits backend use and refresh. Determine whether tokens require a device-held proof key, fresh attestation per refresh/request, or another non-transferable binding. Moving a bearer string cannot move such a key or grant rights.
5. Backend-only operation remains possible while the phone is offline. If a fresh phone proof is mandatory, autonomous Umbrel polling/control is not achieved by a one-time token handoff.

If these gates pass, prefer **BuzzKey iPhone → approved VW authentication → authenticated private HTTPS/NIP-98 handoff → immediate AES-256-GCM SQLite storage → supported backend renewal/operations**. Account/session schemas and the account API would need a narrow, tested extension; the existing credential endpoint is not a general token-import API. Validate grant binding/state/nonce, scope, expiry, refresh rotation and device revocation semantics. NIP-98 authenticates our device to our backend; it does not convince VW to authorize that device or substitute for TLS encryption.

Under a supported delegated grant, the backend can stop asserting a mobile-platform identity and use its own authorized role. Under a VW-app-only grant, it cannot simply drop required mobile identity/proofs after login. No handoff, token import, iOS OAuth implementation or Android-path deletion was made in this investigation.

## 7. myVW web-portal findings

VW advertises the U.S. web portal alongside subscription/account services and describes remote operation chiefly through the mobile app. Public owner guides also mention portal access in broad PIN-sharing notices, so **account-management-only is not proven**. [Connected services](https://www.vw.com/en/owners-and-services/apps-and-connected-services/connected-services-and-plans.html), [myVW service description](https://www.vw.com/en/myvw-terms.html), [owner guide](https://www.vw.com/en/owners-and-services/about-my-vehicle/quick-start-guides.html/__app/2025/jetta/myVW.app).

Opening the public portal link without an account exposed an auth-proxy redirect using a distinct web client `a026226c-b053-4706-a4c0-20ef46708a82_MYVW`, authorization-code response, `openid`, and callback `https://www.vw.com/app/authproxy/login/oauth2/code/vw-en-myvw`. The browsing tool stopped at the inaccessible authorization target. No credentials were submitted, no token exchange ran, and no account/vehicle API was accessed. Transient state/nonce values are not retained here. This establishes a web login entry point, not an independent API entitlement.

| Browser function                    | Evidence available without signing in                                                                                                                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner account / vehicle information | Account, vehicle-detail and finance/subscription management publicly advertised; authenticated garage enumeration not checked.                                                                                  |
| SOC / range / odometer              | Current U.S. portal availability **unknown** for each field.                                                                                                                                                    |
| Charging / climate / lock state     | Current U.S. portal availability **unknown** for each field.                                                                                                                                                    |
| Remote commands                     | Broad legacy references exist; current U.S. ID. Buzz browser controls and supported independent access **unknown**.                                                                                             |
| Authentication mechanics            | Separate web OAuth client observed. Browser/server cookies are plausible but the authenticated session was not inspected. Passkeys, token-exchange implementation and any attestation requirements **unknown**. |

Do not reuse the web client's callback or assume browser login tokens can be exported to BuzzKey. **Path status: UNKNOWN.**

## 8. Official APIs and other channels

- **OKAPI is product/configuration data**, including model options/buildability/WLTP—not owner SOC, current locks or remote commands. [VW OKAPI](https://productdata.volkswagenag.com/).
- Volkswagen Group Info Services genuinely offers connected **Charging Data** and **Charging Control**, not merely product catalogs. Published products include SOC/range/mileage and charging functions for contracted B2B customers, but list European markets; the U.S. is absent. They do not establish a self-service U.S. ID. Buzz owner API. [Charging Data](https://www.drivesomethinggreater.com/solutions/all-solutions/charging-data), [Charging Control](https://www.drivesomethinggreater.com/solutions/all-solutions/charging-control), [developer hub](https://www.drivesomethinggreater.com/developer-hub).
- The EU Data Act channel is not demonstrated for this U.S. account. Do not transpose European grants or regional eligibility.
- Smartcar is a separate commercial integration candidate, not proof of an official U.S. VW owner grant. Its announced VW Group partnership explicitly covers Europe. Compatibility is model/region/function dependent; neither U.S. ID. Buzz coverage today nor climate/control rights were validated here. No provider signup or connection was attempted. [Partnership](https://webflow.smartcar.com/blog/smartcar-integrates-with-volkswagen-group-info-services-ag-across-europe), [compatibility limitations](https://smartcar.com/product/compatible-vehicles).

**Official owner API: NOT AVAILABLE in the published offerings reviewed for this U.S. personal-owner use case.** This is not a claim that no private OEM/business agreement can exist. VW would need to confirm any U.S. partner alternative and its independent-client/session rights before we rely on it.

## 9. Ranked causes of our recorded 401

Confidence means confidence as an explanation of this failure, not a measured probability.

| Rank | Candidate                                | Confidence | Reason                                                                                                                                                                     |
| ---- | ---------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Genuine Play Integrity validation        | **HIGH**   | Our Android grant/placeholder and failure stage match the reported U.S. transition; independent maintainers report the same pattern. Raw local VW reason was not retained. |
| 2    | Other token-policy/app-proof requirement | **MEDIUM** | Token gateway refusal is directly observed; an undocumented additional binding/anti-abuse rule cannot be separated from attestation by our safe trace.                     |
| 3    | PKCE mismatch                            | **LOW**    | Source/test preserve one verifier and S256 challenge; previously supported representation. Offline tests cannot establish current server acceptance.                       |
| 4    | Client/redirect binding change           | **LOW**    | Code callback still reached; no known applicable registration change. Client recognition does not guarantee token entitlement.                                             |
| 5    | Token endpoint/client replacement        | **LOW**    | Expected endpoint responds and current integrations still target it; no supported replacement published.                                                                   |
| 6    | Authorization-code issue                 | **LOW**    | Code extraction completed and exchange followed immediately, without deliberate reuse. Code validity/content was intentionally not logged.                                 |

Missing login form fields are excluded as the observed failure. Credentials/account issues are less supported than token-policy rejection; no explicit bad-credentials evidence exists. Do not label every token 401 as attestation or invent a definitive VW error body.

## 10. Feasibility decision table

| Path                                                          | Status                                      | Decision                                                                                                                                                           |
| ------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. Current server-side Car-Net/Android grant                  | **BLOCKED**                                 | Preserve stop marker; no placeholder/header experiments.                                                                                                           |
| B. Legitimate U.S. iOS grant for independently signed BuzzKey | **INSUFFICIENT EVIDENCE**                   | Prioritized candidate; known reported iOS ID does not establish independent eligibility or backend refresh rights. Replace Android only after evidence gates pass. |
| C. myVW web portal                                            | **UNKNOWN**                                 | Web login exists; required telemetry/control and delegation rights remain unverified.                                                                              |
| D. Documented official U.S. personal-owner API                | **NOT AVAILABLE** in reviewed documentation | Current official connected products are regional B2B offerings, not a documented matching owner grant.                                                             |
| E. Wait for legitimate community/OEM development              | **FEASIBLE**                                | Continue offline product work and manual source review.                                                                                                            |
| F. Commercial broker                                          | **UNKNOWN** for the complete requirement    | Needs current U.S. ID. Buzz and permissions confirmation; not a demonstrated direct iOS solution.                                                                  |

## 11. BuzzKey architecture and sequencing

Keep the native mobile UI, pairing/device identity, NIP-98, Node service, SQLite migrations, encrypted secret store, command ledger, observation/freshness model, analytics schema and Docker/Umbrel packaging. None depends conceptually on pretending to be Android. Preserve `com.ecardoso626.buzzkey`, local native/TestFlight build configuration and signing workflow; a new TestFlight build/upload was not attempted and existing distribution status was not revalidated here.

Continue with deterministic demonstration data in a separately configured local/test environment. Existing fail-closed fetch fixtures and Node service tests already exercise discovery/state, commands and persistence without VW. A user-facing demo mode is **proposed work**, not a feature verified present: add an explicit simulated provider/service boundary, isolated SQLite/keys, obvious demo labeling, repeatable scenarios and simulated command outcomes with no network fallback. Some current Node orchestration directly uses VW functions; the existing domain adapter is not yet a universal plug-in switch. A focused injection seam can address that without another runtime/persistence rewrite.

Test unknown/stale/offline observations, accepted-versus-confirmed commands, interruptions and analytics on synthetic data. Do not mix demo observations with the production account, enable the production scheduler or represent simulation as live telemetry. Live command validation moves behind an authentication viability gate. **No architecture implementation in this milestone.**

## 12. Manual monitoring plan

No automation created. Review these specific public sources for a legitimate supported grant, not token relay instructions:

- [sstur/vwapp commits](https://github.com/sstur/vwapp/commits/main/) and its auth warnings.
- [VW Group Connect #1165](https://github.com/its-me-prash/vwgroup-connect-ha/issues/1165), [#1215](https://github.com/its-me-prash/vwgroup-connect-ha/issues/1215), [#1432](https://github.com/its-me-prash/vwgroup-connect-ha/issues/1432), and [auth-source history](https://github.com/its-me-prash/vwgroup-connect-ha/commits/main/custom_components/vag_connect/cariad/auth/idk.py).
- [CarConnectivity NA #90](https://github.com/zackcornelius/CarConnectivity-connector-volkswagen-na/issues/90), [#66](https://github.com/zackcornelius/CarConnectivity-connector-volkswagen-na/issues/66), and releases; distinguish dates/regions and reject official-app extraction/integrity-modification solutions.
- [VW Group developer offerings](https://www.drivesomethinggreater.com/developer-hub) for explicit U.S. eligibility and third-party app registration; official U.S. owner/portal announcements.

Keywords: `US`, `North America`, `us00`, `MYVW_IOS`, `independent client`, `OAuth registration`, `App Attest`, `DeviceCheck`, `attestation`, `token exchange`, `refresh_token`, `INVALID_REQUEST`, `official owner API`. A refreshed README or successful official-app login alone is not evidence of third-party compatibility.

## 13. Conditions before another live attempt

**Another attempt is not justified now.** Require new verifiable evidence of an applicable supported U.S. flow: current client/redirect registration available to BuzzKey, precise attestation policy, and permitted backend token use/renewal. Prefer OEM documentation/confirmation or a reproducible independent implementation that uses its own authorized identity without extracting another app's tokens. If the iOS gate is VW-only, document it as blocked and seek an official delegated channel instead.

Then prepare the narrow change and synthetic tests, review log safety and request budget, and obtain fresh explicit authorization for any deployment and bounded live validation. Do not reset the consumed marker under this investigation. Scheduler remains **DISABLED**; zero new live password attempts, zero account VW API calls and zero vehicle mutations. Public documentation retrieval and the unauthenticated portal-link observation are the only VW web interactions in this investigation.
