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

Initial assessment below is supplemented and superseded where more specific by [the public-asset follow-up](#14-myvw-web-portal-investigation).

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

## 14. myVW Web Portal Investigation

Follow-up reviewed **2026-10-04**, prioritizing the browser path. **Outcome D — evidence still insufficient.** Public source confirms vehicle-account features and a mileage-query definition, so declaring the portal account-only would be too strong. It does not establish a usable independent BuzzKey grant, current ID. Buzz telemetry/control, or portable credentials. No architecture change is justified.

### Official portal and scope of observation

The current [U.S. connected-services page](https://www.vw.com/en/owners-and-services/apps-and-connected-services/connected-services-and-plans.html) advertises “Login to myVW Web Portal.” The owner landing page is [www.vw.com/en/owners.html](https://www.vw.com/en/owners.html). Its HTML loads the U.S. `US-MyVW-V1` feature app, not the similarly named European apps also present in the shared configuration catalog. The published login link starts at `https://www.vw.com/app/authproxy/login`, with legal-entity selector `vw-en-myvw` and scope `openid`.

VW's [Remote Access page](https://www.vw.com/en/owners-and-services/apps-and-connected-services/connected-services-and-plans/remote-access.html) describes battery charging, climate, charging profiles/timers, door/window status and lock/unlock in its mobile-app offering. That establishes official mobile functions, **not browser parity**. The [myVW service description, effective October 1, 2026](https://www.vw.com/en/myvw-terms.html), covers vehicle details, service/warranty information, account/subscription management and financial-account access through the portal; it does not provide an independent connected-car API contract. This is a product-scope observation, not a legal interpretation.

Research downloaded only public HTML, referenced JavaScript/configuration, and unauthenticated redirect metadata. Scripts were read, not executed. There were **zero credential submissions, zero token exchanges, zero authenticated/vehicle API calls, zero mutations**. No GraphQL introspection, endpoint probing, session refresh, S-PIN action, real-account access or production change occurred. Anonymous redirect cookies stayed in memory; cookie values, state and nonce values were not printed or retained in the report. Scheduler configuration remains **DISABLED**; its consumed login marker was not touched.

### Browser authentication architecture

The exact published link produced this redirect chain; observation stopped before fetching the identity-provider login page:

| Stage                       | Observed public metadata                                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser entry               | `www.vw.com/app/authproxy/login` → `/app/authproxy/login/vw-en-myvw`                                                                                           |
| Web authorization           | `b-h-s.spr.us00.p.con-veh.net/oidc/v1/authorize`; client `a026226c-b053-4706-a4c0-20ef46708a82_MYVW`; `response_type=code`; `scope=openid`                     |
| Web callback                | `https://www.vw.com/app/authproxy/login/oauth2/code/vw-en-myvw` — owned by VW                                                                                  |
| Federated identity provider | `identity.na.vwgroup.io/oidc/v1/authorize`; client `b680e751-7e1f-4008-8ec1-3a528183d215@apps_vw-dilab_com`; `scope=openid email`; authorization-code response |
| Identity-provider callback  | `https://b-h-s.spr.us00.p.con-veh.net/oidc/v1/oauth/callback` — also owned by VW                                                                               |

This is a **standard user-facing browser authorization-code entry**, without a native custom scheme. Neither observed authorize URL included `code_challenge` or `code_challenge_method`; therefore **ordinary authorization code plus PKCE is not confirmed for this web flow**. Do not add a guessed challenge, change its callback or infer how its server authenticates at token exchange. The redirect's `openid` scope is not an observed access-token audience or a list of vehicle permissions.

Public [shared authentication-service code](https://feature-services.vwonehub.io/client-bundle-v0.131.0.js) checks the server's authenticated state and proxies requests with browser cookies (`credentials: include`) and an `X-CSRF-TOKEN` header. It provides no demonstrated token-export grant. The authenticated cookie policy, server token exchange and renewal implementation were not inspected. No Google/Apple attestation field was found in the reviewed portal login metadata or application-specific authentication code; absence there cannot exclude server-side requirements. **Passkeys/WebAuthn, extra login challenges and whether ordinary interaction alone completes login remain UNKNOWN.** We did not submit a login to find out.

### Public browser services and capability evidence

The page-linked [feature-app catalog](https://www.vw.com/en.feature-apps.json) contains U.S. production configuration as well as unrelated regions/test environments. Only the production U.S. app referenced by the owner page was treated as the active entry. Public configuration names these upstream services; **none of their data endpoints was called**:

| Service                                | Public-source role and limit                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `https://api.vw.com/graphql`           | Configured GraphQL backend. The browser's actual request path uses the VW auth proxy with `resourceHost=graphql`, rather than supplying a raw mobile bearer token. |
| `https://myvwauth.vw.com/oiwauth`      | Configured myVW gateway; a proxy logging route is visible. Its server implementation and grants are not public in the inspected assets.                            |
| `https://b-h-s.spr.us00.p.con-veh.net` | Configured Car-Net service origin, also used for public terms/enrollment resources. Sharing this origin does not prove access-token interchangeability.            |
| `https://carnet.vw.com`                | Configured Car-Net web destination. Public source defines a first-party session/deep-link handoff; no such session was requested or captured.                      |

The active [U.S. myVW bundle](https://prod.vwmyvwfeatureapp.svc.vwusa.io/assets/myvw/myvw-umd.js) defines account/vehicle queries with VIN and vehicle ID, vehicle-management/enrollment functions, a `getLatestVehicleStatus` query selecting `currentMileage`, and `getCarnetDeepLinkSession`. The mileage helper's existence does not show it is currently invoked or rendered for this vehicle. GraphQL requests delegate to the auth service with resource identifier `graphql`; the client identifies its U.S. locale as `VW_US_MYVW_FA`. No direct ID. Buzz SOC, climate or lock command path was established from this bundle. Generic battery/charging icon names are not capability evidence.

The separately published [dashboard bundle](https://prod.vwmyvwdashboardfeatureapp.svc.vwusa.io/featureApp.js) repeats the mileage query and defines the same-origin proxy prefix `/app/authproxy/vw-en-myvw/proxy/`. Its `getCarnetDeepLinkSession` operation returns a `deepLinkUrl`. This is evidence of VW-to-VW navigation, not a BuzzKey callback or transferable refresh token. Treat any real returned deep link as sensitive; do not collect or share it.

The public [Car-Net bundle](https://carnet.vw.com/assets/index-CI2i28Sj.js) defines same-origin REST paths for `cwpmeta/session`, session refresh/expiry, `customer/account`, `/garage/findVehicleByVehicleId`, subscription summary, trips and vehicle-health/history features. These are source references, not executed requests or portable API specifications. Its e-mobility routing singles out `e-golf`; battery/climate profile translations therefore cannot establish current ID. Buzz controls. The `/batteryinfo` feature concerns battery-label/compliance lookup, not proof of live SOC. No applicable ID. Buzz charging/climate/lock command request was identified. Server-supplied metadata and authenticated feature eligibility remain unobserved.

**Availability below concerns the official browser portal, not BuzzKey access.** AVAILABLE means a concrete public implementation/product feature was identified; actual availability for this account remains untested. UNKNOWN is intentional where only a helper, legacy text or no applicable evidence exists.

| Requested function     | Web availability | Evidence/remaining limit                                                                                  |
| ---------------------- | ---------------- | --------------------------------------------------------------------------------------------------------- |
| Registered vehicles    | **AVAILABLE**    | Account query includes a vehicles collection and vehicle selection/management. No real garage enumerated. |
| VIN / vehicle identity | **AVAILABLE**    | Explicit VIN/vehicle-ID fields and vehicle detail query. No real identifiers read.                        |
| Battery SOC            | **UNKNOWN**      | No applicable current ID. Buzz browser data path established.                                             |
| Range                  | **UNKNOWN**      | Legacy EV text does not establish current availability.                                                   |
| Odometer               | **UNKNOWN**      | Mileage query exists; runtime use, returned data, timestamp and ID. Buzz eligibility unverified.          |
| Lock status            | **UNKNOWN**      | Mobile advertising is not web evidence.                                                                   |
| Doors / windows        | **UNKNOWN**      | No applicable browser implementation established.                                                         |
| Charging state         | **UNKNOWN**      | Legacy EV strings are insufficient.                                                                       |
| Climate state          | **UNKNOWN**      | No applicable browser implementation established.                                                         |
| Location               | **UNKNOWN**      | No current ID. Buzz location display/request established.                                                 |
| Charging controls      | **UNKNOWN**      | No applicable current command path established.                                                           |
| Climate controls       | **UNKNOWN**      | No applicable current command path established.                                                           |
| Lock / unlock          | **UNKNOWN**      | No applicable current command path established.                                                           |

There is insufficient evidence to mark these UNKNOWN functions NOT AVAILABLE globally. Conversely, the mileage helper alone is insufficient for Outcome B: BuzzKey has not recovered a supported read-only telemetry channel, analytics feed or historical data source.

### Token portability and independent registration

**Browser session usable by the current Car-Net API: UNKNOWN.** First-party server proxies and deep links may mediate access internally. No observed token claims, audience, client binding, permitted scope, renewal behavior or export mechanism establish that a browser token can replace the mobile grant. A browser cookie is not a mobile access/refresh token. We did not inspect cookies, decode real tokens, replay requests, request deep links, or try the web client at the token endpoint.

No publicly documented **U.S. consumer myVW registration for BuzzKey's own OAuth client and redirect** was found. Classify actual availability as **UNKNOWN**, with no currently documented usable offering; a private partner arrangement cannot be excluded by public searching.

- VW Group Info Services documents [ONE Business ID client credentials](https://www.drivesomethinggreater.com/developer-hub/first-steps/Obtain-client-ID-and-secret) after business onboarding/subscription. This is real registration, but for its contracted data products, not proof of a U.S. owner authorization-code grant. Its [Charging Data markets](https://www.drivesomethinggreater.com/solutions/all-solutions/charging-data) remain European; the U.S. is not listed.
- The [EU Data Act API](https://www.drivesomethinggreater.com/developer-hub/api-specifications/EUDA-api-specification) requires product onboarding/subscription. It does not establish U.S. eligibility or a myVW callback for BuzzKey.
- [OKAPI](https://productdata.volkswagenag.com/quick-start.html) is vehicle product/configuration data, not owner connected-vehicle access.
- The still-indexed [VW Automotive Cloud guide](https://int-vwacv-eab-apim-portal.vwcloud.org/start) describes Azure tenant/app registration and client-credential subscriptions, and announces its replacement by the end of 2021. It is not evidence of a current public U.S. myVW owner-consent channel. No tenant registration or API test was attempted.

Do not reuse either VW callback, change redirect parameters to BuzzKey, borrow a first-party browser cookie, or treat a public web client ID as an independent-client registration. A legitimate future design would require a VW-approved BuzzKey client/callback, supported scopes, documented exchange/refresh and backend delegation. Only then would system-browser/ASWebAuthenticationSession authorization and encrypted backend storage be an actionable proposal. No replacement was implemented.

### Android / iOS / web comparison

Labels describe the evidence, not live interoperability. For official iOS, LIKELY means a public report rather than verified official configuration. Telemetry/control entries refer to the **official platform channel**; they do not imply BuzzKey can access it.

| Property                           | Android inherited flow                                    | Official U.S. iOS                      | U.S. Web Portal                                                 |
| ---------------------------------- | --------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------- |
| OAuth client known                 | **CONFIRMED** in our code                                 | **LIKELY**, reported iOS ID            | **CONFIRMED**, observed web ID                                  |
| Redirect known                     | **CONFIRMED**, `kombi:///login`                           | **LIKELY**, same reported scheme       | **CONFIRMED**, VW HTTPS callbacks                               |
| PKCE                               | **CONFIRMED**, S256 in code                               | **UNKNOWN**, current exact contract    | **UNKNOWN** end-to-end; absent from observed authorize URLs     |
| Attestation                        | **LIKELY** enforced; placeholder fails                    | **UNKNOWN**                            | **UNKNOWN** server policy; no mobile-attestation field observed |
| Independent BuzzKey app usable now | **NO**, current flow blocked                              | **UNKNOWN**                            | **UNKNOWN**, no supported registration found                    |
| Vehicle telemetry                  | **CONFIRMED** protocol implementation; live login blocked | **CONFIRMED** official mobile offering | **UNKNOWN** connected telemetry; vehicle identity implemented   |
| Vehicle controls                   | **CONFIRMED** protocol implementation; live login blocked | **CONFIRMED** official mobile offering | **UNKNOWN** for current ID. Buzz                                |
| Backend token reusable             | **NO** usable session obtained; current flow blocked      | **UNKNOWN**                            | **UNKNOWN**                                                     |

The earlier iOS uncertainty and Android failure analysis remain unchanged. Standard browser OAuth does not, by itself, remove client-registration or token-audience requirements.

### Decision and one optional manual observation

**Outcome D — evidence still insufficient.** The portal is **PARTIAL** for the requested investigation: vehicle-account functions are implemented, but connected telemetry/control and independent delegation remain unresolved. There is no demonstrated replacement authentication path. Another BuzzKey live token-exchange attempt is **NOT justified**.

The single missing runtime observation is: **after one normal owner login, does the current U.S. ID. Buzz portal actually display passive connected-vehicle information (especially mileage/SOC/range) or control entry points, rather than just ownership/subscriptions?** Public code makes this observation relevant. It would resolve what this account's browser UI offers; it would **not** prove token portability or independent registration. Those still require a supported VW contract/confirmation.

Safe optional steps for the owner, outside this completed public-source investigation:

1. In your own normal Mac browser, open the [official VW connected-services page](https://www.vw.com/en/owners-and-services/apps-and-connected-services/connected-services-and-plans.html) and use its web-portal login link. Enter credentials only on Volkswagen's page. If login fails, stop; do not retry for this check.
2. After login, view the vehicle/garage page. If the link returns to the marketing page, open [the official owner landing page](https://www.vw.com/en/owners.html) in that same browser. Follow only ordinary vehicle-details navigation; do not trigger refresh/wake, commands, S-PIN changes, enrollment or subscription changes.
3. Report only which labels/fields are present: vehicle identity, mileage, SOC, range, locks, doors/windows, charging, climate, location, and whether control buttons exist. Use **present / absent / error**, without actual VIN, account details, location or measurements. Do not press control buttons.
4. Share only the hostname(s), without query strings, fragments or session-bearing deep links. If easier, send a tightly cropped/redacted screenshot of feature labels that excludes the address bar, personal data and vehicle identifiers. **No DevTools, cookies, headers, codes, tokens, S-PIN, passwords, HAR exports or browser-storage inspection are needed.**

Preserve Node/SQLite/encryption/NIP-98/mobile transport/command semantics and Umbrel packaging. Keep live integration paused and the scheduler disabled. The result does not change the feasible roadmap, so `MIGRATION_PLAN.md` is unchanged. No automated monitoring, implementation, deployment or new login budget was created.

### Evidence reproducibility

Public assets can change. Locally inspected on 2026-10-04:

| Public asset                             | SHA-256 of inspected bytes                                         |
| ---------------------------------------- | ------------------------------------------------------------------ |
| U.S. `myvw-umd.js` linked above          | `ed52b4a0a78a9986f06aa5ecbdfe9865423b8d0a8b09d89a91ead087567243a2` |
| Dashboard `featureApp.js` linked above   | `3e2525c7eefa2f7d51c8fc5a29a38be10e746d5fbb926e32959b121f736925cb` |
| Car-Net `index-CI2i28Sj.js` linked above | `ce8d0e9c6903123902ca7bd0f26e7d73b40f2199d90a973293cee5891191b753` |

Public source references and sanitized metadata only are recorded in Git; downloaded bundles and temporary research files are not added. No bearer/session data or configuration keys are included.
