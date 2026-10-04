import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers";
import { signNip98 } from "../../../app/src/nip98.ts";
import { VehicleRepository } from "../../storage/repositories.ts";
import {
  ev,
  history,
  input,
  json,
  KEY,
  KEY2,
  losingClient,
  NOW,
  observation,
  offline,
  origin,
  ready,
  terminal,
} from "./control-fixture.mjs";

for (const action of ["charge_start", "charge_stop", "charge_target"]) {
  test(`${action}: accepted command requires fresh matching observation, persisted across restart`, async (t) => {
    const { f, vehicle } = await ready(t);
    await offline(
      [
        ...ev(action),
        history(),
        ...observation(
          action === "charge_stop" ? "notCharging" : "chargingHVBattery",
        ),
      ],
      async () => {
        const pending = await f.client.requestControl(input(vehicle, action));
        assert.equal(pending.status, "requested");
        assert.equal(
          new VehicleRepository(f.storage).getCurrentState(vehicle.id),
          null,
        );
        const done = await terminal(f);
        assert.equal(done.status, "confirmed");
        assert.equal(done.observation.targetSoc, 80);
        await f.restart();
        assert.deepEqual(await f.client.commandByKey(KEY), done);
      },
    );
  });
  test(`${action}: acceptance/history success never replaces conflicting observed state`, async (t) => {
    const { f, vehicle } = await ready(t);
    await offline(
      [
        ...ev(action),
        history(),
        ...observation(
          action === "charge_start" ? "notCharging" : "chargingHVBattery",
          70,
        ),
      ],
      async () => {
        await f.client.requestControl(input(vehicle, action));
        const done = await terminal(f);
        assert.equal(done.status, "timed_out");
        const state = new VehicleRepository(f.storage).getCurrentState(
          vehicle.id,
        ).state;
        assert.equal(state.battery.targetSocPercent, 70);
        if (action === "charge_start")
          assert.equal(state.battery.charging, "not_charging");
      },
    );
  });
  test(`${action}: explicit rejection persists failed without observed mutation`, async (t) => {
    const { f, vehicle } = await ready(t);
    await offline(ev(action, json({ data: { result: 7 } })), async () => {
      await f.client.requestControl(input(vehicle, action));
      assert.equal((await terminal(f)).status, "failed");
      assert.equal(
        new VehicleRepository(f.storage).getCurrentState(vehicle.id),
        null,
      );
    });
  });
}
test("charging duplicate/lost-response/new-signature retry and conflicting target preserve durable identity", async (t) => {
  const { f, vehicle } = await ready(t);
  await offline(
    [...ev("charge_target"), history(), ...observation()],
    async (calls) => {
      const first = await f.client.requestControl(
        input(vehicle, "charge_target"),
      );
      await terminal(f);
      const retry = await f.client.requestControl(
        input(vehicle, "charge_target"),
      );
      assert.equal(first.id, retry.id);
      await assert.rejects(
        f.client.requestControl({
          ...input(vehicle, "charge_target"),
          targetSoc: 90,
        }),
        (e) => e.code === "command_conflict",
      );
      assert.equal(calls.filter((c) => c.method === "PUT").length, 1);
    },
  );
});
test("charging invalid target, foreign vehicle, anonymous/revoked/replay controls fail before VW", async (t) => {
  const { f, vehicle } = await ready(t);
  await offline([], async () => {
    assert.equal(
      (await f.raw(origin + "/api/v1/commands", { method: "POST", body: "{}" }))
        .status,
      401,
    );
    for (const targetSoc of [49, 55, 110])
      await assert.rejects(
        f.client.requestControl({
          ...input(vehicle, "charge_target"),
          targetSoc,
        }),
      );
    await assert.rejects(
      f.client.requestControl({
        ...input(vehicle, "charge_start"),
        vehicleId: KEY2,
      }),
    );
    const body = JSON.stringify({
      ...input(vehicle, "charge_target"),
      targetSoc: 49,
    });
    const { authorization } = await signNip98({
      url: origin + "/api/v1/commands",
      method: "POST",
      body,
      material: f.material,
    });
    assert.equal(
      (
        await f.raw(origin + "/api/v1/commands", {
          method: "POST",
          body,
          headers: { authorization },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.raw(origin + "/api/v1/commands", {
          method: "POST",
          body,
          headers: { authorization },
        })
      ).status,
      401,
    );
    f.devices.revoke(f.device.id, Date.now());
    await assert.rejects(
      f.client.requestControl(input(vehicle, "charge_start")),
      (e) => e.code === "authorization_rejected",
    );
  });
});
test("charging ambiguous transport and stale/unknown observation never confirm", async (t) => {
  for (const response of [
    () => {
      throw Error("synthetic transport failure");
    },
    json({ data: { result: 0 } }),
  ]) {
    const { f, vehicle } = await ready(t);
    await offline(ev("charge_start", response), async () => {
      await f.client.requestControl(input(vehicle, "charge_start"));
      assert.equal((await terminal(f)).status, "unknown");
    });
  }
  const { f, vehicle } = await ready(t);
  await offline(
    [
      ...ev("charge_start"),
      history(),
      ...observation("unexpected", 80, NOW - 10000),
    ],
    async () => {
      await f.client.requestControl(input(vehicle, "charge_start"));
      const c = await terminal(f);
      assert.equal(c.status, "timed_out");
      assert.equal(c.observation.charging, "unknown");
    },
  );
});

test("charging accepted crash recovery reconciles without resubmitting", async (t) => {
  const { f, vehicle, accountId } = await ready(t);
  const c = f.services.commands.repository.intent(
    input(vehicle, "charge_start"),
    accountId,
    f.device.id,
    f.device.pubkey,
    NOW,
  ).command;
  f.services.commands.repository.update(c.id, {
    status: "accepted",
    submittedAt: NOW,
    acceptedAt: NOW,
    correlationId: "synthetic-control-correlation",
  });
  await f.restart();
  await offline([history(), ...observation()], async (calls) => {
    assert.equal(
      (await f.client.requestControl(input(vehicle, "charge_start"))).status,
      "waiting_for_vehicle",
    );
    await f.client.reconcileCommand(c.id);
    assert.equal((await terminal(f)).status, "confirmed");
    assert.equal(
      calls.some((c) => c.method === "POST" || c.method === "PUT"),
      false,
    );
  });
});
test("charging busy refusal retains three fresh-token retries without transport retries", async (t) => {
  const { f, vehicle } = await ready(t);
  const busy = () =>
    json({ error: { errorCode: "EV_THRESHOLD_EXCEEDED" } }, 429);
  await offline(
    [
      ...ev("charge_start", busy),
      ...ev("charge_start", busy),
      ...ev("charge_start"),
      history(),
      ...observation(),
    ],
    async (calls) => {
      await f.client.requestControl(input(vehicle, "charge_start"));
      assert.equal((await terminal(f)).status, "confirmed");
      assert.equal(
        calls.filter((c) => c.url.endsWith("/charging/start")).length,
        3,
      );
    },
  );
});
test("charging application deadline keeps uncertain result after a late acceptance", async (t) => {
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
    ev("charge_start", async () => {
      entered();
      await blocked;
      return json({
        data: { result: 0, correlationId: "synthetic-control-correlation" },
      });
    }),
    async () => {
      await f.client.requestControl(input(vehicle, "charge_start"));
      await submitted;
      t.mock.timers.tick(200);
      t.mock.timers.reset();
      const c = await terminal(f);
      assert.equal(c.status, "unknown");
      release();
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal((await f.client.commandByKey(KEY)).status, "unknown");
      assert.equal(
        new VehicleRepository(f.storage).getCurrentState(vehicle.id),
        null,
      );
    },
  );
});

test("charging lost mobile response and app/Node restart reuse the saved intent without another mutation", async (t) => {
  const { f, vehicle } = await ready(t);
  await offline(
    [...ev("charge_start"), history(), ...observation()],
    async (calls) => {
      await assert.rejects(
        losingClient(f).requestControl(input(vehicle, "charge_start")),
        (e) => e.code === "backend_unreachable",
      );
      const saved = await terminal(f);
      await f.restart();
      assert.equal(
        (await f.client.requestControl(input(vehicle, "charge_start"))).id,
        saved.id,
      );
      assert.equal(
        calls.filter((c) => c.url.endsWith("/charging/start")).length,
        1,
      );
    },
  );
});
