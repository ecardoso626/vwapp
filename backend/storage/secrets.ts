import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SqliteStorage } from "./database";

export type SecretPurpose =
  | "vw_username"
  | "vw_password"
  | "vw_spin"
  | "access_token"
  | "refresh_token"
  | "id_token"
  | "code_verifier"
  | "carnet_token";

export interface SecretReference {
  accountId: string;
  purpose: SecretPurpose;
  /** Only carnet tokens use a vehicle reference; all other purposes use an empty scope. */
  scope?: string;
}

interface EnvelopeRow {
  account_id: string;
  purpose: SecretPurpose;
  scope: string;
  expires_at: number | null;
  envelope_version: number;
  algorithm: string;
  key_id: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  tag: Uint8Array;
  updated_at: number;
}

export class SecretAuthenticationError extends Error {
  constructor() {
    super("Secret authentication failed");
  }
}

function normalizedScope(reference: SecretReference): string {
  const scope = reference.scope ?? "";
  if ((reference.purpose === "carnet_token") !== (scope !== ""))
    throw new Error(
      "Carnet secrets require a vehicle scope; other secrets do not",
    );
  return scope;
}

function aad(
  row: Pick<
    EnvelopeRow,
    | "account_id"
    | "purpose"
    | "scope"
    | "expires_at"
    | "envelope_version"
    | "algorithm"
    | "key_id"
    | "updated_at"
  >,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      row.envelope_version,
      row.algorithm,
      row.key_id,
      row.account_id,
      row.purpose,
      row.scope,
      row.expires_at,
      row.updated_at,
    ]),
  );
}

function seal(value: string, key: Buffer, metadata: EnvelopeRow): EnvelopeRow {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad(metadata));
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return { ...metadata, nonce, ciphertext, tag: cipher.getAuthTag() };
}

function unseal(row: EnvelopeRow, keyId: string, key: Buffer): string {
  if (
    row.envelope_version !== 1 ||
    row.algorithm !== "AES-256-GCM" ||
    row.key_id !== keyId
  )
    throw new SecretAuthenticationError();
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, row.nonce);
    decipher.setAAD(aad(row));
    decipher.setAuthTag(row.tag);
    return Buffer.concat([
      decipher.update(row.ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new SecretAuthenticationError();
  }
}

/** The key lives in process memory only; SQLite stores the key ID and AEAD envelope. */
export class SecretRepository {
  private keyId: string;
  private key: Buffer;
  private readonly storage: SqliteStorage;
  private readonly now: () => number;

  constructor(
    storage: SqliteStorage,
    keyId: string,
    key: Buffer,
    now: () => number = Date.now,
  ) {
    this.storage = storage;
    this.now = now;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyId)) throw new Error("Invalid key ID");
    if (key.length !== 32)
      throw new Error("Master key must be exactly 32 bytes");
    this.keyId = keyId;
    this.key = Buffer.from(key);
  }

  put(
    reference: SecretReference,
    value: string,
    expiresAt: number | null = null,
  ): void {
    if (value === "") throw new Error("Empty secret value");
    const metadata: EnvelopeRow = {
      account_id: reference.accountId,
      purpose: reference.purpose,
      scope: normalizedScope(reference),
      expires_at: expiresAt,
      envelope_version: 1,
      algorithm: "AES-256-GCM",
      key_id: this.keyId,
      nonce: Buffer.alloc(0),
      ciphertext: Buffer.alloc(0),
      tag: Buffer.alloc(0),
      updated_at: this.now(),
    };
    const row = seal(value, this.key, metadata);
    this.storage.db
      .prepare(
        `INSERT INTO account_secrets
      (account_id, purpose, scope, expires_at, envelope_version, algorithm,
       key_id, nonce, ciphertext, tag, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, purpose, scope) DO UPDATE SET
        expires_at=excluded.expires_at, envelope_version=excluded.envelope_version,
        algorithm=excluded.algorithm, key_id=excluded.key_id, nonce=excluded.nonce,
        ciphertext=excluded.ciphertext, tag=excluded.tag, updated_at=excluded.updated_at`,
      )
      .run(
        row.account_id,
        row.purpose,
        row.scope,
        row.expires_at,
        row.envelope_version,
        row.algorithm,
        row.key_id,
        row.nonce,
        row.ciphertext,
        row.tag,
        row.updated_at,
      );
  }

  get(
    reference: SecretReference,
  ): { value: string; expiresAt: number | null } | null {
    const row = this.storage.db
      .prepare(
        `SELECT * FROM account_secrets
      WHERE account_id = ? AND purpose = ? AND scope = ?`,
      )
      .get(
        reference.accountId,
        reference.purpose,
        normalizedScope(reference),
      ) as EnvelopeRow | undefined;
    return row === undefined
      ? null
      : {
          value: unseal(row, this.keyId, this.key),
          expiresAt: row.expires_at,
        };
  }

  /** All rows rotate atomically; the in-memory active key changes only after commit. */
  rotate(newKeyId: string, newKey: Buffer): number {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(newKeyId) || newKeyId === this.keyId)
      throw new Error("New key ID must differ from current key ID");
    if (newKey.length !== 32)
      throw new Error("New master key must be exactly 32 bytes");
    const nextKey = Buffer.from(newKey);
    const count = this.storage.transaction(() => {
      const rows = this.storage.db
        .prepare(
          "SELECT * FROM account_secrets ORDER BY account_id, purpose, scope",
        )
        .all() as unknown as EnvelopeRow[];
      const update = this.storage.db.prepare(`UPDATE account_secrets SET
        envelope_version=?, algorithm=?, key_id=?, nonce=?, ciphertext=?, tag=?, updated_at=?
        WHERE account_id=? AND purpose=? AND scope=?`);
      for (const row of rows) {
        const value = unseal(row, this.keyId, this.key);
        const next = seal(value, nextKey, {
          ...row,
          key_id: newKeyId,
          updated_at: this.now(),
        });
        update.run(
          next.envelope_version,
          next.algorithm,
          next.key_id,
          next.nonce,
          next.ciphertext,
          next.tag,
          next.updated_at,
          row.account_id,
          row.purpose,
          row.scope,
        );
      }
      return rows.length;
    });
    this.keyId = newKeyId;
    this.key = nextKey;
    return count;
  }
}
