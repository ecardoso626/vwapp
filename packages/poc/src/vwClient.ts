/**
 * VW North America (Car-Net / myVW US) client for a 2025 VW ID Buzz.
 *
 * The US "myVW" app (com.vw.carnet.release) talks to the legacy Car-Net backend
 * `b-h-s.spr.us00.p.con-veh.net`, NOT the European CARIAD stack. Auth is plain
 * OAuth2 authorization-code + PKCE (S256), a PUBLIC client with NO secret:
 *
 *   1. GET {host}/oidc/v1/authorize (device client 59992128…_MYVW_ANDROID,
 *      redirect_uri kombi:///login) -> 302 to identity.na.vwgroup.io login,
 *      which uses the browser-IDP client b680e751…@apps_vw-dilab_com.
 *   2. Scrape VW's hosted IDP: identifier-first (email page -> password page),
 *      posting to /signin-service/v1/<idpClient>/login/{identifier,authenticate}.
 *   3. Follow redirects to kombi:///login?code=… and exchange the code at
 *      {host}/oidc/v1/token with the PKCE verifier.
 *   4. Read status from {host}: /account/v1/garage, /rvs/v1/vehicle/{uuid},
 *      /ev/v1/vehicle/{uuid}/charge/summary.
 *
 * Flow verified against three OSS implementations (matpoulin/zackcornelius
 * CarConnectivity-connector-volkswagen-na, its-me-prash/vwgroup-connect-ha).
 */

import { createHash, randomBytes } from "node:crypto";
import { CookieJar } from "tough-cookie";

// ---- North America (US) constants ------------------------------------------
const API = "https://b-h-s.spr.us00.p.con-veh.net";
const IDP = "https://identity.na.vwgroup.io";
const DEVICE_CLIENT = "59992128-69a9-42c3-8621-7942041ba824_MYVW_ANDROID";
const IDP_CLIENT = "b680e751-7e1f-4008-8ec1-3a528183d215@apps_vw-dilab_com";
const REDIRECT_URI = "kombi:///login";
const SCOPE = "openid";

const APP_UA = "MyVW/1.0 Android";
const BROWSER_UA =
  "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Version/4.0 Chrome/74.0.3729.185 Mobile Safari/537.36";

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

interface Tokens {
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
  expiresAt: number;
}

interface FollowResult {
  res: Response;
  finalUrl: string;
  body: string;
  /** Set when a redirect Location used the kombi:// callback scheme. */
  callbackUrl?: string;
}

export class VwClient {
  private jar = new CookieJar();
  private tokens?: Tokens;
  private user: string;
  private password: string;
  /** When true, `send()` logs each VW request/response (secrets redacted). */
  debug = false;

  constructor(user: string, password: string) {
    this.user = user;
    this.password = password;
  }

  // --- fetch carrying our cookie jar + following redirects manually ----------
  private async request(
    url: string,
    init: Omit<RequestInit, "headers"> & {
      headers?: Record<string, string>;
    } = {},
    { maxRedirects = 30 } = {},
  ): Promise<FollowResult> {
    let current = url;
    let method = (init.method ?? "GET").toUpperCase();
    let body = init.body;
    let extraHeaders = init.headers ?? {};

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const cookie = await this.jar.getCookieString(current);
      const headers: Record<string, string> = {
        "user-agent": BROWSER_UA,
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "x-requested-with": "com.volkswagen.weconnect",
        ...extraHeaders,
        ...(cookie ? { cookie } : {}),
      };

      const res = await fetch(current, {
        method,
        headers,
        body,
        redirect: "manual",
      });

      for (const sc of res.headers.getSetCookie())
        await this.jar.setCookie(sc, current).catch(() => undefined);

      if (REDIRECT_CODES.has(res.status)) {
        const loc = res.headers.get("location");
        if (!loc) throw new Error(`redirect ${res.status} without Location`);
        if (loc.startsWith("kombi://"))
          return { res, finalUrl: current, body: "", callbackUrl: loc };

        current = new URL(loc, current).toString();
        if (res.status === 302 || res.status === 303) {
          method = "GET";
          body = undefined;
          const rest = { ...extraHeaders };
          delete rest["content-type"];
          extraHeaders = rest;
        }
        continue;
      }

      return { res, finalUrl: current, body: await res.text() };
    }
    throw new Error("too many redirects");
  }

  // --------------------------------------------------------------------------
  async login(): Promise<void> {
    const codeVerifier = randomBytes(64).toString("hex").toUpperCase();
    const codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");

    const authUrl =
      `${API}/oidc/v1/authorize?` +
      new URLSearchParams({
        redirect_uri: REDIRECT_URI,
        scope: SCOPE,
        prompt: "login",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state: randomBytes(16).toString("hex"),
        response_type: "code",
        client_id: DEVICE_CLIENT,
      });

    // GET authorize -> follow 302 chain to the IDP email form.
    const emailPage = await this.request(authUrl);
    if (emailPage.callbackUrl) {
      await this.exchangeCode(emailPage.callbackUrl, codeVerifier);
      return;
    }
    assertNoTerms(emailPage.body);

    // Step 1: identifier (email) page.
    const emailForm = extractHiddenInputs(emailPage.body);
    if (!("_csrf" in emailForm) || !("hmac" in emailForm))
      throw new Error(
        "could not parse the VW email login form (markup may have changed)",
      );
    const pwPage = await this.request(
      `${IDP}/signin-service/v1/${IDP_CLIENT}/login/identifier`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          ...emailForm,
          email: this.user,
        }).toString(),
      },
    );
    if (pwPage.callbackUrl) {
      await this.exchangeCode(pwPage.callbackUrl, codeVerifier);
      return;
    }
    assertNoTerms(pwPage.body);

    // Step 2: password page -> authenticate. Fields live in an inline JS blob.
    const pwForm = {
      _csrf: matchOne(pwPage.body, /csrf_token['":\s]+([\w.-]+)/i, "_csrf"),
      relayState: matchOne(
        pwPage.body,
        /"relayState":"([^"]+)"/i,
        "relayState",
      ),
      hmac: matchOne(pwPage.body, /"hmac":"([^"]+)"/i, "hmac"),
      email: this.user,
      password: this.password,
    };
    const authRes = await this.request(
      `${IDP}/signin-service/v1/${IDP_CLIENT}/login/authenticate`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(pwForm).toString(),
      },
    );

    if (!authRes.callbackUrl) {
      if (
        /login\.errors?\.password_invalid|wrong-email-credentials/i.test(
          authRes.body,
        )
      )
        throw new Error("VW rejected the login: wrong email or password.");
      if (/login\.error\.throttled/i.test(authRes.body))
        throw new Error("VW login throttled — wait a bit and retry.");
      assertNoTerms(authRes.body);
      throw new Error(
        `Login did not reach the kombi:// callback (HTTP ${authRes.res.status}). ` +
          `The IDP login markup may have changed.`,
      );
    }
    await this.exchangeCode(authRes.callbackUrl, codeVerifier);
  }

  private async exchangeCode(
    callbackUrl: string,
    codeVerifier: string,
  ): Promise<void> {
    const params = mergeUrlParams(callbackUrl);
    const code = params.get("code");
    if (!code)
      throw new Error(
        `callback had no code. error=${params.get("error")} ${
          params.get("error_description") ?? ""
        }`,
      );

    const res = await fetch(`${API}/oidc/v1/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        "user-agent": APP_UA,
      },
      body: new URLSearchParams({
        // VW now requires a play_integrity_token on the token grant (only
        // presence is checked today, not validity — see backend/src/vw/client.ts).
        play_integrity_token: "unavailable",
        grant_type: "authorization_code",
        code,
        client_id: DEVICE_CLIENT,
        redirect_uri: REDIRECT_URI,
        code_verifier: codeVerifier,
      }).toString(),
    });
    if (!res.ok)
      throw new Error(
        `token exchange failed: ${res.status} ${await res.text().catch(() => "")}`,
      );
    const t = (await res.json()) as Record<string, any>;
    const accessToken = t.access_token ?? t.accessToken;
    if (!accessToken) throw new Error("token response had no access_token");
    this.tokens = {
      accessToken,
      idToken: t.id_token ?? t.idToken,
      refreshToken: t.refresh_token ?? t.refreshToken,
      expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000,
    };
  }

  // --- authenticated API ----------------------------------------------------
  private async api<T = any>(path: string): Promise<T> {
    if (!this.tokens) throw new Error("not logged in");
    const res = await fetch(`${API}${path}`, {
      headers: {
        authorization: `Bearer ${this.tokens.accessToken}`,
        accept: "application/json",
        "user-agent": APP_UA,
      },
    });
    if (!res.ok)
      throw new Error(
        `GET ${path} -> ${res.status} ${res.statusText}: ${await res
          .text()
          .catch(() => "")}`,
      );
    return res.json() as Promise<T>;
  }

  /** List vehicles. Returns objects with vin, vehicleId/uuid, nickname, model. */
  async getVehicles(): Promise<any[]> {
    const data = await this.api("/account/v1/garage");
    return data?.data?.vehicles ?? data?.vehicles ?? [];
  }

  /** Remote vehicle status: doors, locks, range, odometer, location. */
  getRvs(uuid: string): Promise<any> {
    return this.api(`/rvs/v1/vehicle/${uuid}`);
  }

  /** EV charge summary: battery SoC, charging state, plug, target SoC. */
  getChargeSummary(uuid: string): Promise<any> {
    return this.api(`/ev/v1/vehicle/${uuid}/charge/summary`);
  }

  // --- commands (PoC) -------------------------------------------------------

  /** The myVW user id, from the OIDC id_token's `sub` claim. */
  getUserId(): string {
    if (!this.tokens?.idToken)
      throw new Error("no id_token (need scope openid)");
    const part = this.tokens.idToken.split(".")[1];
    if (!part) throw new Error("malformed id_token");
    const json = Buffer.from(part, "base64url").toString("utf8");
    const sub = (JSON.parse(json) as { sub?: string }).sub;
    if (!sub) throw new Error("id_token has no sub claim");
    return sub;
  }

  /** Decode id_token claims (for inspection during the PoC). */
  idTokenClaims(): Record<string, any> {
    const part = this.tokens?.idToken?.split(".")[1];
    if (!part) return {};
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  }

  /** Authenticated request against the app backend. Returns {status, body}. */
  async send(
    method: string,
    path: string,
    body?: unknown,
    opts: {
      headers?: Record<string, string>;
      useIdToken?: boolean;
      bearer?: string;
    } = {},
  ): Promise<{ status: number; body: any }> {
    if (!this.tokens) throw new Error("not logged in");
    const bearer =
      opts.bearer ??
      (opts.useIdToken ? this.tokens.idToken : this.tokens.accessToken);
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer ?? ""}`,
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": APP_UA,
        ...(opts.headers ?? {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* leave as text */
    }
    if (this.debug) {
      const hdrs = Object.keys(opts.headers ?? {});
      console.log(`\n[VW] ${method} ${path} -> ${res.status}`);
      if (hdrs.length) console.log(`     req-headers: ${hdrs.join(", ")}`);
      // Surface response headers that often carry async-operation pointers.
      const resHeaders: string[] = [];
      res.headers.forEach((v, k) => {
        if (
          /location|operation|request|status|retry|poll|correlation|x-/i.test(k)
        )
          resHeaders.push(`${k}: ${v}`);
      });
      if (resHeaders.length)
        console.log(`     res-headers: ${resHeaders.join(" | ")}`);
      if (body !== undefined) console.log(`     req:  ${redact(body)}`);
      console.log(`     resp: ${redact(parsed).slice(0, 700)}`);
    }
    return { status: res.status, body: parsed };
  }

  /** Subscription/feature privileges for this user+vehicle (e.g. remoteLockUnlock). */
  getPrivileges(uuid: string): Promise<any> {
    return this.api(
      `/rrs/v1/privileges/user/${this.getUserId()}/vehicle/${uuid}`,
    );
  }

  /**
   * Mint a per-vehicle S-PIN token (carnetVehicleToken). Confirmed against the
   * matpoulin NA connector:
   *   GET  /ss/v1/user/{userId}/challenge                    -> data.challenge, data.remainingTries
   *   spinHash = sha512(`${challenge}.${spin}`)  (lowercase hex)
   *   POST /ss/v1/user/{userId}/vehicle/{uuid}/session  {idToken, spinHash, tsp:"WCT"}
   *        (authenticated with the id_token, not the access token)
   *   -> data.carnetVehicleToken
   */
  async spinSession(uuid: string, spin: string): Promise<string> {
    const userId = this.getUserId();
    const ch = await this.send("GET", `/ss/v1/user/${userId}/challenge`);
    if (ch.status >= 300)
      throw new Error(
        `challenge failed ${ch.status}: ${JSON.stringify(ch.body)}`,
      );
    const challenge = ch.body?.data?.challenge ?? ch.body?.challenge;
    const remaining = ch.body?.data?.remainingTries;
    if (!challenge)
      throw new Error(`no challenge in response: ${JSON.stringify(ch.body)}`);
    if (typeof remaining === "number" && remaining < 3)
      throw new Error(
        `only ${remaining} S-PIN tries left — refusing to risk a lockout`,
      );

    const spinHash = createHash("sha512")
      .update(`${challenge}.${spin}`, "ascii")
      .digest("hex");
    // Bearer must be the access_token (server: "jtt must be 'access_token'");
    // the id_token travels in the body.
    const sp = await this.send(
      "POST",
      `/ss/v1/user/${userId}/vehicle/${uuid}/session`,
      { idToken: this.tokens?.idToken, spinHash, tsp: "WCT" },
    );
    if (sp.status >= 300)
      throw new Error(
        `spin session failed ${sp.status}: ${JSON.stringify(sp.body)}`,
      );
    const token =
      sp.body?.data?.carnetVehicleToken ?? sp.body?.carnetVehicleToken;
    if (!token)
      throw new Error(`no carnetVehicleToken: ${JSON.stringify(sp.body)}`);
    return token;
  }

  /**
   * Lock/unlock — VERIFIED against the myVW APK and live on the car. The S-PIN
   * carnetVehicleToken IS the Authorization bearer (there is no X-* spin
   * header), and the body is { lock: boolean } — NOT { action }. Mints a fresh
   * S-PIN session each call.
   */
  async lockUnlock(
    action: "lock" | "unlock",
    uuid: string,
    spin: string,
  ): Promise<{ status: number; body: any }> {
    const carnet = await this.spinSession(uuid, spin);
    return this.send(
      "PUT",
      `/lockunlock/v1/vehicle/${uuid}`,
      { lock: action === "lock" },
      { bearer: carnet },
    );
  }
}

// ---- helpers ---------------------------------------------------------------
function mergeUrlParams(url: string): URLSearchParams {
  // kombi:///login may carry the code in the query and/or the #fragment.
  const u = new URL(url);
  const params = new URLSearchParams();
  for (const [k, v] of u.searchParams) params.set(k, v);
  if (u.hash)
    for (const [k, v] of new URLSearchParams(u.hash.slice(1))) params.set(k, v);
  return params;
}

function assertNoTerms(body: string): void {
  if (/terms-and-conditions|termsAndConditions/i.test(body))
    throw new Error(
      "VW wants you to accept new Terms & Conditions — open the myVW app once, accept them, then retry.",
    );
}

function extractHiddenInputs(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of html.match(/<input[^>]*>/gi) ?? []) {
    if (!/type=["']hidden["']/i.test(tag)) continue;
    const name = /name=["']([^"']*)["']/i.exec(tag)?.[1];
    const value = /value=["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
    if (name) out[name] = value;
  }
  return out;
}

function matchOne(s: string, re: RegExp, what: string): string {
  const m = s.match(re);
  const value = m?.[1];
  if (value == null) throw new Error(`could not find ${what} in login page`);
  return value;
}

/** JSON-stringify with secret-ish values masked, for debug logging. */
function redact(value: unknown): string {
  const SECRET = /token|spinhash|password|secret|authorization|challenge/i;
  return JSON.stringify(value, (key, val) =>
    SECRET.test(key) && typeof val === "string" && val.length > 8
      ? `${val.slice(0, 6)}…(${String(val.length)})`
      : val,
  );
}
