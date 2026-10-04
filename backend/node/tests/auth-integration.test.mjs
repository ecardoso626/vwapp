import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { request } from "node:http";
import { test } from "node:test";
import { DeviceRepository } from "../../auth/devices.ts";
import { DeviceAuthService } from "../../auth/service.ts";
import {
  nowMs,
  origin,
  pairingRequest,
  pubkeyA,
  signedRequest,
} from "../../auth/tests/helper.mjs";
import { seal } from "../../src/crypto.ts";
import { SqliteStorage } from "../../storage/database.ts";
import { SecretRepository } from "../../storage/secrets.ts";
import { loadNodeConfig } from "../config.ts";
import { createNodeRuntime } from "../runtime.ts";
import { NodeSqliteStore } from "../sqlite-store.ts";

const target = "/rpc/vehicle/parkedMapUrl";
const rpcBody = Buffer.from(
  JSON.stringify({
    json: { lat: 41, lng: -87, widthPt: 300, heightPt: 200, dark: false },
  }),
);
const env = {
  NODE_HOST: "127.0.0.1",
  NODE_PORT: "0",
  NODE_PUBLIC_ORIGIN: origin,
  BUZZKEY_SQLITE_PATH: ":memory:",
  BUZZKEY_MASTER_KEY_ID: "synthetic-key",
  BUZZKEY_MASTER_KEY_B64: Buffer.alloc(32, 7).toString("base64"),
};

function send(
  port,
  path,
  { method = "GET", body, authorization, guestToken } = {},
) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(authorization === undefined ? {} : { authorization }),
          ...(guestToken === undefined
            ? {}
            : { "x-instant-token": guestToken }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function setup(t, pair = true) {
  const storage = SqliteStorage.open(":memory:");
  const devices = new DeviceRepository(storage);
  const paired = pair
    ? devices.pair(
        devices.issuePairing(nowMs),
        pubkeyA,
        "Synthetic iPhone",
        nowMs,
      )
    : null;
  const key = Buffer.alloc(32, 7);
  const db = new NodeSqliteStore(
    storage,
    new SecretRepository(storage, "synthetic-key", key),
    key.toString("base64"),
  );
  const runtime = createNodeRuntime(loadNodeConfig(env, "test"), {
    auth: new DeviceAuthService(devices, origin, () => nowMs),
    db,
    poll: () => Promise.resolve(),
    climate: () => Promise.resolve(),
  });
  const { port } = await runtime.start();
  t.after(async () => {
    await runtime.stop();
    storage.close();
  });
  return { port, devices, paired, db };
}

test("Node starts without InstantDB configuration and resolves the owner account from SQLite", async (t) => {
  assert.equal("INSTANT_APP_ID" in env, false);
  assert.equal("INSTANT_ADMIN_TOKEN" in env, false);
  const server = await setup(t);
  const target = "/rpc/auth/me";
  const call = async () => {
    const authorization = signedRequest({ method: "POST", target }).request
      .authorization;
    return send(server.port, target, { method: "POST", authorization });
  };
  const before = await call();
  assert.equal(before.status, 200, before.body);
  assert.deepEqual(JSON.parse(before.body), { json: { loggedIn: false } });
  const sealed = await seal(
    env.BUZZKEY_MASTER_KEY_B64,
    JSON.stringify({
      username: "synthetic@example.invalid",
      password: "synthetic-password",
      spin: "1234",
    }),
  );
  await server.db.saveLogin(
    "owner",
    "synthetic-user-key",
    sealed,
    {
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
      idToken: null,
      codeVerifier: "synthetic-verifier",
      expiresAt: 1_900_000_000_000,
    },
    [
      {
        vin: "TESTVIN0000000000",
        uuid: "synthetic-vw-reference",
        nickname: null,
        model: "ID. Buzz",
      },
    ],
  );
  const after = await call();
  assert.equal(after.status, 200, after.body);
  assert.deepEqual(JSON.parse(after.body), { json: { loggedIn: true } });
});

test("health is public while anonymous and guest-token-only RPC are rejected", async (t) => {
  const server = await setup(t);
  assert.equal((await send(server.port, "/health")).status, 200);
  assert.equal(
    (await send(server.port, target, { method: "POST", body: rpcBody })).status,
    401,
  );
  assert.equal(
    (
      await send(server.port, target, {
        method: "POST",
        body: rpcBody,
        guestToken: "synthetic-guest-token",
      })
    ).status,
    401,
  );
});

test("signed authorized-device RPC succeeds, then the same event is rejected", async (t) => {
  const server = await setup(t);
  const authorization = signedRequest({
    method: "POST",
    target,
    body: rpcBody,
  }).request.authorization;
  const input = {
    method: "POST",
    body: rpcBody,
    authorization,
  };
  const accepted = await send(server.port, target, input);
  assert.equal(accepted.status, 200, accepted.body);
  assert.deepEqual(JSON.parse(accepted.body), { json: { url: null } });
  assert.equal((await send(server.port, target, input)).status, 401);
});

test("revoked device cannot reach RPC", async (t) => {
  const server = await setup(t);
  assert.ok(server.paired);
  assert.equal(server.devices.revoke(server.paired.id, nowMs), true);
  const authorization = signedRequest({ method: "POST", target, body: rpcBody })
    .request.authorization;
  assert.equal(
    (
      await send(server.port, target, {
        method: "POST",
        body: rpcBody,
        authorization,
      })
    ).status,
    401,
  );
});

test("URL, method, and raw body tampering fail before application logic", async (t) => {
  const server = await setup(t);
  const authorization = signedRequest({ method: "POST", target, body: rpcBody })
    .request.authorization;
  assert.equal(
    (
      await send(server.port, target + "?x=1", {
        method: "POST",
        body: rpcBody,
        authorization,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await send(server.port, target, {
        method: "GET",
        authorization,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await send(server.port, target, {
        method: "POST",
        body: Buffer.from(
          rpcBody.toString().replace('"dark":false', '"dark":true'),
        ),
        authorization,
      })
    ).status,
    401,
  );
});

test("pairing requires a one-time local token and candidate-key signature", async (t) => {
  const server = await setup(t, false);
  const token = server.devices.issuePairing(nowMs);
  const candidate = pairingRequest(token);
  const accepted = await send(server.port, "/auth/pair", {
    method: "POST",
    body: candidate.body,
    authorization: candidate.authorization,
  });
  assert.equal(accepted.status, 201, accepted.body);
  assert.equal(JSON.parse(accepted.body).device.pubkey, pubkeyA);
  assert.doesNotMatch(accepted.body, new RegExp(token));
  assert.equal(
    (
      await send(server.port, "/auth/pair", {
        method: "POST",
        body: candidate.body,
        authorization: candidate.authorization,
      })
    ).status,
    401,
  );
});
