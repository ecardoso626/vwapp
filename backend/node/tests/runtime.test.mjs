import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { request } from "node:http";
import { test } from "node:test";
import { setImmediate } from "node:timers";
import { DeviceRepository } from "../../auth/devices.ts";
import { DeviceAuthService } from "../../auth/service.ts";
import {
  nowMs,
  origin,
  pubkeyA,
  signedRequest,
} from "../../auth/tests/helper.mjs";
import { SqliteStorage } from "../../storage/database.ts";
import { loadNodeConfig } from "../config.ts";
import { createNodeRuntime, installShutdownSignals } from "../runtime.ts";
import { createNodeScheduler, POLL_INTERVAL_MS } from "../scheduler.ts";

const syntheticEnv = {
  NODE_HOST: "127.0.0.1",
  NODE_PORT: "0",
  NODE_PUBLIC_ORIGIN: origin,
  BUZZKEY_SQLITE_PATH: ":memory:",
  INSTANT_APP_ID: "synthetic-instant-app",
  INSTANT_ADMIN_TOKEN: "synthetic-admin-token",
  CREDS_ENC_KEY: Buffer.alloc(32, 7).toString("base64"),
};
function fakeClock() {
  let tick,
    interval,
    cleared = false;
  return {
    setInterval(callback, ms) {
      tick = callback;
      interval = ms;
      return 1;
    },
    clearInterval(handle) {
      assert.equal(handle, 1);
      cleared = true;
    },
    fire() {
      assert.ok(tick);
      tick();
    },
    get interval() {
      return interval;
    },
    get cleared() {
      return cleared;
    },
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
function localRequest(
  port,
  path,
  { method = "GET", token, body, authorization } = {},
) {
  return new Promise((resolve, reject) => {
    const payload =
      body === undefined ? undefined : JSON.stringify({ json: body });
    const headers = {
      ...(token === undefined ? {} : { "x-instant-token": token }),
      ...(authorization === undefined && token === undefined
        ? {}
        : {
            authorization:
              authorization ??
              signedRequest({
                method,
                target: path,
                body: Buffer.from(payload ?? ""),
              }).request.authorization,
          }),
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    };
    const req = request(
      { host: "127.0.0.1", port, path, method, headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
function fakeServices() {
  let verifications = 0;
  const storage = SqliteStorage.open(":memory:");
  const devices = new DeviceRepository(storage);
  devices.pair(devices.issuePairing(nowMs), pubkeyA, "Synthetic iPhone", nowMs);
  return {
    services: {
      auth: new DeviceAuthService(devices, origin, () => nowMs),
      db: {
        auth: {
          async verifyToken(token) {
            verifications++;
            if (token !== "synthetic-guest-token")
              throw new Error("invalid synthetic token");
            return { id: "synthetic-user" };
          },
        },
      },
      poll: () => Promise.resolve(),
      climate: () => Promise.resolve(),
    },
    get verifications() {
      return verifications;
    },
  };
}

test("validated config separates required secrets from optional Node settings", () => {
  const config = loadNodeConfig(syntheticEnv, "test");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 0);
  assert.equal(config.publicOrigin, origin);
  assert.equal(config.sqlitePath, ":memory:");
  assert.equal(config.schedulerEnabled, false);
  assert.equal(
    loadNodeConfig({ ...syntheticEnv, NODE_SCHEDULER_ENABLED: "true" }, "test")
      .schedulerEnabled,
    true,
  );
  assert.equal(config.env.INSTANT_APP_ID, syntheticEnv.INSTANT_APP_ID);
  assert.equal(config.env.CREDS_ENC_KEY, syntheticEnv.CREDS_ENC_KEY);
  assert.equal(config.env.APPLE_MAPS_TEAM_ID, undefined);
});
test("invalid config fails clearly without printing secret values", () => {
  assert.throws(
    () =>
      loadNodeConfig({
        ...syntheticEnv,
        CREDS_ENC_KEY: "sensitive-invalid-key",
      }),
    (error) =>
      error.message.includes("CREDS_ENC_KEY") &&
      !error.message.includes("sensitive-invalid-key"),
  );
  assert.throws(
    () => loadNodeConfig({ ...syntheticEnv, INSTANT_ADMIN_TOKEN: "" }),
    /INSTANT_ADMIN_TOKEN/,
  );
  assert.throws(
    () => loadNodeConfig({ ...syntheticEnv, INSTANT_APP_ID: "" }),
    /INSTANT_APP_ID/,
  );
  assert.throws(
    () => loadNodeConfig(syntheticEnv),
    /NODE_PORT must be nonzero/,
  );
  assert.throws(
    () => loadNodeConfig({ ...syntheticEnv, NODE_PORT: "8788" }),
    /persistent BUZZKEY_SQLITE_PATH required/,
  );
  assert.throws(
    () =>
      loadNodeConfig(
        {
          ...syntheticEnv,
          NODE_PORT: "8788",
          BUZZKEY_SQLITE_PATH: "/tmp/test.db",
          NODE_PUBLIC_ORIGIN: "http://buzzkey.test",
        },
        "production",
      ),
    /NODE_PUBLIC_ORIGIN/,
  );
});
test("scheduler starts at one-minute cadence and never overlaps ticks", async () => {
  const clock = fakeClock(),
    pending = deferred();
  let polls = 0,
    climates = 0;
  const scheduler = createNodeScheduler(
    {
      poll: () => {
        polls++;
        return polls === 1 ? pending.promise : Promise.resolve();
      },
      climate: async () => {
        climates++;
      },
    },
    { clock },
  );
  scheduler.start();
  assert.equal(clock.interval, POLL_INTERVAL_MS);
  assert.equal(polls, 0);
  clock.fire();
  await settle();
  clock.fire();
  await settle();
  assert.equal(polls, 1);
  assert.equal(climates, 1);
  pending.resolve();
  await settle();
  clock.fire();
  await settle();
  assert.equal(polls, 2);
  assert.equal(climates, 2);
  await scheduler.stop();
});
test("scheduler reports a failed job and continues on the next tick", async () => {
  const clock = fakeClock(),
    errors = [];
  let polls = 0;
  const scheduler = createNodeScheduler(
    {
      poll: async () => {
        polls++;
        if (polls === 1) throw new Error("synthetic poll failure");
      },
      climate: () => Promise.resolve(),
    },
    { clock, onError: (job, error) => errors.push({ job, error }) },
  );
  scheduler.start();
  clock.fire();
  await settle();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].job, "poll");
  clock.fire();
  await settle();
  assert.equal(polls, 2);
  await scheduler.stop();
});
test("scheduler stop clears timer, blocks new ticks, and awaits active work", async () => {
  const clock = fakeClock(),
    pending = deferred();
  let polls = 0;
  const scheduler = createNodeScheduler(
    {
      poll: () => {
        polls++;
        return pending.promise;
      },
      climate: () => Promise.resolve(),
    },
    { clock },
  );
  scheduler.start();
  clock.fire();
  await settle();
  let stopped = false;
  const stopping = scheduler.stop().then(() => {
    stopped = true;
  });
  assert.equal(clock.cleared, true);
  clock.fire();
  await settle();
  assert.equal(polls, 1);
  assert.equal(stopped, false);
  pending.resolve();
  await stopping;
  assert.equal(stopped, true);
});
test("Node server starts; health and unknown paths are safe", async () => {
  const mocks = fakeServices();
  const runtime = createNodeRuntime(
    loadNodeConfig(syntheticEnv, "test"),
    mocks.services,
  );
  const { port } = await runtime.start();
  try {
    const health = await localRequest(port, "/health");
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.text), { status: "ok" });
    assert.doesNotMatch(health.text, /synthetic-admin-token|CREDS_ENC_KEY/);
    assert.equal((await localRequest(port, "/missing")).status, 401);
    assert.equal(
      (
        await localRequest(port, "/missing", {
          authorization: signedRequest({ target: "/missing" }).request
            .authorization,
        })
      ).status,
      404,
    );
    assert.equal(mocks.verifications, 0);
  } finally {
    await runtime.stop();
  }
  await assert.rejects(localRequest(port, "/health"));
});
test("Node runtime arms the scheduler only after listening and disarms it on stop", async () => {
  const clock = fakeClock();
  const config = {
    ...loadNodeConfig(syntheticEnv, "test"),
    schedulerEnabled: true,
  };
  const mocks = fakeServices();
  let polls = 0;
  mocks.services.poll = async () => {
    polls++;
  };
  const runtime = createNodeRuntime(config, mocks.services, { clock });
  assert.equal(clock.interval, undefined);
  const { port } = await runtime.start();
  assert.equal((await localRequest(port, "/health")).status, 200);
  assert.equal(clock.interval, POLL_INTERVAL_MS);
  clock.fire();
  await settle();
  assert.equal(polls, 1);
  await runtime.stop();
  assert.equal(clock.cleared, true);
  clock.fire();
  await settle();
  assert.equal(polls, 1);
});
test("known oRPC request routes through the real router with mock identity", async () => {
  const mocks = fakeServices();
  const runtime = createNodeRuntime(
    loadNodeConfig(syntheticEnv, "test"),
    mocks.services,
  );
  const { port } = await runtime.start();
  try {
    const response = await localRequest(port, "/rpc/vehicle/parkedMapUrl", {
      method: "POST",
      token: "synthetic-guest-token",
      body: { lat: 41, lng: -87, widthPt: 300, heightPt: 200, dark: false },
    });
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(JSON.parse(response.text), { json: { url: null } });
    assert.equal(mocks.verifications, 1);
  } finally {
    await runtime.stop();
  }
});
test("invalid guest token cannot use the protected RPC procedure", async () => {
  const mocks = fakeServices();
  const runtime = createNodeRuntime(
    loadNodeConfig(syntheticEnv, "test"),
    mocks.services,
  );
  const { port } = await runtime.start();
  try {
    const response = await localRequest(port, "/rpc/vehicle/parkedMapUrl", {
      method: "POST",
      token: "invalid-synthetic-token",
      body: { lat: 41, lng: -87, widthPt: 300, heightPt: 200, dark: false },
    });
    assert.equal(response.status, 401);
    assert.equal(mocks.verifications, 1);
  } finally {
    await runtime.stop();
  }
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`${signal} initiates clean shutdown`, async () => {
    const source = new EventEmitter(),
      called = deferred(),
      codes = [];
    const remove = installShutdownSignals(
      async () => called.resolve(),
      source,
      (code) => codes.push(code),
    );
    source.emit(signal);
    await called.promise;
    await settle();
    assert.deepEqual(codes, [0]);
    remove();
    assert.equal(source.listenerCount("SIGTERM"), 0);
    assert.equal(source.listenerCount("SIGINT"), 0);
  });
}
test("unexpected fetch is rejected by the offline harness", async () => {
  await assert.rejects(
    globalThis.fetch("https://example.invalid/unclaimed"),
    /Unexpected network request/,
  );
});
