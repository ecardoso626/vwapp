import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { migrationStatus, SqliteStorage } from "../../storage/database.ts";
import { temporaryStore } from "../../storage/tests/helper.mjs";
import { DeviceRepository } from "../devices.ts";
import { nowMs, pubkeyA, pubkeyB } from "./helper.mjs";

test("migration 2 records device, pairing and replay tables", (t) => {
  const { store } = temporaryStore(t);
  assert.deepEqual(
    migrationStatus(store.db).map((row) => row.version),
    [1, 2, 3, 4, 5, 6, 7],
  );
  const names = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => row.name);
  for (const name of [
    "authorized_devices",
    "pairing_sessions",
    "auth_replay_events",
  ])
    assert.ok(names.includes(name));
});

test("admin issues a high-entropy short-lived token; only its hash is stored", (t) => {
  const { store, path } = temporaryStore(t);
  const devices = new DeviceRepository(store);
  const token = devices.issuePairing(nowMs);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(readFileSync(path).includes(Buffer.from(token)), false);
  const device = devices.pair(token, pubkeyA, "Synthetic iPhone", nowMs + 1);
  assert.equal(device.pubkey, pubkeyA);
  assert.equal(device.revokedAt, null);
  assert.equal(devices.getByPubkey(pubkeyA)?.id, device.id);
  assert.throws(() => devices.pair(token, pubkeyB, "Other", nowMs + 2));
});

test("expired, malformed and reused pairing material cannot authorize", (t) => {
  const { store } = temporaryStore(t);
  const devices = new DeviceRepository(store);
  const token = devices.issuePairing(nowMs, 1_000);
  assert.throws(() => devices.pair("bad", pubkeyA, "Phone", nowMs));
  assert.throws(() => devices.pair(token, pubkeyA, "Phone", nowMs + 1_001));
  assert.equal(devices.getByPubkey(pubkeyA), null);
  const fresh = devices.issuePairing(nowMs + 2_000);
  devices.pair(fresh, pubkeyA, "Phone", nowMs + 2_000);
  assert.throws(() => devices.pair(fresh, pubkeyB, "Phone", nowMs + 2_001));
});

test("revocation persists and the same key cannot silently reactivate", (t) => {
  const { store } = temporaryStore(t);
  const devices = new DeviceRepository(store);
  const first = devices.pair(
    devices.issuePairing(nowMs),
    pubkeyA,
    "Phone",
    nowMs,
  );
  assert.equal(devices.revoke(first.id, nowMs + 1), true);
  assert.equal(devices.revoke(first.id, nowMs + 2), false);
  assert.equal(devices.getByPubkey(pubkeyA)?.revokedAt, nowMs + 1);
  assert.throws(() =>
    devices.pair(devices.issuePairing(nowMs + 3), pubkeyA, "Phone", nowMs + 3),
  );
});

test("replay uniqueness survives database close and reopen", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "buzzkey-auth-replay-"));
  const path = join(dir, "auth.sqlite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let store = SqliteStorage.open(path);
  let devices = new DeviceRepository(store);
  devices.pair(devices.issuePairing(nowMs), pubkeyA, "Phone", nowMs);
  const eventId = "a".repeat(64);
  devices.consumeReplay(eventId, pubkeyA, nowMs, nowMs + 60_000);
  store.close();
  store = SqliteStorage.open(path);
  t.after(() => store.close());
  devices = new DeviceRepository(store);
  assert.throws(
    () => devices.consumeReplay(eventId, pubkeyA, nowMs + 1, nowMs + 60_000),
    (error) => error.code === "replay",
  );
  assert.equal(devices.replayCount(), 1);
});

test("old replay entries are removed only after their acceptance window", (t) => {
  const { store } = temporaryStore(t);
  const devices = new DeviceRepository(store);
  devices.pair(devices.issuePairing(nowMs), pubkeyA, "Phone", nowMs);
  devices.consumeReplay("a".repeat(64), pubkeyA, nowMs, nowMs + 60_000);
  assert.throws(
    () =>
      devices.consumeReplay(
        "a".repeat(64),
        pubkeyA,
        nowMs + 60_000,
        nowMs + 60_000,
      ),
    (error) => error.code === "replay",
  );
  devices.consumeReplay(
    "b".repeat(64),
    pubkeyA,
    nowMs + 60_001,
    nowMs + 120_000,
  );
  assert.equal(devices.replayCount(), 1);
});

test("replay capacity fails closed and revoked devices consume no event", (t) => {
  const { store } = temporaryStore(t);
  const devices = new DeviceRepository(store);
  const device = devices.pair(
    devices.issuePairing(nowMs),
    pubkeyA,
    "Phone",
    nowMs,
  );
  devices.consumeReplay("a".repeat(64), pubkeyA, nowMs, nowMs + 60_000, 1);
  assert.throws(
    () =>
      devices.consumeReplay("b".repeat(64), pubkeyA, nowMs, nowMs + 60_000, 1),
    (error) => error.code === "rate_limited",
  );
  devices.revoke(device.id, nowMs + 1);
  assert.throws(
    () =>
      devices.consumeReplay("c".repeat(64), pubkeyA, nowMs + 1, nowMs + 60_000),
    (error) => error.code === "revoked_device",
  );
  assert.equal(devices.replayCount(), 1);
});
