import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers";
import { VehicleRepository } from "../../storage/repositories.ts";
import {
  API,
  json,
  KEY,
  KEY2,
  mint,
  NOW,
  observation,
  offline,
  ready,
  route,
  terminal,
  UUID,
} from "./control-fixture.mjs";

const wake = (response) => [
  ...mint(),
  route(
    "POST",
    `${API}/rvs/v1/vehicle/${UUID}/refresh`,
    response ?? json({ data: { result: 0 } }),
    (init) => {
      assert.equal(init.body, undefined);
    },
  ),
];
const request = (vehicle) => ({
  vehicleId: vehicle.id,
  action: "wake",
  idempotencyKey: KEY,
});
test("wake acknowledgement with stale vehicle data stays timed out; normal mobile reads stay cache-only", async (t) => {
  const { f, vehicle } = await ready(t);
  await offline(
    [...wake(), ...observation("chargingHVBattery", 80, NOW - 60000)],
    async () => {
      await f.client.requestControl(request(vehicle));
      const c = await terminal(f);
      assert.equal(c.status, "timed_out");
      assert.equal(c.acceptedAt, NOW);
      assert.equal(c.observation.vehicleDataFresh, false);
      await f.client.vehicles();
      await f.client.current(vehicle.id);
    },
  );
});
test("wake fresh subsequent RVS observation confirms fresh data without claiming causality", async (t) => {
  const { f, vehicle } = await ready(t);
  await offline([...wake(), ...observation()], async (calls) => {
    await f.client.requestControl(request(vehicle));
    const c = await terminal(f);
    assert.equal(c.status, "confirmed");
    assert.equal(c.evidenceBasis, "wake_freshness");
    assert.equal(c.observation.vehicleDataFresh, true);
    assert.equal((await f.client.requestControl(request(vehicle))).id, c.id);
    assert.equal(calls.filter((c) => c.url.endsWith("/refresh")).length, 1);
  });
});
test("wake 401 triggers existing forced-login attempt; failed login still reads cloud status", async (t) => {
  const { f, vehicle } = await ready(t);
  await offline(
    [
      ...wake(json({}, 401)),
      route(
        "GET",
        (url) =>
          assert.equal(url.startsWith(`${API}/oidc/v1/authorize?`), true),
        json({}, 503),
      ),
      ...observation("chargingHVBattery", 80, NOW - 1000),
    ],
    async () => {
      await f.client.requestControl(request(vehicle));
      const c = await terminal(f);
      assert.equal(c.status, "unknown");
      assert.equal(c.acceptedAt, null);
      assert.equal(c.observation.vehicleDataFresh, false);
    },
  );
});
test("wake application deadline fences late acknowledgement and observed writes", async (t) => {
  const { f, vehicle } = await ready(t, { deadlineMs: 200 });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let entered;
  const submitted = new Promise((resolve) => {
    entered = resolve;
  });
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  await offline(
    wake(async () => {
      entered();
      await blocked;
      return json({ data: { result: 0 } });
    }),
    async () => {
      await f.client.requestControl(request(vehicle));
      await submitted;
      t.mock.timers.tick(200);
      t.mock.timers.reset();
      assert.equal((await terminal(f)).status, "unknown");
      release();
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(
        new VehicleRepository(f.storage).getCurrentState(vehicle.id),
        null,
      );
    },
  );
});
test("wake accepted restart performs status reads only, never repeated wake", async (t) => {
  const { f, vehicle, accountId } = await ready(t);
  const c = f.services.commands.repository.intent(
    request(vehicle),
    accountId,
    f.device.id,
    f.device.pubkey,
    NOW,
  ).command;
  f.services.commands.repository.update(c.id, {
    status: "accepted",
    submittedAt: NOW,
    acceptedAt: NOW,
    stage: "wake",
  });
  await f.restart();
  await offline(observation(), async (calls) => {
    await f.client.reconcileCommand(c.id);
    assert.equal((await terminal(f)).status, "confirmed");
    assert.equal(
      calls.some((c) => c.url.endsWith("/refresh")),
      false,
    );
  });
});
test("wake foreign vehicle, strict input and revocation fail before VW", async (t) => {
  const { f, vehicle } = await ready(t);
  await offline([], async () => {
    await assert.rejects(
      f.client.requestControl({ ...request(vehicle), vehicleId: KEY2 }),
    );
    await assert.rejects(
      f.client.requestControl({ ...request(vehicle), faceIdVerified: true }),
    );
    f.devices.revoke(f.device.id, Date.now());
    await assert.rejects(
      f.client.requestControl(request(vehicle)),
      (e) => e.code === "authorization_rejected",
    );
  });
});

test("all old Node control aliases are retired after authentication with no VW requests", async (t) => {
  const { f } = await ready(t);
  const { signNip98 } = await import("../../../app/src/nip98.ts");
  await offline([], async () => {
    for (const action of [
      "chargeStart",
      "chargeStop",
      "setChargeLimit",
      "climateStart",
      "climateStop",
      "climateInfo",
      "refresh",
    ]) {
      const url = `https://buzzkey.example.invalid/rpc/vehicle/${action}`;
      const body = "{}";
      const { authorization } = await signNip98({
        url,
        method: "POST",
        body,
        material: f.material,
      });
      assert.equal(
        (await f.raw(url, { method: "POST", body, headers: { authorization } }))
          .status,
        404,
      );
    }
  });
});
