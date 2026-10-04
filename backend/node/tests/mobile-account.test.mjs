import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { URL, URLSearchParams } from "node:url";
import { getPublicKey } from "nostr-tools";
import {
  BuzzKeyApiError,
  createBuzzKeyClient,
} from "../../../app/src/buzzkey-client.ts";
import { signNip98 } from "../../../app/src/nip98.ts";
import { DeviceRepository } from "../../auth/devices.ts";
import { seal } from "../../src/crypto.ts";
import { SqliteStorage } from "../../storage/database.ts";
import { SecretRepository } from "../../storage/secrets.ts";
import {
  ACCESS,
  API,
  CARNET,
  html,
  ID_TOKEN,
  IDP,
  json,
  redirect,
  REFRESH,
  route,
  UUID,
  VIN,
  withFetchQueue,
} from "../../tests/harness.mjs";
import { loadNodeConfig } from "../config.ts";
import { createNodeRuntime } from "../runtime.ts";
import { createNodeServices } from "../services.ts";

const origin = "https://buzzkey.example.invalid";
const username = "phase8-synthetic@example.invalid";
const password = "Phase8-SYNTHETIC-password-never-real";
const spin = "876543";
const key = Buffer.alloc(32, 23);
const secret = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const sha256 = async (bytes) => createHash("sha256").update(bytes).digest();
const Response = globalThis.Response;
const garage = () =>
  route(
    "GET",
    `${API}/account/v1/garage`,
    json({
      data: {
        vehicles: [
          { vehicleId: UUID, vin: VIN, vehicleNickName: "Synthetic Buzz" },
        ],
      },
    }),
    (init) => assert.equal(init.headers.authorization, `Bearer ${ACCESS}`),
  );
function loginQueue() {
  const client = "b680e751-7e1f-4008-8ec1-3a528183d215@apps_vw-dilab_com";
  return [
    route(
      "GET",
      (url) => assert.ok(url.startsWith(`${API}/oidc/v1/authorize?`)),
      redirect(`${IDP}/synthetic-email-page`),
    ),
    route(
      "GET",
      `${IDP}/synthetic-email-page`,
      html(
        '<input type="hidden" name="_csrf" value="synthetic-csrf"><input type="hidden" name="hmac" value="synthetic-hmac">',
      ),
    ),
    route(
      "POST",
      `${IDP}/signin-service/v1/${client}/login/identifier`,
      html(
        'csrf_token":"synthetic-pw-csrf" "relayState":"synthetic-relay" "hmac":"synthetic-pw-hmac"',
      ),
      (init) =>
        assert.equal(new URLSearchParams(init.body).get("email"), username),
    ),
    route(
      "POST",
      `${IDP}/signin-service/v1/${client}/login/authenticate`,
      redirect("kombi:///login?code=synthetic-auth-code"),
      (init) =>
        assert.equal(new URLSearchParams(init.body).get("password"), password),
    ),
    route(
      "POST",
      `${API}/oidc/v1/token`,
      json({
        access_token: ACCESS,
        refresh_token: REFRESH,
        id_token: ID_TOKEN,
        expires_in: 3600,
      }),
    ),
    garage(),
  ];
}
function statusQueue(rejected = false) {
  return [
    route(
      "GET",
      `${API}/ss/v1/user/synthetic-user-id/challenge`,
      json({ data: { challenge: "synthetic-challenge", remainingTries: 8 } }),
    ),
    route(
      "POST",
      `${API}/ss/v1/user/synthetic-user-id/vehicle/${UUID}/session`,
      json(rejected ? { data: {} } : { data: { carnetVehicleToken: CARNET } }),
      (init) => {
        const body = JSON.parse(init.body);
        assert.equal(body.spin, undefined);
        assert.equal(String(init.body).includes(spin), false);
      },
    ),
    ...(rejected
      ? []
      : [
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
        ]),
  ];
}
// Surface mock failures even when upstream intentionally catches verification
// or initial telemetry errors. There is no network fallback.
async function offline(steps, run) {
  const failures = [];
  return withFetchQueue(steps, async () => {
    const fetch = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      try {
        return await fetch(...args);
      } catch (error) {
        if (
          error instanceof assert.AssertionError ||
          /Unexpected network request/.test(error.message)
        )
          failures.push(error);
        throw error;
      }
    };
    try {
      const result = await run();
      assert.deepEqual(failures, []);
      return result;
    } finally {
      globalThis.fetch = fetch;
    }
  });
}
function loopback(port) {
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
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "buzzkey-account-"));
  const path = join(dir, "app.sqlite");
  const config = loadNodeConfig(
    {
      NODE_HOST: "127.0.0.1",
      NODE_PORT: "0",
      NODE_PUBLIC_ORIGIN: origin,
      BUZZKEY_SQLITE_PATH: path,
      BUZZKEY_MASTER_KEY_ID: "synthetic",
      BUZZKEY_MASTER_KEY_B64: key.toString("base64"),
    },
    "test",
  );
  let storage, services, runtime, fetcher;
  let nonce = 0;
  const material = {
    secretKey: secret,
    randomBytes: async (count) =>
      Uint8Array.from({ length: count }, (_, i) => (i + ++nonce) % 256),
    sha256,
    nowMs: () => Date.now(),
  };
  const open = async () => {
    storage = SqliteStorage.open(path);
    services = createNodeServices(storage, config);
    runtime = createNodeRuntime(config, services);
    const { port } = await runtime.start();
    fetcher = loopback(port);
  };
  await open();
  let devices = new DeviceRepository(storage);
  const device = devices.pair(
    devices.issuePairing(Date.now()),
    getPublicKey(secret),
    "Synthetic phone",
    Date.now(),
  );
  t.after(async () => {
    await runtime.stop();
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const client = createBuzzKeyClient({
    origin,
    getIdentity: async () => ({
      secretKey: secret,
      pubkey: getPublicKey(secret),
    }),
    ...material,
    fetcher: (...args) => fetcher(...args),
  });
  return {
    client,
    device,
    material,
    dir,
    path,
    get storage() {
      return storage;
    },
    get services() {
      return services;
    },
    get devices() {
      return devices;
    },
    raw: (...args) => fetcher(...args),
    restart: async () => {
      await runtime.stop();
      storage.close();
      await open();
      devices = new DeviceRepository(storage);
    },
    secrets: () => new SecretRepository(storage, "synthetic", key),
  };
}
async function seed(
  f,
  { expiresAt = Date.now() + 3_600_000, includeSpin = true } = {},
) {
  const userKey = createHash("sha256").update(username).digest("hex");
  await f.services.db.saveLogin(
    "owner",
    userKey,
    await seal(
      key.toString("base64"),
      JSON.stringify({ username, password, ...(includeSpin ? { spin } : {}) }),
    ),
    {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      idToken: ID_TOKEN,
      codeVerifier: "synthetic-verifier",
      expiresAt,
    },
    [{ uuid: UUID, vin: VIN, nickname: "Synthetic Buzz", model: null }],
  );
  return (await f.services.db.getUser("owner")).account.id;
}
async function connect(f) {
  const checked = await offline(loginQueue(), () =>
    f.client.submitCredentials(username, password),
  );
  return offline([garage(), ...statusQueue()], () =>
    f.client.connect(checked.pending.attemptId, spin),
  );
}

test("signed mobile credentials and PIN establish encrypted owner/vehicle state; restart and passive reads survive", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.client.account()).state, "unlinked");
  const result = await connect(f);
  assert.equal(result.connection.state, "connected");
  assert.equal(result.connection.session, "usable");
  assert.equal(result.connection.vehicleAvailable, true);
  assert.equal((await f.client.owner()).accountLinked, true);
  const vehicles = await f.client.vehicles();
  assert.equal(vehicles.vehicles[0].identity.reference, UUID);
  assert.equal(vehicles.vehicles[0].identity.vin, VIN);
  assert.equal(
    (await f.client.history(vehicles.vehicles[0].id)).observations.length,
    1,
  );
  const accountId = result.connection.accountId;
  for (const [purpose, value] of [
    ["vw_username", username],
    ["vw_password", password],
    ["vw_spin", spin],
    ["access_token", ACCESS],
    ["refresh_token", REFRESH],
    ["id_token", ID_TOKEN],
    ["carnet_token", CARNET],
  ]) {
    const ref = {
      accountId,
      purpose,
      ...(purpose === "carnet_token" ? { scope: UUID } : {}),
    };
    assert.equal(f.secrets().get(ref).value, value);
    for (const file of [f.path, f.path + "-wal"])
      assert.equal(readFileSync(file).includes(Buffer.from(value)), false);
  }
  const verifier = f
    .secrets()
    .get({ accountId, purpose: "code_verifier" }).value;
  assert.match(verifier, /^[A-F0-9]{128}$/);
  for (const file of [f.path, f.path + "-wal"])
    assert.equal(readFileSync(file).includes(Buffer.from(verifier)), false);
  await f.restart();
  assert.equal((await f.client.account()).state, "connected");
  assert.equal(
    (await f.client.vehicles()).vehicles[0].id,
    vehicles.vehicles[0].id,
  );
});

test("credential check caches session without linking; PIN attempt expires, is device-bound, and reconnect creates a fresh attempt", async (t) => {
  const f = await fixture(t);
  const checked = await offline(loginQueue(), () =>
    f.client.submitCredentials(username, password),
  );
  assert.equal(checked.connection.state, "pin_required");
  assert.equal(checked.connection.linked, false);
  assert.equal(checked.connection.credentialsPresent, true);
  assert.equal(checked.connection.spinPresent, false);
  assert.deepEqual((await f.client.vehicles()).vehicles, []);
  const otherSecret = Uint8Array.from({ length: 32 }, () => 3);
  const other = f.devices.pair(
    f.devices.issuePairing(Date.now()),
    getPublicKey(otherSecret),
    "Other",
    Date.now(),
  );
  const body = JSON.stringify({ attemptId: checked.pending.attemptId, spin });
  const signed = await signNip98({
    url: origin + "/api/v1/account/connect",
    method: "POST",
    body,
    material: { ...f.material, secretKey: otherSecret },
  });
  const denied = await f.raw(origin + "/api/v1/account/connect", {
    method: "POST",
    headers: { authorization: signed.authorization },
    body,
  });
  assert.equal(denied.status, 409);
  assert.ok(other.id);
  f.storage.db
    .prepare("UPDATE owner_vw_connection SET pending_expires_at = 0")
    .run();
  await assert.rejects(
    f.client.connect(checked.pending.attemptId, spin),
    (e) => e.code === "account_action_required",
  );
  const next = await offline([], () => f.client.reconnect());
  assert.equal(next.connection.state, "pin_required");
  assert.notEqual(next.pending.attemptId, checked.pending.attemptId);
});

test("valid stored session is verified and reused with no password login", async (t) => {
  const f = await fixture(t);
  await seed(f);
  const result = await offline([garage(), ...statusQueue()], () =>
    f.client.reconnect(),
  );
  assert.equal(result.connection.state, "connected");
  assert.equal(result.connection.session, "usable");
});

test("expired session refreshes with original verifier before garage and initial telemetry", async (t) => {
  const f = await fixture(t);
  await seed(f, { expiresAt: 0 });
  assert.equal((await f.client.account()).session, "expired");
  const result = await offline(
    [
      route(
        "POST",
        `${API}/oidc/v1/token`,
        json({ access_token: ACCESS, id_token: ID_TOKEN, expires_in: 3600 }),
        (init) => {
          const body = new URLSearchParams(init.body);
          assert.equal(body.get("grant_type"), "refresh_token");
          assert.equal(body.get("refresh_token"), REFRESH);
          assert.equal(body.get("code_verifier"), "synthetic-verifier");
        },
      ),
      garage(),
      ...statusQueue(),
    ],
    () => f.client.reconnect(),
  );
  assert.equal(result.connection.state, "connected");
});

test("rejected garage and refresh fall back once to existing password login", async (t) => {
  const f = await fixture(t);
  await seed(f);
  const result = await offline(
    [
      route("GET", `${API}/account/v1/garage`, json({}, 401)),
      route("POST", `${API}/oidc/v1/token`, json({}, 401)),
      ...loginQueue(),
      ...statusQueue(),
    ],
    () => f.client.reconnect(),
  );
  assert.equal(result.connection.state, "connected");
});

test("changed submitted password does not reuse the old session", async (t) => {
  const f = await fixture(t);
  const accountId = await seed(f);
  f.secrets().put(
    { accountId, purpose: "vw_password" },
    "synthetic-old-password",
  );
  const result = await offline(loginQueue(), () =>
    f.client.submitCredentials(username, password),
  );
  assert.ok(result.pending);
  assert.equal(
    f.secrets().get({ accountId, purpose: "vw_password" }).value,
    password,
  );
});

test("incorrect PIN leaves a linked account with explicit PIN-required state and no telemetry", async (t) => {
  const f = await fixture(t);
  const checked = await offline(loginQueue(), () =>
    f.client.submitCredentials(username, password),
  );
  const result = await offline([garage(), ...statusQueue(true)], () =>
    f.client.connect(checked.pending.attemptId, spin),
  );
  assert.equal(result.connection.state, "pin_required");
  assert.equal(result.connection.lastFailure, "status_read_failed");
  assert.ok(result.pending);
  assert.equal(
    (await f.client.history((await f.client.vehicles()).vehicles[0].id))
      .observations.length,
    0,
  );
});

test("disconnect keeps secrets/history/pairing and explicit reconnect reuses session", async (t) => {
  const f = await fixture(t);
  const initial = await connect(f);
  const id = (await f.client.vehicles()).vehicles[0].id;
  const result = await offline([], () => f.client.disconnect());
  assert.equal(result.connection.state, "disconnected");
  assert.equal(result.connection.linked, false);
  assert.equal(result.connection.reconnectAvailable, true);
  assert.equal((await f.client.owner()).accountLinked, false);
  assert.deepEqual((await f.client.vehicles()).vehicles, []);
  assert.equal(f.devices.getByPubkey(getPublicKey(secret)).revokedAt, null);
  assert.equal(
    f
      .secrets()
      .get({ accountId: initial.connection.accountId, purpose: "vw_spin" })
      .value,
    spin,
  );
  assert.equal(
    f.storage.db.prepare("SELECT COUNT(*) AS n FROM vehicle_observations").get()
      .n,
    1,
  );
  await f.restart();
  assert.equal((await f.client.account()).state, "disconnected");
  // Stored carnet is reused, so only the garage and two status reads occur.
  const result2 = await offline([garage(), ...statusQueue().slice(2)], () =>
    f.client.reconnect(),
  );
  assert.equal(result2.connection.linked, true);
  // Identical status is deduplicated by the existing persistence policy.
  assert.equal((await f.client.history(id)).observations.length, 1);
});

test("missing credentials and missing access token have explicit recovery semantics", async (t) => {
  const f = await fixture(t);
  const id = await seed(f);
  f.secrets().delete({ accountId: id, purpose: "vw_password" });
  assert.equal((await f.client.account()).state, "credentials_missing");
  await offline([], () =>
    assert.rejects(
      f.client.reconnect(),
      (e) => e.code === "account_action_required",
    ),
  );
  f.secrets().put({ accountId: id, purpose: "vw_password" }, password);
  f.secrets().delete({ accountId: id, purpose: "access_token" });
  assert.equal((await f.client.account()).session, "missing");
  const result = await offline([...loginQueue(), ...statusQueue()], () =>
    f.client.reconnect(),
  );
  assert.equal(result.connection.state, "connected");
});

test("failed login and upstream errors never echo credentials or token material in logs/responses", async (t) => {
  const f = await fixture(t);
  const logs = [];
  const log = mock.method(globalThis.console, "log", (...args) =>
    logs.push(args.join(" ")),
  );
  const error = mock.method(globalThis.console, "error", (...args) =>
    logs.push(args.join(" ")),
  );
  t.after(() => {
    log.mock.restore();
    error.mock.restore();
  });
  const leaked = [
    username,
    password,
    spin,
    ACCESS,
    REFRESH,
    ID_TOKEN,
    CARNET,
  ].join(" ");
  await offline(
    [
      route(
        "GET",
        (url) => assert.ok(url.startsWith(`${API}/oidc/v1/authorize?`)),
        html(leaked, 401),
      ),
    ],
    () =>
      assert.rejects(
        f.client.submitCredentials(username, password),
        (e) =>
          e instanceof BuzzKeyApiError &&
          e.code === "account_authentication_failed" &&
          !e.message.includes(password),
      ),
  );
  assert.equal((await f.client.account()).state, "reauthentication_required");
  await offline(
    [
      route(
        "GET",
        (url) => assert.ok(url.startsWith(`${API}/oidc/v1/authorize?`)),
        () => {
          throw new Error(leaked);
        },
      ),
    ],
    () =>
      assert.rejects(
        f.client.submitCredentials(username, password),
        (e) => e.code === "server_error",
      ),
  );
  const path = "/api/v1/account/credentials";
  const body = JSON.stringify({ username, password });
  const signed = await signNip98({
    url: origin + path,
    method: "POST",
    body,
    material: f.material,
  });
  await offline(
    [
      route(
        "GET",
        (url) => assert.ok(url.startsWith(`${API}/oidc/v1/authorize?`)),
        html(leaked, 401),
      ),
    ],
    async () => {
      const response = await f.raw(origin + path, {
        method: "POST",
        headers: { authorization: signed.authorization },
        body,
      });
      assert.equal(response.status, 422);
      assert.deepEqual(await response.json(), {
        error: "account_authentication_failed",
      });
    },
  );
  for (const secret of [
    username,
    password,
    spin,
    ACCESS,
    REFRESH,
    ID_TOKEN,
    CARNET,
  ])
    assert.equal(logs.join("\n").includes(secret), false);
});

test("anonymous/revoked/replayed credential submissions are rejected before any VW traffic", async (t) => {
  const f = await fixture(t);
  const path = "/api/v1/account/credentials";
  const body = JSON.stringify({ username, password });
  await offline([], async () => {
    assert.equal(
      (await f.raw(origin + path, { method: "POST", body })).status,
      401,
    );
  });
  const signed = await signNip98({
    url: origin + path,
    method: "POST",
    body,
    material: f.material,
  });
  await offline(loginQueue(), async () =>
    assert.equal(
      (
        await f.raw(origin + path, {
          method: "POST",
          headers: { authorization: signed.authorization },
          body,
        })
      ).status,
      200,
    ),
  );
  await offline([], async () =>
    assert.equal(
      (
        await f.raw(origin + path, {
          method: "POST",
          headers: { authorization: signed.authorization },
          body,
        })
      ).status,
      401,
    ),
  );
  f.devices.revoke(f.device.id, Date.now());
  await offline([], () =>
    assert.rejects(
      f.client.submitCredentials(username, password),
      (e) => e.code === "authorization_rejected",
    ),
  );
});

test("signed credential URL/method/body tampering fails and query credentials are rejected", async (t) => {
  const f = await fixture(t);
  const path = "/api/v1/account/credentials";
  const body = JSON.stringify({ username, password });
  for (const changed of [
    { path, method: "PUT", body },
    { path: path + "?x=1", method: "POST", body },
    { path, method: "POST", body: body + " " },
  ]) {
    const signed = await signNip98({
      url: origin + path,
      method: "POST",
      body,
      material: f.material,
    });
    await offline([], async () =>
      assert.equal(
        (
          await f.raw(origin + changed.path, {
            method: changed.method,
            headers: { authorization: signed.authorization },
            body: changed.body,
          })
        ).status,
        401,
      ),
    );
  }
  const query = path + "?username=synthetic";
  const signed = await signNip98({
    url: origin + query,
    method: "POST",
    body,
    material: f.material,
  });
  await offline([], async () =>
    assert.equal(
      (
        await f.raw(origin + query, {
          method: "POST",
          headers: { authorization: signed.authorization },
          body,
        })
      ).status,
      400,
    ),
  );
});

test("retired RPC account paths remain unavailable while health is public", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.raw(origin + "/health")).status, 200);
  for (const path of [
    "/rpc/auth/login",
    "/rpc/auth/checkCredentials",
    "/rpc/auth/logout",
    "/rpc/auth/login/",
    "/rpc/%61uth/%6cogin",
  ]) {
    const body = "{}";
    const signed = await signNip98({
      url: origin + path,
      method: "POST",
      body,
      material: f.material,
    });
    await offline([], async () =>
      assert.equal(
        (
          await f.raw(origin + path, {
            method: "POST",
            headers: { authorization: signed.authorization },
            body,
          })
        ).status,
        404,
      ),
    );
  }
});

test("failed explicit reconnect reports reauthentication required while preserving the account link and secrets", async (t) => {
  const f = await fixture(t);
  const id = await seed(f, { expiresAt: 0 });
  await offline(
    [
      route("POST", `${API}/oidc/v1/token`, json({}, 401)),
      route(
        "GET",
        (url) => assert.ok(url.startsWith(`${API}/oidc/v1/authorize?`)),
        html("synthetic rejected", 401),
      ),
    ],
    () =>
      assert.rejects(
        f.client.reconnect(),
        (error) => error.code === "account_authentication_failed",
      ),
  );
  const state = await f.client.account();
  assert.equal(state.state, "reauthentication_required");
  assert.equal(state.linked, true);
  assert.equal(state.session, "unusable");
  assert.equal(
    f.secrets().get({ accountId: id, purpose: "vw_password" }).value,
    password,
  );
});

test("concurrent account mutations fail busy without duplicating VW authentication", async (t) => {
  const f = await fixture(t);
  let release, entered;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const steps = loginQueue();
  const original = steps[0].response;
  steps[0].response = async () => {
    entered();
    await blocked;
    return original;
  };
  await offline(steps, async () => {
    const first = f.client.submitCredentials(username, password);
    await waiting;
    try {
      await assert.rejects(
        f.client.disconnect(),
        (error) => error.code === "account_action_required",
      );
    } finally {
      release();
    }
    await first;
  });
});

test("credential mutations retain the NIP-98 per-device request limit before VW access", async (t) => {
  const f = await fixture(t);
  await offline([], async () => {
    for (let i = 0; i < 10; i++) await f.client.disconnect();
    await assert.rejects(
      f.client.submitCredentials(username, password),
      (error) => error.code === "rate_limited",
    );
    await setImmediate();
  });
});
