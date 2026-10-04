import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { URL } from "node:url";
import { seal, unseal } from "../../src/crypto.ts";
import { pollAllVehicles } from "../../src/poll.ts";
import { SqliteStorage } from "../../storage/database.ts";
import { VehicleRepository } from "../../storage/repositories.ts";
import { SecretRepository } from "../../storage/secrets.ts";
import {
  API,
  bearer,
  CARNET,
  json,
  route,
  withFetchQueue,
} from "../../tests/harness.mjs";
import { loadNodeConfig } from "../config.ts";
import { createNodeServices } from "../services.ts";
import { NodeSqliteStore, OWNER_ID } from "../sqlite-store.ts";

const key = Buffer.alloc(32, 19);
const keyB64 = key.toString("base64");
const vehicle = {
  vin: "TESTVIN0000000000",
  uuid: "synthetic-vw-reference",
  nickname: "Test Buzz",
  model: "ID. Buzz",
};
const tokens = {
  accessToken: "synthetic-access-capability",
  refreshToken: "synthetic-refresh-capability",
  idToken: "synthetic-id-capability",
  codeVerifier: "synthetic-verifier",
  expiresAt: 1_900_000_000_000,
};
const status = {
  vin: vehicle.vin,
  soc: 55,
  chargeState: "chargingHVBattery",
  chargePowerKw: 4.5,
  minutesToFull: 90,
  pluggedIn: true,
  plugLocked: true,
  targetSoc: 80,
  locked: false,
  openDoors: [],
  openWindows: [],
  unlockedDoors: [],
  rangeKm: 240,
  odometerKm: 12345,
  parkedLat: null,
  parkedLng: null,
  parkedAt: null,
  capturedAt: 1_700_000_000_000,
  rvsUpdatedAt: 1_700_000_000_000,
  doorsUpdatedAt: 1_700_000_000_000,
  locksUpdatedAt: 1_700_000_000_000,
  windowsUpdatedAt: 1_700_000_000_000,
  chargeUpdatedAt: 1_700_000_000_000,
};

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "buzzkey-node-sqlite-"));
  const path = join(dir, "app.sqlite");
  let storage = SqliteStorage.open(path);
  t.after(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const open = () => {
    const secrets = new SecretRepository(storage, "test-key", key);
    return {
      db: new NodeSqliteStore(storage, secrets, keyB64),
      secrets,
      storage,
    };
  };
  const reopen = () => {
    storage.close();
    storage = SqliteStorage.open(path);
    return open();
  };
  return { ...open(), reopen, path };
}

async function seed(db, spin = "1234") {
  const sealed = await seal(
    keyB64,
    JSON.stringify({
      username: "synthetic@example.invalid",
      password: "synthetic-password",
      spin,
    }),
  );
  const [stored] = await db.saveLogin(
    OWNER_ID,
    "synthetic-user-key",
    sealed,
    tokens,
    [vehicle],
  );
  assert.ok(stored);
  return stored;
}

test("synthetic account maps to one owner, with encrypted credentials and sessions across reopen", async (t) => {
  const f = fixture(t);
  const sealed = await seal(
    keyB64,
    JSON.stringify({
      username: "synthetic@example.invalid",
      password: "synthetic-password",
    }),
  );
  await f.db.saveAccountSession("synthetic-user-key", sealed, tokens, [
    vehicle,
  ]);
  assert.equal((await f.db.getUser(OWNER_ID)).account, null);
  await seed(f.db);
  const user = await f.db.getUser(OWNER_ID);
  assert.equal(user.vehicles[0].uuid, vehicle.uuid);
  assert.equal(user.account.tokens.refreshToken, tokens.refreshToken);
  assert.deepEqual(JSON.parse(await unseal(keyB64, user.account.sealed)), {
    username: "synthetic@example.invalid",
    password: "synthetic-password",
    spin: "1234",
  });
  const bytes = Buffer.concat([
    readFileSync(f.path),
    readFileSync(f.path + "-wal"),
  ]).toString("utf8");
  for (const secret of [
    "synthetic-password",
    "synthetic-access-capability",
    "synthetic-refresh-capability",
    "synthetic-verifier",
    "1234",
  ])
    assert.equal(bytes.includes(secret), false, secret);
  const reopened = f.reopen();
  assert.equal(
    (await reopened.db.getUser(OWNER_ID)).account.tokens.accessToken,
    tokens.accessToken,
  );
  await reopened.db.clearUserData(await reopened.db.getUser(OWNER_ID));
  assert.equal((await reopened.db.getUser(OWNER_ID)).account, null);
  assert.equal((await reopened.db.listAccounts()).length, 1);
});

test("token and per-vehicle carnet replacements retain expiry and delete absent credentials", async (t) => {
  const { db, secrets } = fixture(t);
  await seed(db);
  const account = (await db.getUser(OWNER_ID)).account;
  await db.saveCarnetToken(account, vehicle.uuid, {
    token: "synthetic-carnet-capability",
    expiresAt: 1_900_000_000_000,
  });
  assert.equal(
    account.carnetTokens[vehicle.uuid].token,
    "synthetic-carnet-capability",
  );
  assert.equal(
    (await db.getUser(OWNER_ID)).account.carnetTokens[vehicle.uuid].token,
    "synthetic-carnet-capability",
  );
  const next = {
    ...tokens,
    refreshToken: null,
    idToken: null,
    codeVerifier: null,
    expiresAt: 1_900_000_100_000,
  };
  await db.updateTokens(account.id, next);
  const read = (await db.getUser(OWNER_ID)).account;
  assert.equal(read.tokens.refreshToken, null);
  assert.equal(read.tokens.expiresAt, next.expiresAt);
  assert.equal(
    secrets.get({ accountId: account.id, purpose: "refresh_token" }),
    null,
  );
  assert.equal(
    secrets.get({
      accountId: account.id,
      purpose: "carnet_token",
      scope: vehicle.uuid,
    }).expiresAt,
    1_900_000_000_000,
  );
});

test("legacy snapshot dedupe and forced writes preserve current behavior while domain state stays conservative", async (t) => {
  const { db, storage } = fixture(t);
  const stored = await seed(db);
  assert.equal(await db.saveSnapshot(stored.id, status), true);
  assert.equal(await db.saveSnapshot(stored.id, status), false);
  assert.equal(await db.saveSnapshot(stored.id, status, { force: true }), true);
  const domain = new VehicleRepository(storage);
  assert.equal(
    domain.getCurrentState(stored.id).state.security.lock,
    "unknown",
  );
  assert.equal(domain.getCurrentState(stored.id).state.battery.socPercent, 55);
  assert.equal(domain.listObservations(stored.id).length, 1);
  assert.equal(
    storage.db.prepare("SELECT count(*) AS n FROM legacy_snapshots").get().n,
    2,
  );
  const changed = {
    ...status,
    soc: 54,
    capturedAt: status.capturedAt + 1,
    chargeUpdatedAt: status.chargeUpdatedAt + 1,
  };
  assert.equal(await db.saveSnapshot(stored.id, changed), true);
  assert.equal(domain.listObservations(stored.id).length, 2);
  assert.equal(await db.latestParkedAt(stored.id), null);
});

test("snapshot compatibility and normalized projection roll back together", async (t) => {
  const { db, storage } = fixture(t);
  const stored = await seed(db);
  storage.db.exec(
    "CREATE TRIGGER reject_observation BEFORE INSERT ON vehicle_observations BEGIN SELECT RAISE(ABORT, 'synthetic rejection'); END",
  );
  await assert.rejects(
    db.saveSnapshot(stored.id, status),
    /synthetic rejection/,
  );
  assert.equal(
    storage.db.prepare("SELECT count(*) AS n FROM legacy_snapshots").get().n,
    0,
  );
});

test("climate session transitions and owner account survive SQLite reopen", async (t) => {
  const f = fixture(t);
  const stored = await seed(f.db);
  await f.db.startClimateSession(stored.id, {
    tempF: 72,
    expiresAt: 1_900_000_000_000,
  });
  let active = await f.db.getActiveClimateSession(stored.id);
  assert.equal(active.tempF, 72);
  await f.db.updateClimateSession(active.id, {
    remainingMin: 29,
    pausedAt: 1_700_000_000_000,
    error: "synthetic parked wait",
  });
  assert.equal(
    (await f.db.listActiveClimateSessions())[0].account.id,
    (await f.db.getUser(OWNER_ID)).account.id,
  );
  const reopened = f.reopen();
  active = await reopened.db.getActiveClimateSession(stored.id);
  assert.equal(active.remainingMin, 29);
  assert.equal(active.pausedAt, 1_700_000_000_000);
  await reopened.db.startClimateSession(stored.id, {
    tempF: 70,
    expiresAt: 1_900_000_100_000,
  });
  assert.equal((await reopened.db.listActiveClimateSessions()).length, 1);
  await reopened.db.endClimateSession(stored.id, "stopped");
  assert.equal(await reopened.db.getActiveClimateSession(stored.id), null);
});

test("message sync retains local overrides and prunes only the fetched window", async (t) => {
  const { db, storage } = fixture(t);
  const accountId =
    (await db.getAccountByUserKey("synthetic-user-key"))?.id ??
    (await seed(db), (await db.getUser(OWNER_ID)).account.id);
  const messages = [
    { id: "new", title: "New", body: null, read: false, at: 300 },
    { id: "old", title: "Old", body: "body", read: false, at: 100 },
  ];
  await db.syncMessages(accountId, messages, true);
  assert.equal(await db.setMessageReadOverride(accountId, "new", true), true);
  assert.equal(await db.setMessageDeleted(accountId, "new", true), true);
  await db.syncMessages(
    accountId,
    [{ ...messages[0], title: "Updated", read: true }],
    false,
  );
  const rows = storage.db
    .prepare(
      "SELECT message_id, title, read_override, deleted_at FROM messages ORDER BY message_id",
    )
    .all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].read_override, 1);
  assert.ok(rows[0].deleted_at !== null);
  assert.equal(rows[1].message_id, "old");
  await db.syncMessages(accountId, [], true);
  assert.equal(
    storage.db.prepare("SELECT count(*) AS n FROM messages").get().n,
    0,
  );
});

test("Node composition scheduler jobs use SQLite and require no InstantDB or network", async (t) => {
  const f = fixture(t);
  const config = loadNodeConfig(
    {
      NODE_HOST: "127.0.0.1",
      NODE_PORT: "0",
      NODE_PUBLIC_ORIGIN: "https://buzzkey.test",
      BUZZKEY_SQLITE_PATH: f.path,
      BUZZKEY_MASTER_KEY_ID: "test-key",
      BUZZKEY_MASTER_KEY_B64: keyB64,
    },
    "test",
  );
  assert.equal(config.schedulerEnabled, false);
  assert.equal("INSTANT_APP_ID" in config.env, false);
  const services = createNodeServices(f.storage, config);
  const sealed = await seal(
    keyB64,
    JSON.stringify({
      username: "synthetic@example.invalid",
      password: "synthetic-password",
    }),
  );
  await services.db.saveAccountSession("synthetic-user-key", sealed, tokens, [
    vehicle,
  ]);
  await services.poll();
  await services.climate();
  assert.equal((await services.db.listAccounts()).length, 1);
});

test("a mocked VW status poll writes SQLite current state and history", async (t) => {
  const { db, storage } = fixture(t);
  const stored = await seed(db);
  const account = (await db.getUser(OWNER_ID)).account;
  await db.saveCarnetToken(account, stored.uuid, {
    token: CARNET,
    expiresAt: Date.now() + 30 * 60_000,
  });
  const rvs = JSON.parse(
    readFileSync(
      new URL("../../tests/fixtures/rvs.json", import.meta.url),
      "utf8",
    ),
  );
  const charge = JSON.parse(
    readFileSync(
      new URL("../../tests/fixtures/charge.json", import.meta.url),
      "utf8",
    ),
  );
  await withFetchQueue(
    [
      route(
        "GET",
        `${API}/rvs/v1/vehicle/${stored.uuid}`,
        json(rvs),
        bearer(CARNET),
      ),
      route(
        "GET",
        `${API}/ev/v1/vehicle/${stored.uuid}/charge/summary`,
        json(charge),
        bearer(CARNET),
      ),
    ],
    () => pollAllVehicles(db, { CREDS_ENC_KEY: keyB64 }),
  );
  const current = new VehicleRepository(storage).getCurrentState(stored.id);
  assert.equal(current.state.battery.socPercent, 74);
  assert.equal(current.state.security.lock, "locked");
  assert.equal(
    storage.db.prepare("SELECT count(*) AS n FROM legacy_snapshots").get().n,
    1,
  );
  assert.equal(
    new VehicleRepository(storage).listObservations(stored.id).length,
    1,
  );
});
