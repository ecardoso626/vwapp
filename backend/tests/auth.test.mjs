import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock, test } from "node:test";
import { URL, URLSearchParams } from "node:url";
import { VwAuthError, vwLogin, vwRefresh } from "../src/vw/client.ts";
import {
  ACCESS,
  API,
  html,
  IDP,
  json,
  redirect,
  REFRESH,
  route,
  withFetchQueue,
} from "./harness.mjs";

const USERNAME = "nobody@example.invalid";
const PASSWORD = "synthetic-password-DO-NOT-USE";
const DEVICE_CLIENT = "59992128-69a9-42c3-8621-7942041ba824_MYVW_ANDROID";
const IDP_CLIENT = "b680e751-7e1f-4008-8ec1-3a528183d215@apps_vw-dilab_com";

test("OAuth login preserves public client, redirect, cookies, form fields, PKCE and token shape", async () => {
  const fixedNow = 1_700_000_000_000;
  const now = mock.method(Date, "now", () => fixedNow);
  const random = mock.method(globalThis.crypto, "getRandomValues", (bytes) => {
    bytes.fill(0xab);
    return bytes;
  });
  try {
    const verifier = "AB".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authUrl = new URL(`${API}/oidc/v1/authorize`);
    authUrl.search = new URLSearchParams({
      redirect_uri: "kombi:///login",
      scope: "openid",
      prompt: "login",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "ab".repeat(16),
      response_type: "code",
      client_id: DEVICE_CLIENT,
    }).toString();
    const emailUrl = `${IDP}/synthetic-email-page`;
    const steps = [
      route(
        "GET",
        authUrl.toString(),
        redirect(emailUrl, {
          "set-cookie": "session=synthetic-cookie; Path=/; Secure",
        }),
        (init) => {
          assert.equal(init.redirect, "manual");
          assert.equal(
            init.headers["x-requested-with"],
            "com.volkswagen.weconnect",
          );
          assert.match(init.headers["user-agent"], /Android/);
        },
      ),
      route(
        "GET",
        emailUrl,
        html(
          '<input type="hidden" name="_csrf" value="synthetic-csrf"><input type="hidden" name="hmac" value="synthetic-hmac">',
        ),
        (init) => {
          assert.equal(init.headers.cookie, undefined); // host-only cookie from API must not cross to IDP
        },
      ),
      route(
        "POST",
        `${IDP}/signin-service/v1/${IDP_CLIENT}/login/identifier`,
        html(
          'csrf_token":"synthetic-pw-csrf" "relayState":"synthetic-relay" "hmac":"synthetic-pw-hmac"',
        ),
        (init) => {
          const form = new URLSearchParams(init.body);
          assert.equal(form.get("email"), USERNAME);
          assert.equal(form.get("_csrf"), "synthetic-csrf");
          assert.equal(form.get("hmac"), "synthetic-hmac");
        },
      ),
      route(
        "POST",
        `${IDP}/signin-service/v1/${IDP_CLIENT}/login/authenticate`,
        redirect("kombi:///login?code=synthetic-auth-code"),
        (init) => {
          const form = new URLSearchParams(init.body);
          assert.equal(form.get("password"), PASSWORD);
          assert.equal(form.get("_csrf"), "synthetic-pw-csrf");
          assert.equal(form.get("relayState"), "synthetic-relay");
        },
      ),
      route(
        "POST",
        `${API}/oidc/v1/token`,
        json({
          access_token: ACCESS,
          refresh_token: REFRESH,
          id_token: "synthetic-id",
          expires_in: 600,
        }),
        (init) => {
          const form = new URLSearchParams(init.body);
          assert.equal(form.get("grant_type"), "authorization_code");
          assert.equal(form.get("client_id"), DEVICE_CLIENT);
          assert.equal(form.get("redirect_uri"), "kombi:///login");
          assert.equal(form.get("code"), "synthetic-auth-code");
          assert.equal(form.get("code_verifier"), verifier);
          assert.equal(form.get("play_integrity_token"), "unavailable");
        },
      ),
    ];
    const tokens = await withFetchQueue(steps, () =>
      vwLogin(USERNAME, PASSWORD),
    );
    assert.deepEqual(tokens, {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      idToken: "synthetic-id",
      expiresAt: fixedNow + 600_000,
      codeVerifier: verifier,
    });
  } finally {
    random.mock.restore();
    now.mock.restore();
  }
});

test("refresh preserves old refresh token if replacement is absent and replays original verifier", async () => {
  const steps = [
    route(
      "POST",
      `${API}/oidc/v1/token`,
      json({ access_token: "synthetic-new-access", expires_in: 30 }),
      (init) => {
        const form = new URLSearchParams(init.body);
        assert.equal(form.get("grant_type"), "refresh_token");
        assert.equal(form.get("refresh_token"), REFRESH);
        assert.equal(form.get("code_verifier"), "synthetic-original-verifier");
        assert.equal(form.get("play_integrity_token"), "unavailable");
      },
    ),
  ];
  const before = Date.now();
  const tokens = await withFetchQueue(steps, () =>
    vwRefresh(REFRESH, "synthetic-original-verifier"),
  );
  assert.equal(tokens.refreshToken, REFRESH);
  assert.equal(tokens.codeVerifier, "synthetic-original-verifier");
  assert.ok(tokens.expiresAt >= before + 30_000);
});

test("token failure and changed login markup produce typed errors", async () => {
  await assert.rejects(
    withFetchQueue(
      [
        route(
          "POST",
          `${API}/oidc/v1/token`,
          json({ error: "synthetic" }, 401),
        ),
      ],
      () => vwRefresh(REFRESH, "synthetic-verifier"),
    ),
    VwAuthError,
  );
  await assert.rejects(
    withFetchQueue(
      [
        route(
          "GET",
          (url) => assert.ok(url.startsWith(`${API}/oidc/v1/authorize?`)),
          redirect(`${IDP}/synthetic-email-page`),
        ),
        route(
          "GET",
          `${IDP}/synthetic-email-page`,
          html("<html>changed synthetic markup</html>"),
        ),
      ],
      () => vwLogin(USERNAME, PASSWORD),
    ),
    /could not parse VW email login form/,
  );
});

test("unclaimed fetch cannot reach a network adapter", async () => {
  await assert.rejects(
    globalThis.fetch("https://example.invalid/synthetic-probe"),
    /Unexpected network request/,
  );
});
