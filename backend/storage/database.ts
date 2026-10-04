import { createHash } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import { MIGRATIONS, type Migration } from "./migrations";

export interface MigrationRecord {
  version: number;
  name: string;
  checksum: string;
  appliedAt: number;
}

const checksum = (sql: string): string =>
  createHash("sha256").update(sql).digest("hex");

/** Apply all known migrations in one SQLite write transaction. */
export function applyMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
  now: () => number = Date.now,
): MigrationRecord[] {
  for (let index = 0; index < migrations.length; index++) {
    if (migrations[index]?.version !== index + 1)
      throw new Error(
        "Migrations must be contiguous and ordered from version 1",
      );
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT`);
    const applied = db
      .prepare(
        "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version",
      )
      .all() as unknown as {
      version: number;
      name: string;
      checksum: string;
      applied_at: number;
    }[];
    for (const [index, row] of applied.entries()) {
      const expected = migrations[index];
      if (expected === undefined)
        throw new Error(
          `Unknown SQLite migration at version ${String(row.version)}`,
        );
      if (
        row.version !== expected.version ||
        row.name !== expected.name ||
        row.checksum !== checksum(expected.sql)
      )
        throw new Error(
          `Unknown or changed SQLite migration at version ${String(row.version)}`,
        );
    }
    const insert = db.prepare(
      "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
    );
    for (const migration of migrations.slice(applied.length)) {
      db.exec(migration.sql);
      insert.run(
        migration.version,
        migration.name,
        checksum(migration.sql),
        now(),
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return migrationStatus(db);
}

export function migrationStatus(db: DatabaseSync): MigrationRecord[] {
  const exists = db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();
  if (exists === undefined) return [];
  return (
    db
      .prepare(
        "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version",
      )
      .all() as unknown as {
      version: number;
      name: string;
      checksum: string;
      applied_at: number;
    }[]
  ).map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}

/** One synchronous writer connection; callbacks may not yield or nest. */
export class SqliteStorage {
  private transactionOpen = false;

  readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static open(path: string): SqliteStorage {
    if (path.trim() === "") throw new Error("SQLite path is required");
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA journal_mode = WAL");
      applyMigrations(db);
      return new SqliteStorage(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  transaction<T>(work: () => T): T {
    if (this.transactionOpen)
      throw new Error("Nested SQLite transactions are unsupported");
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionOpen = true;
    try {
      const result = work();
      if (result instanceof Promise)
        throw new Error("SQLite transaction callback must be synchronous");
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionOpen = false;
    }
  }

  async backupTo(path: string): Promise<void> {
    if (path.trim() === "") throw new Error("Backup path is required");
    await backup(this.db, path);
  }

  integrityCheck(): boolean {
    const row = this.db.prepare("PRAGMA integrity_check").get() as {
      integrity_check: string;
    };
    return row.integrity_check === "ok";
  }

  close(): void {
    this.db.close();
  }
}
