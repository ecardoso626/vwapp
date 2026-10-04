import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { getPublicKey } from "nostr-tools";
import { createBuzzKeyClient } from "../../../app/src/buzzkey-client.ts";
import { DeviceRepository } from "../../auth/devices.ts";
import { seal } from "../../src/crypto.ts";
import { SqliteStorage } from "../../storage/database.ts";
import { SecretRepository } from "../../storage/secrets.ts";
import {
  ACCESS,
  ID_TOKEN,
  REFRESH,
  UUID,
  VIN,
  withFetchQueue,
} from "../../tests/harness.mjs";
import { loadNodeConfig } from "../config.ts";
import { NodeLockCommands } from "../lock-commands.ts";
import { createNodeRuntime } from "../runtime.ts";
import { createNodeServices } from "../services.ts";

export const origin = "https://buzzkey.example.invalid";
export const username = "phase8-synthetic@example.invalid";
export const password = "Phase8-SYNTHETIC-password-never-real";
export const spin = "876543";
export const key = Buffer.alloc(32, 23);
export const secret = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const sha256 = async (bytes) => createHash("sha256").update(bytes).digest();
const Response = globalThis.Response;
export async function offline(steps, run) {
  const failures = [];
  return withFetchQueue(steps, async (calls) => {
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
      const result = await run(calls);
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
export async function fixture(t, options = {}) {
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
    services.commands = new NodeLockCommands(storage, services.db, config.env, {
      intervalMs: 0,
      observationAttempts: 1,
      ...options,
    });
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
export async function seed(
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
