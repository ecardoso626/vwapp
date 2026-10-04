import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mock, test } from "node:test";
import { URLSearchParams } from "node:url";
import { seal } from "../src/crypto.ts";
import { readStatus } from "../src/status.ts";
import { ensureCarnetToken, ensureTokens } from "../src/tokens.ts";
import {
  ACCESS,
  API,
  CARNET,
  ID_TOKEN,
  json,
  redirect,
  REFRESH,
  route,
  SPIN,
  UUID,
  VIN,
  withFetchQueue,
} from "./harness.mjs";

const KEY = Buffer.alloc(32, 8).toString("base64");
mock.method(Date, "now", () => 1_700_000_000_000);
const env = { CREDS_ENC_KEY: KEY };
const vehicle = { id: "synthetic-row", uuid: UUID, vin: VIN };
const challengeUrl = `${API}/ss/v1/user/synthetic-user-id/challenge`;
const sessionUrl = `${API}/ss/v1/user/synthetic-user-id/vehicle/${UUID}/session`;
const minted = () => [
  route(
    "GET",
    challengeUrl,
    json({ data: { challenge: "synthetic-challenge", remainingTries: 8 } }),
  ),
  route("POST", sessionUrl, json({ data: { carnetVehicleToken: CARNET } })),
];

function dbMock() {
  const writes = [];
  const db = {
    updateTokens: async (_accountId, tokens) => {
      writes.push(tokens);
    },
    saveCarnetToken: async (account, uuid, entry) => {
      writes.push(entry);
      account.carnetTokens[uuid] = entry;
    },
  };
  return { db, writes };
}

async function account(expiresAt = Date.now() + 120_000) {
  return {
    id: "synthetic-account",
    sealed: await seal(
      KEY,
      JSON.stringify({
        username: "nobody@example.invalid",
        password: "synthetic-password",
        spin: SPIN,
      }),
    ),
    tokens: {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      idToken: ID_TOKEN,
      expiresAt,
      codeVerifier: "synthetic-original-verifier",
    },
    carnetTokens: {},
  };
}

test("valid access token and unexpired carnet are reused without network", async () => {
  const { db } = dbMock();
  const a = await account();
  a.carnetTokens[UUID] = { token: CARNET, expiresAt: Date.now() + 180_001 };
  await withFetchQueue([], async () => {
    assert.equal(await ensureTokens(db, env, a), a.tokens);
    assert.equal(await ensureCarnetToken(db, env, a, UUID, SPIN), CARNET);
  });
});

test("expired access token refreshes with verifier and persists new session shape", async () => {
  const { db, writes } = dbMock();
  const a = await account(Date.now());
  const tokens = await withFetchQueue(
    [
      route(
        "POST",
        `${API}/oidc/v1/token`,
        json({ access_token: "synthetic-new-access", expires_in: 3600 }),
        (init) => {
          const form = new URLSearchParams(init.body);
          assert.equal(form.get("grant_type"), "refresh_token");
          assert.equal(
            form.get("code_verifier"),
            "synthetic-original-verifier",
          );
        },
      ),
    ],
    () => ensureTokens(db, env, a),
  );
  assert.equal(tokens.refreshToken, REFRESH);
  assert.equal(writes[0].accessToken, "synthetic-new-access");
  assert.equal(writes[0].refreshToken, REFRESH);
  assert.equal(writes[0].codeVerifier, "synthetic-original-verifier");
});

test("failed refresh falls back to full login; no verifier skips refresh", async () => {
  for (const noVerifier of [false, true]) {
    const { db, writes } = dbMock();
    const a = await account(Date.now());
    if (noVerifier) a.tokens.codeVerifier = null;
    const steps = [
      ...(noVerifier
        ? []
        : [route("POST", `${API}/oidc/v1/token`, json({}, 503))]),
      route(
        "GET",
        (url) => assert.ok(url.startsWith(`${API}/oidc/v1/authorize?`)),
        redirect("kombi:///login?code=synthetic-code"),
      ),
      route(
        "POST",
        `${API}/oidc/v1/token`,
        json({ access_token: "synthetic-relogin-access" }),
      ),
    ];
    const tokens = await withFetchQueue(steps, () => ensureTokens(db, env, a));
    assert.equal(tokens.accessToken, "synthetic-relogin-access");
    assert.equal(tokens.codeVerifier?.length, 128);
    assert.equal(writes.length, 1);
  }
});

test("carnet cache re-mints near three-minute margin, persists token and reuses it", async () => {
  const { db, writes } = dbMock();
  const a = await account();
  a.carnetTokens[UUID] = {
    token: "synthetic-stale-carnet",
    expiresAt: Date.now() + 179_999,
  };
  await withFetchQueue(minted(), async () => {
    assert.equal(await ensureCarnetToken(db, env, a, UUID, SPIN), CARNET);
    assert.equal(await ensureCarnetToken(db, env, a, UUID, SPIN), CARNET);
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].token, CARNET);
});

test("status 401 forces one new carnet and repeats both reads", async () => {
  const { db } = dbMock();
  const a = await account();
  a.carnetTokens[UUID] = {
    token: "synthetic-old-carnet",
    expiresAt: Date.now() + 600_000,
  };
  const status = await withFetchQueue(
    [
      route("GET", `${API}/rvs/v1/vehicle/${UUID}`, json({}, 401)),
      route(
        "GET",
        `${API}/ev/v1/vehicle/${UUID}/charge/summary`,
        json({ data: {} }),
      ),
      ...minted(),
      route(
        "GET",
        `${API}/rvs/v1/vehicle/${UUID}`,
        json({ data: { exteriorStatus: { secure: "SECURE" } } }),
      ),
      route(
        "GET",
        `${API}/ev/v1/vehicle/${UUID}/charge/summary`,
        json({ data: {} }),
      ),
    ],
    () => readStatus(db, env, a, vehicle, SPIN),
  );
  assert.equal(status.locked, true);
});
