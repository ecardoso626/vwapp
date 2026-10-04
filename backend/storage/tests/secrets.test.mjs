import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadStorageConfig } from "../config.ts";
import { SecretAuthenticationError, SecretRepository } from "../secrets.ts";
import { seededStore } from "./helper.mjs";

const keyA = Buffer.alloc(32, 11);
const keyB = Buffer.alloc(32, 22);
const ref = { accountId: "synthetic-account", purpose: "access_token" };
const syntheticSecret = "synthetic-reusable-secret-DO-NOT-USE";

function vault(t) {
  const setup = seededStore(t);
  return {
    ...setup,
    secrets: new SecretRepository(setup.store, "test-key-a", keyA, () => 500),
  };
}

test("storage config requires a path, key ID, and one valid external 32-byte key", (t) => {
  const { dir } = vault(t);
  const env = {
    BUZZKEY_SQLITE_PATH: join(dir, "other.sqlite"),
    BUZZKEY_MASTER_KEY_ID: "test-key-a",
    BUZZKEY_MASTER_KEY_B64: keyA.toString("base64"),
  };
  assert.deepEqual(loadStorageConfig(env), {
    path: env.BUZZKEY_SQLITE_PATH,
    keyId: "test-key-a",
    masterKey: keyA,
  });
  assert.throws(
    () => loadStorageConfig({ ...env, BUZZKEY_SQLITE_PATH: "" }),
    /BUZZKEY_SQLITE_PATH/,
  );
  assert.throws(
    () => loadStorageConfig({ ...env, BUZZKEY_MASTER_KEY_B64: "short" }),
    /32 bytes/,
  );
  assert.throws(
    () => loadStorageConfig({ ...env, BUZZKEY_MASTER_KEY_B64: undefined }),
    /exactly one/,
  );
  const keyFile = join(dir, "synthetic-key.txt");
  writeFileSync(keyFile, `${keyA.toString("base64")}\n`);
  const fromFile = loadStorageConfig({
    ...env,
    BUZZKEY_MASTER_KEY_B64: undefined,
    BUZZKEY_MASTER_KEY_FILE: keyFile,
  });
  assert.deepEqual(fromFile.masterKey, keyA);
  assert.throws(
    () => loadStorageConfig({ ...env, BUZZKEY_MASTER_KEY_FILE: keyFile }),
    /exactly one/,
  );
});

test("all reusable secret purposes store and decrypt under their own context", (t) => {
  const { secrets } = vault(t);
  const purposes = [
    "vw_username",
    "vw_password",
    "vw_spin",
    "access_token",
    "refresh_token",
    "id_token",
    "code_verifier",
  ];
  for (const purpose of purposes) {
    const reference = { accountId: "synthetic-account", purpose };
    secrets.put(reference, `${syntheticSecret}-${purpose}`, 1234);
    assert.deepEqual(secrets.get(reference), {
      value: `${syntheticSecret}-${purpose}`,
      expiresAt: 1234,
    });
  }
  const carnet = {
    accountId: "synthetic-account",
    purpose: "carnet_token",
    scope: "synthetic-vw-reference",
  };
  secrets.put(carnet, `${syntheticSecret}-carnet`, 9999);
  assert.equal(secrets.get(carnet).value, `${syntheticSecret}-carnet`);
  assert.throws(
    () =>
      secrets.put(
        { accountId: "synthetic-account", purpose: "carnet_token" },
        "x",
      ),
    /scope/,
  );
  assert.equal(
    secrets.get({
      accountId: "synthetic-account",
      purpose: "refresh_token",
      scope: "",
    }).value,
    `${syntheticSecret}-refresh_token`,
  );
});

test("secret plaintext does not appear in SQLite or WAL bytes", (t) => {
  const { path, secrets } = vault(t);
  secrets.put(ref, syntheticSecret);
  for (const file of [path, `${path}-wal`]) {
    try {
      assert.equal(
        readFileSync(file).includes(Buffer.from(syntheticSecret)),
        false,
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
});

test("wrong key or wrong key ID fails authentication", (t) => {
  const { store, secrets } = vault(t);
  secrets.put(ref, syntheticSecret);
  assert.throws(
    () => new SecretRepository(store, "test-key-a", keyB).get(ref),
    SecretAuthenticationError,
  );
  assert.throws(
    () => new SecretRepository(store, "test-key-b", keyA).get(ref),
    SecretAuthenticationError,
  );
});

for (const field of ["ciphertext", "nonce", "tag"]) {
  test(`tampered ${field} fails authentication`, (t) => {
    const { store, secrets } = vault(t);
    secrets.put(ref, syntheticSecret);
    const original = store.db
      .prepare(`SELECT ${field} AS value FROM account_secrets`)
      .get().value;
    const tampered = Buffer.from(original);
    tampered[0] ^= 1;
    store.db.prepare(`UPDATE account_secrets SET ${field} = ?`).run(tampered);
    assert.throws(() => secrets.get(ref), SecretAuthenticationError);
  });
}

test("tampered authenticated metadata or transplanted envelope fails", (t) => {
  const { store, secrets } = vault(t);
  secrets.put(ref, syntheticSecret, 1000);
  store.db.exec("UPDATE account_secrets SET expires_at = 2000");
  assert.throws(() => secrets.get(ref), SecretAuthenticationError);
  store.db.exec("UPDATE account_secrets SET expires_at = 1000");
  assert.equal(secrets.get(ref).value, syntheticSecret);
  const other = { accountId: "synthetic-account", purpose: "refresh_token" };
  secrets.put(other, "synthetic-other-secret");
  const row = store.db
    .prepare(
      "SELECT nonce, ciphertext, tag FROM account_secrets WHERE purpose = 'access_token'",
    )
    .get();
  assert.throws(() =>
    store.db
      .prepare(
        "UPDATE account_secrets SET nonce=?, ciphertext=?, tag=? WHERE purpose='refresh_token'",
      )
      .run(row.nonce, row.ciphertext, row.tag),
  );
  store.db
    .prepare(
      "UPDATE account_secrets SET ciphertext=?, tag=? WHERE purpose='refresh_token'",
    )
    .run(row.ciphertext, row.tag);
  assert.throws(() => secrets.get(other), SecretAuthenticationError);
});

test("fresh nonce is used when the same secret is replaced", (t) => {
  const { store, secrets } = vault(t);
  secrets.put(ref, syntheticSecret);
  const first = store.db
    .prepare("SELECT nonce FROM account_secrets")
    .get().nonce;
  secrets.put(ref, syntheticSecret);
  const second = store.db
    .prepare("SELECT nonce FROM account_secrets")
    .get().nonce;
  assert.notDeepEqual(first, second);
  assert.equal(secrets.get(ref).value, syntheticSecret);
});

test("rotation re-encrypts all secrets atomically under a new key ID", (t) => {
  const { store, secrets } = vault(t);
  const other = { accountId: "synthetic-account", purpose: "refresh_token" };
  secrets.put(ref, syntheticSecret);
  secrets.put(other, "synthetic-refresh-secret");
  const oldNonce = store.db
    .prepare("SELECT nonce FROM account_secrets WHERE purpose='access_token'")
    .get().nonce;
  assert.equal(secrets.rotate("test-key-b", keyB), 2);
  assert.equal(secrets.get(ref).value, syntheticSecret);
  assert.equal(secrets.get(other).value, "synthetic-refresh-secret");
  assert.deepEqual(
    store.db
      .prepare("SELECT DISTINCT key_id FROM account_secrets")
      .all()
      .map((row) => row.key_id),
    ["test-key-b"],
  );
  assert.notDeepEqual(
    store.db
      .prepare("SELECT nonce FROM account_secrets WHERE purpose='access_token'")
      .get().nonce,
    oldNonce,
  );
  assert.throws(
    () => new SecretRepository(store, "test-key-a", keyA).get(ref),
    SecretAuthenticationError,
  );
});

test("failed rotation rolls back earlier row updates and keeps old active key", (t) => {
  const { store, secrets } = vault(t);
  const other = { accountId: "synthetic-account", purpose: "refresh_token" };
  secrets.put(ref, syntheticSecret);
  secrets.put(other, "synthetic-refresh-secret");
  const original = store.db
    .prepare("SELECT tag FROM account_secrets WHERE purpose='refresh_token'")
    .get().tag;
  const tampered = Buffer.from(original);
  tampered[0] ^= 1;
  store.db
    .prepare("UPDATE account_secrets SET tag=? WHERE purpose='refresh_token'")
    .run(tampered);
  assert.throws(
    () => secrets.rotate("test-key-b", keyB),
    SecretAuthenticationError,
  );
  assert.deepEqual(
    store.db
      .prepare("SELECT DISTINCT key_id FROM account_secrets")
      .all()
      .map((row) => row.key_id),
    ["test-key-a"],
  );
  assert.equal(secrets.get(ref).value, syntheticSecret);
  assert.throws(() => secrets.get(other), SecretAuthenticationError);
});
