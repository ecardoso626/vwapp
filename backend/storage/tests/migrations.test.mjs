import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, migrationStatus } from "../database.ts";
import { MIGRATIONS } from "../migrations.ts";
import { temporaryStore } from "./helper.mjs";

test("empty database migrates to latest version with foreign keys enabled", (t) => {
  const { store } = temporaryStore(t);
  const status = migrationStatus(store.db);
  assert.deepEqual(
    status.map((row) => row.version),
    [1, 2, 3],
  );
  assert.equal(status[0].name, "initial_storage_foundation");
  assert.equal(status[1].name, "owner_device_authentication");
  assert.match(status[0].checksum, /^[a-f0-9]{64}$/);
  assert.equal(store.db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(store.integrityCheck(), true);
});

test("reapplying migrations is idempotent and preserves the ledger", (t) => {
  const { store } = temporaryStore(t);
  const first = migrationStatus(store.db);
  assert.deepEqual(applyMigrations(store.db), first);
  assert.deepEqual(migrationStatus(store.db), first);
});

test("failing migration rolls back its tables and ledger entry", (t) => {
  const { store } = temporaryStore(t);
  const broken = [
    ...MIGRATIONS,
    {
      version: 3,
      name: "synthetic_failure",
      sql: "CREATE TABLE should_rollback(id INTEGER); SELECT * FROM missing_synthetic_table;",
    },
  ];
  assert.throws(() => applyMigrations(store.db, broken));
  assert.deepEqual(
    migrationStatus(store.db).map((row) => row.version),
    [1, 2, 3],
  );
  assert.equal(
    store.db
      .prepare("SELECT name FROM sqlite_master WHERE name = 'should_rollback'")
      .get(),
    undefined,
  );
});

test("changed or future migration ledgers are refused", (t) => {
  const { store } = temporaryStore(t);
  store.db.exec(
    "UPDATE schema_migrations SET checksum = 'changed' WHERE version = 1",
  );
  assert.throws(() => applyMigrations(store.db), /Unknown or changed/);
  store.db.exec(
    "UPDATE schema_migrations SET checksum = 'changed' WHERE version = 1",
  );
  const future = new DatabaseSync(":memory:");
  t.after(() => future.close());
  future.exec(
    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT, checksum TEXT, applied_at INTEGER)",
  );
  future.exec("INSERT INTO schema_migrations VALUES (9, 'future', 'hash', 0)");
  assert.throws(() => applyMigrations(future), /Unknown or changed/);
});
