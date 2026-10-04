import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers";
import { VehicleRepository } from "../../storage/repositories.ts";
import { applyCampResult, prepareCamp } from "../camp.ts";
import {
  API,
  CID,
  climate,
  climateOp,
  history,
  json,
  KEY,
  KEY2,
  mint,
  NOW,
  observation,
  offline,
  ready,
  route,
  settings,
  settingsPath,
  terminal,
  UUID,
} from "./control-fixture.mjs";

const request = (vehicle) => ({
  vehicleId: vehicle.id,
  action: "climate_start",
  tempF: 72,
  durationMin: 60,
  idempotencyKey: KEY,
});
async function start(t) {
  const r = await ready(t);
  const { f, vehicle } = r;
  await offline(
    [
      ...mint(),
      climate(false),
      ...mint(),
      climateOp("start"),
      history(),
      ...observation(),
      climate(true),
      settings(),
    ],
    async () => {
      await f.client.requestControl(request(vehicle));
      await terminal(f);
    },
  );
  return r;
}
const row = (f) => f.storage.db.prepare("SELECT * FROM climate_sessions").get();
test("Camp Mode intent and session persist before VW submission and survive Node restart", async (t) => {
  const { f, vehicle } = await start(t);
  assert.equal(row(f).control_state, "active");
  const saved = row(f);
  await f.restart();
  await offline([], async () => {
    const cached = await f.client.camp(vehicle.id);
    assert.equal(cached.session.id, saved.id);
    assert.equal(cached.session.controlState, "active");
    assert.equal(cached.schedulerEnabled, false);
    assert.equal(
      (await f.client.requestControl(request(vehicle))).id,
      saved.command_id,
    );
  });
});
test("same-temperature duration adjustment is a durable local reschedule with no VW command", async (t) => {
  const { f, vehicle } = await start(t);
  const original = row(f);
  await offline([], async () => {
    await f.client.requestControl({
      ...request(vehicle),
      durationMin: 90,
      idempotencyKey: KEY2,
    });
    const result = await terminal(f, KEY2);
    assert.equal(result.status, "confirmed");
    assert.equal(result.evidenceBasis, "local_schedule");
    assert.equal(row(f).id, original.id);
    assert.equal(row(f).expires_at, NOW + 90 * 60000);
  });
});
test("phone-independent Camp tick waits for observed stop and restarts once with persisted cycle", async (t) => {
  const { f, vehicle } = await start(t);
  const end = row(f).expires_at;
  const vehicles = new VehicleRepository(f.storage);
  const before = vehicles.getCurrentState(vehicle.id).state;
  before.freshness.fetchedAt = NOW - 300000;
  vehicles.saveState(vehicle.id, before, NOW);
  await offline([climate(true)], () => f.services.climate());
  const after = vehicles.getCurrentState(vehicle.id).state;
  assert.equal(after.freshness.fetchedAt, NOW - 300000);
  assert.deepEqual(after.freshness, before.freshness);
  assert.equal(after.climate.fetchedAt, NOW);
  assert.equal(row(f).remaining_min, 25);
  await offline(
    [
      climate(false),
      ...mint(),
      climate(false),
      ...mint(),
      climateOp("start"),
      history(),
      ...observation(),
      climate(true),
      settings(),
    ],
    async (calls) => {
      await f.services.climate();
      assert.equal(
        calls.filter((c) => c.url.endsWith("/pretripclimate/start")).length,
        1,
      );
      assert.equal(row(f).cycle, 1);
      assert.equal(row(f).expires_at, end);
      assert.equal(row(f).control_state, "active");
    },
  );
  await f.restart();
  await offline([climate(true)], () => f.services.climate());
  assert.equal(row(f).cycle, 1);
});
test("Camp expiry issues one durable stop and never restarts", async (t) => {
  const { f, vehicle } = await start(t);
  f.storage.db.prepare("UPDATE climate_sessions SET expires_at=?").run(NOW - 1);
  await offline(
    [
      ...mint(),
      climateOp("stop"),
      history(),
      ...observation(),
      climate(false),
      settings(),
    ],
    () => f.services.climate(),
  );
  assert.equal(row(f).state, "expired");
  assert.equal(row(f).control_state, "expired");
  await f.restart();
  await offline([], () => f.services.climate());
  assert.equal((await f.client.camp(vehicle.id)).session.state, "expired");
});
test("paused Camp stops locally and never falsely changes physical observed climate", async (t) => {
  const { f, vehicle } = await start(t);
  f.storage.db
    .prepare(
      "UPDATE climate_sessions SET control_state='paused',paused_at=?,error='ignition_on'",
    )
    .run(NOW);
  await offline([], async () => {
    await f.client.requestControl({
      vehicleId: vehicle.id,
      action: "climate_stop",
      idempotencyKey: KEY2,
    });
    const result = await terminal(f, KEY2);
    assert.equal(result.evidenceBasis, "local_schedule");
    assert.equal(row(f).state, "stopped");
    assert.equal(result.observation, null);
  });
});
test("ignition rejection pauses Camp and pause suppresses repeated starts until fallback/parking", async (t) => {
  const { f, vehicle, accountId } = await ready(t);
  const c = f.services.commands.repository.intent(
    request(vehicle),
    accountId,
    f.device.id,
    f.device.pubkey,
    NOW,
    (cmd) => prepareCamp(f.storage, cmd, NOW),
  ).command;
  const failed = f.services.commands.repository.update(c.id, {
    status: "failed",
    failureCode: "ignition_on",
  });
  applyCampResult(f.storage, failed, NOW);
  assert.equal(row(f).control_state, "paused");
  await offline([], () => f.services.climate());
});
test("uncertain accepted command is reconciled after restart with reads only, never another start", async (t) => {
  const { f, vehicle, accountId } = await ready(t);
  const c = f.services.commands.repository.intent(
    request(vehicle),
    accountId,
    f.device.id,
    f.device.pubkey,
    NOW,
    (cmd) => prepareCamp(f.storage, cmd, NOW),
  ).command;
  f.services.commands.repository.update(c.id, {
    status: "accepted",
    submittedAt: NOW,
    acceptedAt: NOW,
    correlationId: CID,
    stage: "climate_start",
  });
  await f.restart();
  await offline(
    [history(), ...observation(), climate(true), settings()],
    async (calls) => {
      await f.services.climate();
      assert.equal(row(f).control_state, "active");
      assert.equal(
        calls.some((c) => c.url.endsWith("/start")),
        false,
      );
    },
  );
});
test("Camp scheduler overlap coalesces and ambiguous off status cannot trigger restart", async (t) => {
  const { f } = await start(t);
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  await offline(
    [
      route(
        "GET",
        `${API}/ev/v1/user/synthetic-user-id/vehicle/${UUID}/summary?tempUnit=fahrenheit`,
        async () => {
          await blocked;
          return json({ data: {} });
        },
      ),
    ],
    async (calls) => {
      const first = f.services.climate();
      await new Promise((resolve) => setTimeout(resolve, 5));
      await f.services.climate();
      release();
      await first;
      assert.equal(calls.length, 1);
      assert.equal(row(f).control_state, "unknown");
    },
  );
});
test("revoked device prevents continuing Camp mutations and retains session evidence", async (t) => {
  const { f } = await start(t);
  f.devices.revoke(f.device.id, Date.now());
  await offline([], () => f.services.climate());
  assert.equal(row(f).control_state, "paused");
  assert.equal(row(f).error, "account_or_device_unavailable");
});

test("actual ignition rejection pauses Camp until the preserved ten-minute retry fallback", async (t) => {
  let elapsed = 0;
  const { f, vehicle } = await ready(t, { now: () => NOW + elapsed });
  await offline(
    [
      ...mint(),
      climate(false),
      ...mint(),
      climateOp("start"),
      route(
        "GET",
        `${API}/history/v1/vehicle/${UUID}/correlationId/${CID}/ro/`,
        json({
          data: {
            responseBody: JSON.stringify({
              eventStatus: { responseOutcome: 3 },
              payloadString: JSON.stringify({
                data: { cause: "ignition is on" },
              }),
            }),
          },
        }),
      ),
      ...observation(),
      climate(false),
      settings(),
    ],
    async () => {
      await f.client.requestControl(request(vehicle));
      const done = await terminal(f);
      assert.equal(done.failureCode, "ignition_on");
      assert.equal(row(f).control_state, "paused");
    },
  );
  await f.restart();
  await offline([], () => f.services.climate());
  elapsed = 600001;
  await offline(
    [
      climate(false),
      ...mint(),
      climate(false),
      ...mint(),
      climateOp("start"),
      history(),
      ...observation(),
      climate(true),
      settings(),
    ],
    () => f.services.climate(),
  );
  assert.equal(row(f).control_state, "active");
  assert.equal(row(f).cycle, 1);
});
test("explicit busy refusal defers Camp and only an observed off state permits another cycle", async (t) => {
  const { f, vehicle } = await ready(t);
  await offline(
    [
      ...mint(),
      climate(false),
      ...mint(),
      climateOp("start", () =>
        json({ error: { errorCode: "EV_THRESHOLD_EXCEEDED" } }, 429),
      ),
      ...mint(),
      climateOp("start", () =>
        json({ error: { errorCode: "EV_THRESHOLD_EXCEEDED" } }, 429),
      ),
      ...mint(),
      climateOp("start", () =>
        json({ error: { errorCode: "EV_THRESHOLD_EXCEEDED" } }, 429),
      ),
    ],
    async () => {
      await f.client.requestControl(request(vehicle));
      const done = await terminal(f);
      assert.equal(done.status, "failed");
      assert.equal(done.failureCode, "vehicle_busy");
      assert.equal(row(f).control_state, "waiting_for_restart");
    },
  );
  await offline(
    [
      climate(false),
      ...mint(),
      climate(false),
      ...mint(),
      climateOp("start"),
      history(),
      ...observation(),
      climate(true),
      settings(),
    ],
    () => f.services.climate(),
  );
  assert.equal(row(f).control_state, "active");
});
test("confirmed standalone setting updates persisted Camp target without fabricating climate active", async (t) => {
  const { f, vehicle } = await start(t);
  const expires = row(f).expires_at;
  await offline(
    [
      ...mint(),
      climate(false, 72),
      ...mint(),
      settings(72),
      route(
        "PUT",
        settingsPath,
        json({ data: { result: 0, correlationId: CID } }),
      ),
      history(),
      ...observation(),
      climate(false, 74),
      settings(74),
    ],
    async () => {
      await f.client.requestControl({
        vehicleId: vehicle.id,
        action: "climate_temperature",
        tempF: 74,
        idempotencyKey: KEY2,
      });
      assert.equal((await terminal(f, KEY2)).status, "confirmed");
    },
  );
  assert.equal(row(f).temp_f, 74);
  assert.equal(row(f).expires_at, expires);
  assert.equal(row(f).control_state, "waiting_for_restart");
  await f.restart();
  await offline(
    [
      climate(false, 74),
      ...mint(),
      climate(false, 74),
      ...mint(),
      climateOp("start"),
      history(),
      ...observation(),
      climate(true, 74),
      settings(74),
    ],
    () => f.services.climate(),
  );
  assert.equal(row(f).temp_f, 74);
  assert.equal(row(f).control_state, "active");
});
