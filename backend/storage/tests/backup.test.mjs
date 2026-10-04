import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { test } from "node:test";
import { migrationStatus, SqliteStorage } from "../database.ts";
import { VehicleRepository } from "../repositories.ts";
import { SecretAuthenticationError, SecretRepository } from "../secrets.ts";
import { seededStore, vehicleState } from "./helper.mjs";

test("WAL-safe backup reopens with state, history and correct external key", async (t) => {
  const { dir, store, vehicles } = seededStore(t);
  const key = Buffer.alloc(32, 44);
  const secrets = new SecretRepository(store, "backup-key", key);
  const state = vehicleState();
  state.battery.socPercent = 55;
  vehicles.saveState("synthetic-vehicle", state, 900);
  secrets.put(
    { accountId: "synthetic-account", purpose: "access_token" },
    "synthetic-backup-token",
  );
  const backupPath = join(dir, "restored.sqlite");
  await store.backupTo(backupPath);
  const restored = SqliteStorage.open(backupPath);
  t.after(() => restored.close());
  assert.equal(restored.integrityCheck(), true);
  assert.deepEqual(
    migrationStatus(restored.db).map((row) => row.version),
    [1],
  );
  assert.equal(
    new VehicleRepository(restored).getCurrentState("synthetic-vehicle").state
      .battery.socPercent,
    55,
  );
  assert.equal(
    new VehicleRepository(restored).listObservations("synthetic-vehicle")
      .length,
    1,
  );
  assert.equal(
    new SecretRepository(restored, "backup-key", key).get({
      accountId: "synthetic-account",
      purpose: "access_token",
    }).value,
    "synthetic-backup-token",
  );
  assert.throws(
    () =>
      new SecretRepository(restored, "backup-key", Buffer.alloc(32, 45)).get({
        accountId: "synthetic-account",
        purpose: "access_token",
      }),
    SecretAuthenticationError,
  );
});
