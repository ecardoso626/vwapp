import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { test } from "node:test";
import { URL } from "node:url";
import {
  BuzzKeyApiError,
  createBuzzKeyClient,
} from "../../../app/src/buzzkey-client.ts";
import { loadOrCreateDeviceIdentity } from "../../../app/src/device-identity.ts";
import { signNip98 } from "../../../app/src/nip98.ts";
import { DeviceRepository } from "../../auth/devices.ts";
import { verifyNip98 } from "../../auth/nip98.ts";
import { seal } from "../../src/crypto.ts";
import { SqliteStorage } from "../../storage/database.ts";
import { loadNodeConfig } from "../config.ts";
import { createNodeRuntime } from "../runtime.ts";
import { createNodeServices } from "../services.ts";

const origin = "https://buzzkey.test";
const Response = globalThis.Response;
const now = 1_700_000_000_000;
const key = Buffer.alloc(32, 7);
const secret = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const randomBytes = async (count) =>
  Uint8Array.from({ length: count }, (_, i) => i + 2);
const sha256 = async (bytes) => createHash("sha256").update(bytes).digest();
const material = { secretKey: secret, randomBytes, sha256, nowMs: () => now };

function memoryStore() {
  let value = null;
  return {
    get: async () => value,
    set: async (next) => {
      value = next;
    },
    readOrdinaryStorage: () => null,
    corrupt: (next) => {
      value = next;
    },
  };
}

test("dedicated device key is generated once, reloaded, and malformed secure storage fails closed", async () => {
  const store = memoryStore();
  const first = await loadOrCreateDeviceIdentity(store, async () => secret);
  const second = await loadOrCreateDeviceIdentity(store, async () => {
    throw new Error("must reuse");
  });
  assert.equal(first.pubkey, second.pubkey);
  assert.deepEqual(first.secretKey, second.secretKey);
  assert.equal(store.readOrdinaryStorage(), null);
  store.corrupt("not-a-secret-key");
  await assert.rejects(
    loadOrCreateDeviceIdentity(store, randomBytes),
    /invalid/,
  );
  store.corrupt("00".repeat(32));
  await assert.rejects(
    loadOrCreateDeviceIdentity(store, randomBytes),
    /invalid/,
  );
});

test("GET and POST NIP-98 signatures bind exact external URL, method, body and timestamp", async () => {
  const get = await signNip98({
    url: `${origin}/api/v1/vehicles?x=%2F&x=1`,
    method: "GET",
    material,
  });
  assert.equal(get.event.created_at, now / 1000);
  assert.equal(
    get.event.tags.some((tag) => tag[0] === "payload"),
    false,
  );
  assert.equal(
    verifyNip98({
      authorization: get.authorization,
      method: "GET",
      rawTarget: "/api/v1/vehicles?x=%2F&x=1",
      body: Buffer.alloc(0),
      publicOrigin: origin,
      nowMs: now,
    }).pubkey,
    get.event.pubkey,
  );
  assert.throws(
    () =>
      verifyNip98({
        authorization: get.authorization,
        method: "GET",
        rawTarget: "/api/v1/vehicles?x=/&x=1",
        body: Buffer.alloc(0),
        publicOrigin: origin,
        nowMs: now,
      }),
    /url_mismatch|AuthFailure/,
  );
  const body = JSON.stringify({ title: "Synthetic 🚌" });
  const post = await signNip98({
    url: `${origin}/auth/pair`,
    method: "POST",
    body,
    material,
  });
  assert.equal(
    post.event.tags.find((tag) => tag[0] === "payload")?.[1],
    createHash("sha256").update(body).digest("hex"),
  );
  verifyNip98({
    authorization: post.authorization,
    method: "POST",
    rawTarget: "/auth/pair",
    body: Buffer.from(body),
    publicOrigin: origin,
    nowMs: now,
  });
  for (const changed of [
    { method: "PUT", rawTarget: "/auth/pair", body: Buffer.from(body) },
    { method: "POST", rawTarget: "/auth/pair?x=1", body: Buffer.from(body) },
    { method: "POST", rawTarget: "/auth/pair", body: Buffer.from(body + " ") },
  ])
    assert.throws(() =>
      verifyNip98({
        authorization: post.authorization,
        ...changed,
        publicOrigin: origin,
        nowMs: now,
      }),
    );
});

function loopbackFetcher(port) {
  return (url, options = {}) =>
    new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: parsed.pathname + parsed.search,
          method: options.method ?? "GET",
          headers: options.headers,
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode,
                headers: res.headers,
              }),
            ),
          );
        },
      );
      req.on("error", reject);
      if (options.body !== undefined) req.write(options.body);
      req.end();
    });
}

test("mobile pairing and passive reads use real Node verifier and SQLite without VW or InstantDB", async (t) => {
  const storage = SqliteStorage.open(":memory:");
  const config = loadNodeConfig(
    {
      NODE_HOST: "127.0.0.1",
      NODE_PORT: "0",
      NODE_PUBLIC_ORIGIN: origin,
      BUZZKEY_SQLITE_PATH: ":memory:",
      BUZZKEY_MASTER_KEY_ID: "synthetic-key",
      BUZZKEY_MASTER_KEY_B64: key.toString("base64"),
    },
    "test",
  );
  const services = createNodeServices(storage, config);
  const devices = new DeviceRepository(storage);
  const runtime = createNodeRuntime(config, services);
  const { port } = await runtime.start();
  t.after(async () => {
    await runtime.stop();
    storage.close();
  });
  let nonce = 0;
  const client = createBuzzKeyClient({
    origin,
    getIdentity: async () => ({
      secretKey: secret,
      pubkey: (
        await loadOrCreateDeviceIdentity(memoryStore(), async () => secret)
      ).pubkey,
    }),
    randomBytes: async (count) =>
      Uint8Array.from({ length: count }, (_, i) => (i + ++nonce) % 256),
    sha256,
    nowMs: () => Date.now(),
    fetcher: loopbackFetcher(port),
  });
  await assert.rejects(
    client.owner(),
    (error) =>
      error instanceof BuzzKeyApiError &&
      error.code === "authorization_rejected",
  );
  const expired = devices.issuePairing(Date.now() - 10_000, 1);
  await assert.rejects(
    client.pair(expired, "Synthetic phone"),
    (error) =>
      error instanceof BuzzKeyApiError &&
      error.code === "authorization_rejected",
  );
  const token = devices.issuePairing(Date.now());
  const paired = await client.pair(token, "Synthetic phone");
  assert.equal(paired.device.name, "Synthetic phone");
  const owner = await client.owner();
  assert.equal(owner.accountLinked, false);
  assert.equal(owner.vehicleAvailable, false);
  assert.deepEqual((await client.vehicles()).vehicles, []);

  const sealed = await seal(
    key.toString("base64"),
    JSON.stringify({
      username: "synthetic@example.invalid",
      password: "synthetic-password",
      spin: "1234",
    }),
  );
  const [vehicle] = await services.db.saveLogin(
    "owner",
    "synthetic-user",
    sealed,
    {
      accessToken: "synthetic-access",
      refreshToken: null,
      idToken: null,
      codeVerifier: null,
      expiresAt: Date.now() + 100_000,
    },
    [
      {
        vin: "TESTVIN0000000000",
        uuid: "synthetic-vw-reference",
        nickname: "Test Buzz",
        model: "ID. Buzz",
      },
    ],
  );
  assert.ok(vehicle);
  const status = {
    vin: vehicle.vin,
    soc: 73,
    chargeState: "chargingHVBattery",
    chargePowerKw: 5,
    minutesToFull: 42,
    pluggedIn: true,
    plugLocked: true,
    targetSoc: 80,
    locked: false,
    openDoors: [],
    openWindows: [],
    unlockedDoors: [],
    rangeKm: 200,
    odometerKm: 12000,
    parkedLat: null,
    parkedLng: null,
    parkedAt: null,
    capturedAt: now,
    rvsUpdatedAt: now,
    doorsUpdatedAt: now,
    locksUpdatedAt: now,
    windowsUpdatedAt: now,
    chargeUpdatedAt: now,
  };
  await services.db.saveSnapshot(vehicle.id, status);
  await services.db.syncMessages(
    (await services.db.getUser("owner")).account.id,
    [
      {
        id: "synthetic-message",
        title: "Hello",
        body: null,
        at: now,
        read: false,
      },
    ],
    true,
  );
  assert.equal((await client.owner()).accountLinked, true);
  const vehicles = await client.vehicles();
  assert.equal(vehicles.vehicles[0].current.state.battery.socPercent, 73);
  assert.equal(vehicles.vehicles[0].current.state.security.lock, "unknown");
  assert.equal((await client.current(vehicle.id)).current.revision, 1);
  assert.equal((await client.history(vehicle.id)).observations.length, 1);
  assert.equal((await client.messages()).messages[0].read, false);
  await client.setMessageRead("synthetic-message", true);
  assert.equal((await client.messages()).messages[0].readOverride, true);
  await client.setMessageDeleted("synthetic-message", true);
  assert.notEqual((await client.messages()).messages[0].deletedAt, null);
  devices.revoke(paired.device.id, Date.now());
  await assert.rejects(
    client.owner(),
    (error) =>
      error instanceof BuzzKeyApiError &&
      error.code === "authorization_rejected",
  );
});

test("mobile client reports backend unavailable and invalid response without fallback", async () => {
  const base = {
    origin,
    getIdentity: async () => ({ secretKey: secret, pubkey: "synthetic" }),
    randomBytes,
    sha256,
    nowMs: () => now,
  };
  const unreachable = createBuzzKeyClient({
    ...base,
    fetcher: async () => {
      throw new Error("offline");
    },
  });
  await assert.rejects(
    unreachable.owner(),
    (error) =>
      error instanceof BuzzKeyApiError && error.code === "backend_unreachable",
  );
  const invalid = createBuzzKeyClient({
    ...base,
    fetcher: async () => new Response("{}", { status: 200 }),
  });
  await assert.rejects(
    invalid.owner(),
    (error) =>
      error instanceof BuzzKeyApiError && error.code === "invalid_response",
  );
});
