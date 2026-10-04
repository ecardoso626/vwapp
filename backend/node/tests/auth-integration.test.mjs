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
import { SqliteStorage } from "../../storage/database.ts";
import { loadNodeConfig } from "../config.ts";
import { createNodeRuntime } from "../runtime.ts";

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
  INSTANT_APP_ID: "synthetic-instant-app",
  INSTANT_ADMIN_TOKEN: "synthetic-admin-token",
  CREDS_ENC_KEY: Buffer.alloc(32, 7).toString("base64"),
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
  let verifications = 0;
  const runtime = createNodeRuntime(loadNodeConfig(env, "test"), {
    auth: new DeviceAuthService(devices, origin, () => nowMs),
    db: {
      auth: {
        async verifyToken(token) {
          verifications++;
          if (token !== "synthetic-guest-token") throw new Error("invalid");
          return { id: "synthetic-user" };
        },
      },
    },
    poll: () => Promise.resolve(),
    climate: () => Promise.resolve(),
  });
  const { port } = await runtime.start();
  t.after(async () => {
    await runtime.stop();
    storage.close();
  });
  return {
    port,
    devices,
    paired,
    get verifications() {
      return verifications;
    },
  };
}

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
  assert.equal(server.verifications, 0);
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
    guestToken: "synthetic-guest-token",
  };
  const accepted = await send(server.port, target, input);
  assert.equal(accepted.status, 200, accepted.body);
  assert.deepEqual(JSON.parse(accepted.body), { json: { url: null } });
  assert.equal((await send(server.port, target, input)).status, 401);
  assert.equal(server.verifications, 1);
});

test("revoked device cannot reach RPC or InstantDB token verification", async (t) => {
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
        guestToken: "synthetic-guest-token",
      })
    ).status,
    401,
  );
  assert.equal(server.verifications, 0);
});

test("URL, method, and raw body tampering fail before application logic", async (t) => {
  const server = await setup(t);
  const authorization = signedRequest({ method: "POST", target, body: rpcBody })
    .request.authorization;
  const guestToken = "synthetic-guest-token";
  assert.equal(
    (
      await send(server.port, target + "?x=1", {
        method: "POST",
        body: rpcBody,
        authorization,
        guestToken,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await send(server.port, target, {
        method: "GET",
        authorization,
        guestToken,
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
        guestToken,
      })
    ).status,
    401,
  );
  assert.equal(server.verifications, 0);
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
  assert.equal(server.verifications, 0);
});
