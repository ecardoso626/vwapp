import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  PasswordLoginBudgetError,
  setPasswordLoginGuard,
} from "../../src/vw/auth-diagnostics.ts";
import { vwLogin } from "../../src/vw/client.ts";
import { SqliteStorage } from "../../storage/database.ts";
import { API, html, route, withFetchQueue } from "../../tests/harness.mjs";
import { loadNodeConfig } from "../config.ts";
import { onePasswordLogin } from "../login-attempt.ts";
import { createNodeServices } from "../services.ts";

const env = {
  NODE_PUBLIC_ORIGIN: "https://example.invalid:8443",
  BUZZKEY_SQLITE_PATH: "/data/buzzkey.sqlite",
  BUZZKEY_MASTER_KEY_ID: "test",
  BUZZKEY_MASTER_KEY_B64: Buffer.alloc(32, 7).toString("base64"),
};
test("attempt marker is exclusive, private, empty and survives a new guard instance", () => {
  const dir = mkdtempSync(join(tmpdir(), "auth-budget-"));
  try {
    const path = join(dir, "auth-diagnostic-test.used");
    const guard = onePasswordLogin(path);
    guard();
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readFileSync(path).length, 0);
    assert.throws(guard, PasswordLoginBudgetError);
    assert.throws(onePasswordLogin(path), PasswordLoginBudgetError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("unwritable or unavailable marker fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "auth-budget-"));
  try {
    assert.throws(
      onePasswordLogin(join(dir, "missing", "marker")),
      PasswordLoginBudgetError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("Node accepts only the diagnostic marker beside persistent SQLite", () => {
  assert.equal(
    loadNodeConfig({
      ...env,
      BUZZKEY_AUTH_ATTEMPT_MARKER: "/data/auth-diagnostic-test.used",
    }).passwordLoginMarker,
    "/data/auth-diagnostic-test.used",
  );
  for (const path of [
    "relative.used",
    "/tmp/auth-diagnostic-test.used",
    "/data/buzzkey.sqlite",
    "/data/../other/auth-diagnostic-test.used",
  ])
    assert.throws(
      () => loadNodeConfig({ ...env, BUZZKEY_AUTH_ATTEMPT_MARKER: path }),
      /Invalid authentication attempt marker/,
    );
});
test("production composition blocks all fallback logins after a failed attempt and recreation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "auth-budget-"));
  const config = loadNodeConfig({
    ...env,
    BUZZKEY_SQLITE_PATH: join(dir, "buzzkey.sqlite"),
    BUZZKEY_AUTH_ATTEMPT_MARKER: join(dir, "auth-diagnostic-test.used"),
  });
  let storage = SqliteStorage.open(config.sqlitePath);
  try {
    createNodeServices(storage, config);
    await withFetchQueue(
      [
        route(
          "GET",
          (url) => assert.ok(url.startsWith(API + "/oidc/v1/authorize?")),
          html("synthetic missing form"),
        ),
      ],
      async () => {
        await assert.rejects(
          vwLogin("synthetic@example.invalid", "synthetic-password"),
          /markup changed/,
        );
      },
    );
    storage.close();
    storage = SqliteStorage.open(config.sqlitePath);
    createNodeServices(storage, config);
    await withFetchQueue([], async () => {
      await assert.rejects(
        vwLogin("synthetic@example.invalid", "synthetic-password"),
        PasswordLoginBudgetError,
      );
      await assert.rejects(
        vwLogin("synthetic@example.invalid", "synthetic-password"),
        PasswordLoginBudgetError,
      );
    });
  } finally {
    setPasswordLoginGuard(undefined);
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
