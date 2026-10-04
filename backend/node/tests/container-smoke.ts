/** Linux/ARM64 image smoke test. Runs only with a synthetic key and --network none. */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { DeviceRepository } from "../../auth/devices";
import { SqliteStorage } from "../../storage/database";
import { SecretRepository } from "../../storage/secrets";
import { createNodeScheduler } from "../scheduler";

assert.equal(process.platform, "linux");
assert.equal(process.arch, "arm64");
const path = "/data/buzzkey.sqlite";
const key = Buffer.alloc(32, 7);
const keyFile = "/tmp/buzzkey-synthetic-key.b64";
writeFileSync(keyFile, key.toString("base64"), { mode: 0o600 });
const deviceKey = new Uint8Array(32).fill(1);
const storage = SqliteStorage.open(path);
assert.equal(storage.integrityCheck(), true);
const migrations = storage.db
  .prepare("SELECT count(*) AS n FROM schema_migrations")
  .get() as { n: number };
assert.ok(migrations.n >= 1);
storage.db
  .prepare("INSERT INTO accounts(id, created_at) VALUES (?, ?)")
  .run("synthetic-account", Date.now());
const secrets = new SecretRepository(storage, "synthetic", key);
const reference = {
  accountId: "synthetic-account",
  purpose: "vw_password" as const,
};
secrets.put(reference, "synthetic-secret");
assert.equal(secrets.get(reference)?.value, "synthetic-secret");
const devices = new DeviceRepository(storage);
const pairToken = devices.issuePairing(Date.now());
const device = devices.pair(
  pairToken,
  getPublicKey(deviceKey),
  "Synthetic iPhone",
  Date.now(),
);
storage.close();

const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_HOST: "127.0.0.1",
  NODE_PORT: "8788",
  NODE_PUBLIC_ORIGIN: "https://buzzkey.test",
  BUZZKEY_SQLITE_PATH: path,
  BUZZKEY_MASTER_KEY_ID: "synthetic",
  BUZZKEY_MASTER_KEY_FILE: keyFile,
  BUZZKEY_SCHEDULER_ENABLED: "true",
};
delete env["BUZZKEY_MASTER_KEY_B64"];
const child = spawn(process.execPath, ["/app/main.mjs"], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (data: Buffer) => {
  output += data.toString();
});
child.stderr.on("data", (data: Buffer) => {
  output += data.toString();
});
const exit = new Promise<number | null>((resolve) =>
  child.once("exit", resolve),
);
let nonce = 0;
function authorization(target: string): string {
  const n = Buffer.alloc(16);
  n.writeUInt32BE(++nonce, 12);
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags: [
        ["u", `https://buzzkey.test${target}`],
        ["method", "GET"],
        ["nonce", n.toString("base64url")],
      ],
    },
    deviceKey,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}
const local = (target: string, auth?: string) =>
  fetch(`http://127.0.0.1:8788${target}`, {
    ...(auth ? { headers: { authorization: auth } } : {}),
  });
try {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) break;
    try {
      const result = await local("/health");
      if (result.ok) {
        ready = true;
        break;
      }
    } catch {
      /* starting */
    }
    await delay(100);
  }
  assert.ok(ready, `Node did not start: ${output}`);
  assert.equal((await local("/api/v1/owner")).status, 401);
  const auth = authorization("/api/v1/owner");
  const owner = await local("/api/v1/owner", auth);
  assert.equal(owner.status, 200, await owner.text());
  assert.equal((await local("/api/v1/owner", auth)).status, 401);
  const reopened = SqliteStorage.open(path);
  assert.equal(
    new SecretRepository(reopened, "synthetic", key).get(reference)?.value,
    "synthetic-secret",
  );
  assert.equal(reopened.integrityCheck(), true);
  new DeviceRepository(reopened).revoke(device.id, Date.now());
  reopened.close();
  assert.equal(
    (await local("/api/v1/owner", authorization("/api/v1/owner"))).status,
    401,
  );
  assert.match(output, /scheduler enabled/);
  child.kill("SIGTERM");
  assert.equal(await exit, 0, output);
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
}

// Exercise the scheduler's lifecycle and failure recovery on Linux ARM64.
let tick: (() => void) | undefined;
let clearCount = 0;
let polls = 0;
let climates = 0;
let failures = 0;
let release: (() => void) | undefined;
const pending = new Promise<void>((resolve) => {
  release = resolve;
});
const scheduler = createNodeScheduler(
  {
    poll: async () => {
      polls++;
      if (polls === 1) await pending;
      if (polls === 2) throw new Error("synthetic failure");
    },
    climate: () => {
      climates++;
      return Promise.resolve();
    },
  },
  {
    clock: {
      setInterval: (callback) => {
        tick = callback;
        return 1;
      },
      clearInterval: () => {
        clearCount++;
      },
    },
    onError: () => {
      failures++;
    },
  },
);
scheduler.start();
tick?.();
await delay(0);
tick?.();
assert.equal(polls, 1);
assert.equal(climates, 1);
release?.();
await delay(0);
tick?.();
await delay(0);
assert.equal(polls, 2);
assert.equal(climates, 2);
assert.equal(failures, 1);
tick?.();
await delay(0);
assert.equal(polls, 3);
assert.equal(climates, 3);
await scheduler.stop();
assert.equal(clearCount, 1);
tick?.();
assert.equal(polls, 3);

const missingOrigin = { ...env };
delete missingOrigin["NODE_PUBLIC_ORIGIN"];
const failed = spawn(process.execPath, ["/app/main.mjs"], {
  env: missingOrigin,
  stdio: "ignore",
});
assert.notEqual(
  await new Promise<number | null>((resolve) => failed.once("exit", resolve)),
  0,
);
console.log(
  `ARM64 smoke PASS: node:sqlite, ${String(migrations.n)} migrations, AES round-trip, NIP-98/replay/revocation, health/API, scheduler, SIGTERM, config failure, /data`,
);
