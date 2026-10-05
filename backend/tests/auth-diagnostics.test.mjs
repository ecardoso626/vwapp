import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { authDiagnostic, AuthTrace } from "../src/vw/auth-diagnostics.ts";
import { vwGetVehicles, vwLogin, vwMintSpinSession } from "../src/vw/client.ts";
import {
  API,
  html,
  ID_TOKEN,
  IDP,
  json,
  redirect,
  route,
  withFetchQueue,
} from "./harness.mjs";

const { console, Response, ReadableStream } = globalThis;
const secret = "SYNTHETIC-SECRET-NOT-REAL";
const client = "b680e751-7e1f-4008-8ec1-3a528183d215@apps_vw-dilab_com";
const email =
  '<input type="hidden" name="_csrf" value="' +
  secret +
  '"><input type="hidden" name="hmac" value="' +
  secret +
  '">';
const password =
  'csrf_token":"' +
  secret +
  '" "relayState":"' +
  secret +
  '" "hmac":"' +
  secret +
  '"';
const authorize = (response) =>
  route(
    "GET",
    (url) => assert.ok(url.startsWith(API + "/oidc/v1/authorize?")),
    response,
  );
const identifier = (response) =>
  route(
    "POST",
    IDP + "/signin-service/v1/" + client + "/login/identifier",
    response,
  );
const authenticate = (response) =>
  route(
    "POST",
    IDP + "/signin-service/v1/" + client + "/login/authenticate",
    response,
  );
const login = () => vwLogin("synthetic@example.invalid", secret);
async function failure(steps, stage, code, status, run = login) {
  const logs = [];
  const capture = mock.method(console, "info", (...args) => logs.push(args));
  try {
    await withFetchQueue(steps, async () => {
      await assert.rejects(run(), (e) => {
        assert.deepEqual(authDiagnostic(e), { stage, code, status });
        return true;
      });
    });
    const text = JSON.stringify(logs);
    assert.ok(!text.includes(secret));
    assert.ok(!text.includes("synthetic@example.invalid"));
    assert.ok(!text.includes(ID_TOKEN));
    const events = logs.map(([prefix, line]) => {
      assert.equal(prefix, "[vw-auth]");
      return JSON.parse(line);
    });
    assert.equal(events.at(-1).code, code);
    return events;
  } finally {
    capture.mock.restore();
  }
}

test("identifier markup failure records only missing field booleans", async () => {
  const logs = await failure(
    [authorize(html("<form>" + secret + "</form>"))],
    "identifier_form",
    "auth_identifier_form_changed",
    200,
  );
  assert.deepEqual(logs.find((e) => e.event === "elements").fields, {
    csrf: false,
    hmac: false,
  });
});
test("authorize HTTP failure is distinct from a changed form", async () => {
  await failure(
    [authorize(html(secret, 503))],
    "identifier_form",
    "auth_authorize_failed",
    503,
  );
});
test("identifier rejection is distinct from password markup failure", async () => {
  await failure(
    [authorize(html(email)), identifier(html(secret, 403))],
    "password_form",
    "auth_identifier_rejected",
    403,
  );
});
test("password markup failure exposes no hidden values", async () => {
  await failure(
    [authorize(html(email)), identifier(html('csrf_token":"' + secret + '"'))],
    "password_form",
    "auth_password_form_changed",
    200,
  );
});
for (const [name, body, code] of [
  [
    "explicit credential rejection",
    "password_invalid",
    "auth_credentials_rejected",
  ],
  ["unknown non-callback page", "unexpected page", "auth_redirect_failed"],
  [
    "account terms required",
    "termsAndConditions",
    "auth_account_action_required",
  ],
  ["explicit throttle", "login.error.throttled", "auth_throttled"],
])
  test(name + " has a safe distinct category", async () => {
    await failure(
      [
        authorize(html(email)),
        identifier(html(password)),
        authenticate(html(body + secret)),
      ],
      "password",
      code,
      200,
    );
  });
test("HTTP 429 is classified without assuming credential rejection", async () => {
  await failure(
    [authorize(html(secret, 429))],
    "identifier_form",
    "auth_throttled",
    429,
  );
});
test("missing redirect location is classified without logging headers", async () => {
  await failure(
    [
      authorize(
        new Response(null, { status: 302, headers: { "set-cookie": secret } }),
      ),
    ],
    "authorize",
    "auth_redirect_failed",
    302,
  );
});
test("redirect exhaustion preserves the existing 31-request bound", async () => {
  await failure(
    [
      authorize(redirect(IDP + "/" + secret)),
      ...Array.from({ length: 30 }, () =>
        route("GET", IDP + "/" + secret, redirect(IDP + "/" + secret)),
      ),
    ],
    "authorize",
    "auth_redirect_failed",
    302,
  );
});
test("callback without a code logs no callback URL or OAuth state", async () => {
  await failure(
    [authorize(redirect("kombi:///login?state=" + secret))],
    "callback",
    "auth_code_missing",
    302,
  );
});
for (const [name, body, code] of [
  [
    "generic token rejection",
    { error: "INVALID_REQUEST", detail: secret },
    "auth_token_exchange_failed",
  ],
  [
    "explicit attestation rejection",
    { errorCode: "PLAY_INTEGRITY_TOKEN_INVALID", detail: secret },
    "auth_attestation_rejected",
  ],
  [
    "unrecognized attestation prose",
    { error: secret, message: "attestation rejected" },
    "auth_token_exchange_failed",
  ],
])
  test(name + " is conservatively classified", async () => {
    await failure(
      [
        authorize(redirect("kombi:///login?code=" + secret)),
        route("POST", API + "/oidc/v1/token", json(body, 401)),
      ],
      "token_exchange",
      code,
      401,
    );
  });
test("malformed successful token response is a protocol category", async () => {
  await failure(
    [
      authorize(redirect("kombi:///login?code=" + secret)),
      route("POST", API + "/oidc/v1/token", json({ detail: secret })),
    ],
    "token_response",
    "auth_protocol_changed",
    200,
  );
});
test("network failure redacts the original error including URL and secrets", async () => {
  await failure(
    [
      authorize(() => {
        throw new TypeError("https://" + secret + "/ " + secret);
      }),
    ],
    "authorize",
    "auth_network_failed",
    null,
  );
});
test("garage failure remains distinct from credential rejection", async () => {
  await failure(
    [route("GET", API + "/account/v1/garage", json({ detail: secret }, 500))],
    "garage",
    "auth_garage_failed",
    500,
    () => vwGetVehicles(secret),
  );
});
test("S-PIN challenge failure redacts user identity and bearer", async () => {
  await failure(
    [
      route(
        "GET",
        API + "/ss/v1/user/synthetic-user-id/challenge",
        json({ detail: secret }, 403),
      ),
    ],
    "spin_challenge",
    "auth_spin_failed",
    403,
    () =>
      vwMintSpinSession(
        { accessToken: secret, idToken: ID_TOKEN },
        secret,
        "0000",
      ),
  );
});
test("untrusted host/path/query/content-type/error never enter diagnostics", async () => {
  const trace = new AuthTrace("authorize");
  const logs = [];
  const capture = mock.method(console, "info", (...args) => logs.push(args));
  try {
    const url =
      "https://" +
      secret.toLowerCase() +
      ".invalid/" +
      secret +
      "?password=" +
      secret;
    await withFetchQueue(
      [
        route(
          "GET",
          url,
          html(secret, 200, { "content-type": secret, "set-cookie": secret }),
        ),
      ],
      () =>
        trace.fetch(url, {
          headers: { authorization: secret, cookie: secret },
        }),
    );
    trace.failure(new Error(secret));
    assert.ok(
      !JSON.stringify(logs).toLowerCase().includes(secret.toLowerCase()),
    );
    const event = JSON.parse(logs[0][1]);
    assert.equal(event.host, "other");
    assert.equal(event.path, "<redacted>");
    assert.equal(event.contentType, "other");
  } finally {
    capture.mock.restore();
  }
});
test("oversized token error is discarded without changing HTTP failure", async () => {
  await failure(
    [
      authorize(redirect("kombi:///login?code=" + secret)),
      route(
        "POST",
        API + "/oidc/v1/token",
        json({ error: "ATTESTATION_FAILED", padding: "x".repeat(17000) }, 401),
      ),
    ],
    "token_exchange",
    "auth_token_exchange_failed",
    401,
  );
});
test("stalled diagnostic error body is canceled within a bounded wait", async () => {
  let canceled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        canceled = true;
      },
    }),
    { status: 401 },
  );
  await failure(
    [
      authorize(redirect("kombi:///login?code=" + secret)),
      route("POST", API + "/oidc/v1/token", response),
    ],
    "token_exchange",
    "auth_token_exchange_failed",
    401,
  );
  assert.equal(canceled, true);
});
