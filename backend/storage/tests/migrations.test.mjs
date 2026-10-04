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
    [1, 2, 3, 4],
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
      version: MIGRATIONS.length + 1,
      name: "synthetic_failure",
      sql: "CREATE TABLE should_rollback(id INTEGER); SELECT * FROM missing_synthetic_table;",
    },
  ];
  assert.throws(() => applyMigrations(store.db, broken));
  assert.deepEqual(
    migrationStatus(store.db).map((row) => row.version),
    [1, 2, 3, 4],
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

test("version 4 upgrades an existing owner link without deleting accounts or pretending session verification", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  applyMigrations(db, MIGRATIONS.slice(0, 3));
  db.exec(
    "INSERT INTO accounts(id, created_at) VALUES ('synthetic-existing-account', 0); INSERT INTO owner_account_link(owner_id, account_id) VALUES ('owner', 'synthetic-existing-account');",
  );
  applyMigrations(db);
  const row = db
    .prepare("SELECT * FROM owner_vw_connection WHERE owner_id = 'owner'")
    .get();
  assert.equal(row.account_id, "synthetic-existing-account");
  assert.equal(row.verified_at, null);
  assert.equal(row.pending_attempt_id, null);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM owner_account_link").get().n,
    1,
  );
  assert.deepEqual(
    migrationStatus(db).map((row) => row.version),
    [1, 2, 3, 4],
  );
});
