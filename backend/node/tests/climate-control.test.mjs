import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers";
import { VehicleRepository } from "../../storage/repositories.ts";
import {
  API,
  CID,
  history,
  json,
  KEY,
  KEY2,
  losingClient,
  mint,
  NOW,
  observation,
  offline,
  ready,
  route,
  terminal,
  UUID,
} from "./control-fixture.mjs";

export const settingsPath = `${API}/ev/v1/vehicle/${UUID}/pretripclimate/settings?tempUnit=fahrenheit`;
export const climate = (on = false, tempF = 72, remainingMin = on ? 25 : 0) =>
  route(
    "GET",
    `${API}/ev/v1/user/synthetic-user-id/vehicle/${UUID}/summary?tempUnit=fahrenheit`,
    json({
      data: {
        climateStatus: {
          climateStatusReport: {
            climateStatusInd: on ? "on" : "off",
            remainingClimatizationTimeMin: remainingMin,
          },
          climateSettings: { targetTemperature: { temperature: tempF } },
        },
      },
    }),
  );
export const settings = (tempF = 72) =>
  route(
    "GET",
    settingsPath,
    json({ data: { targetTemperature: { temperature: tempF } } }),
  );
export const op = (
  action,
  response = json({ data: { result: 0, correlationId: CID } }),
) =>
  route(
    "POST",
    `${API}/ev/v1/vehicle/${UUID}/pretripclimate/${action}`,
    response,
  );
const request = (vehicle, action, extra = {}) => ({
  vehicleId: vehicle.id,
  action,
  idempotencyKey: KEY,
  ...extra,
});
for (const action of ["climate_start", "climate_stop"]) {
  test(`${action}: accepted/observed confirmation and durable restart`, async (t) => {
    const { f, vehicle } = await ready(t);
    const steps =
      action === "climate_start"
        ? [...mint(), climate(false), ...mint(), op("start")]
        : [...mint(), op("stop")];
    await offline(
      [
        ...steps,
        history(),
        ...observation(),
        climate(action === "climate_start"),
        settings(),
      ],
      async () => {
        await f.client.requestControl(
          request(
            vehicle,
            action,
            action === "climate_start" ? { tempF: 72, durationMin: 30 } : {},
          ),
        );
        const done = await terminal(f);
        assert.equal(done.status, "confirmed");
        assert.equal(
          done.observation.climate,
          action === "climate_start" ? "active" : "inactive",
        );
        assert.equal(
          new VehicleRepository(f.storage).getCurrentState(vehicle.id).state
            .climate.activity,
          done.observation.climate,
        );
        await f.restart();
        assert.deepEqual(await f.client.commandByKey(KEY), done);
      },
    );
  });
  test(`${action}: conflicting observation remains timed out, never intent`, async (t) => {
    const { f, vehicle } = await ready(t);
    const steps =
      action === "climate_start"
        ? [...mint(), climate(false), ...mint(), op("start")]
        : [...mint(), op("stop")];
    await offline(
      [
        ...steps,
        history(),
        ...observation(),
        climate(action !== "climate_start"),
        settings(),
      ],
      async () => {
        await f.client.requestControl(
          request(
            vehicle,
            action,
            action === "climate_start" ? { tempF: 72, durationMin: 30 } : {},
          ),
        );
        assert.equal((await terminal(f)).status, "timed_out");
      },
    );
  });
  test(`${action}: explicit rejection is failed without physical state fabrication`, async (t) => {
    const { f, vehicle } = await ready(t);
    await offline(
      [
        ...(action === "climate_start" ? [...mint(), climate(false)] : []),
        ...mint(),
        op(
          action === "climate_start" ? "start" : "stop",
          json({ data: { result: 9 } }),
        ),
      ],
      async () => {
        await f.client.requestControl(
          request(
            vehicle,
            action,
            action === "climate_start" ? { tempF: 72, durationMin: 30 } : {},
          ),
        );
        assert.equal((await terminal(f)).status, "failed");
        assert.equal(
          new VehicleRepository(f.storage).getCurrentState(vehicle.id),
          null,
        );
      },
    );
  });
}
test("climate target preserves settings GET 503 default PUT quirk but confirms only subsequent authoritative setting", async (t) => {
  const { f, vehicle } = await ready(t);
  await offline(
    [
      ...mint(),
      climate(false, 68),
      ...mint(),
      route("GET", settingsPath, json({}, 503)),
      route(
        "PUT",
        settingsPath,
        json({ data: { result: 0, correlationId: CID } }),
        (init) => {
          const body = JSON.parse(init.body);
          assert.equal(body.targetTemperature.temperature, 72);
          assert.equal(
            body.climatizationElementSettings.climatizationAtUnlock,
            true,
          );
        },
      ),
      history(),
      ...observation(),
      climate(false, 72),
      settings(72),
    ],
    async () => {
      await f.client.requestControl(
        request(vehicle, "climate_temperature", { tempF: 72 }),
      );
      const c = await terminal(f);
      assert.equal(c.status, "confirmed");
      assert.equal(c.evidenceBasis, "settings_read");
      await assert.rejects(
        f.client.requestControl(
          request(vehicle, "climate_temperature", { tempF: 74 }),
        ),
        (e) => e.code === "command_conflict",
      );
    },
  );
});
test("already-running climate at requested temperature never reissues a start", async (t) => {
  const { f, vehicle } = await ready(t);
  await offline(
    [...mint(), climate(true), ...observation(), climate(true), settings()],
    async (calls) => {
      await f.client.requestControl(
        request(vehicle, "climate_start", { tempF: 72, durationMin: 30 }),
      );
      const c = await terminal(f);
      assert.equal(c.status, "confirmed");
      assert.equal(c.acceptedAt, null);
      assert.equal(
        calls.some((call) => call.url.endsWith("/start")),
        false,
      );
    },
  );
});
test("climate history unconfirmed/ambiguous off remains unknown rather than physical success", async (t) => {
  const { f, vehicle } = await ready(t, { historyAttempts: 1 });
  await offline(
    [
      ...mint(),
      op("stop"),
      history(1),
      ...observation(),
      climate(false, 72, null),
      settings(),
    ],
    async () => {
      await f.client.requestControl(request(vehicle, "climate_stop"));
      const c = await terminal(f);
      assert.equal(c.status, "timed_out");
      assert.equal(c.observation.climate, "unknown");
    },
  );
});
test("climate accepted restart reconciles reads only and idempotency rejects new temperature", async (t) => {
  const { f, vehicle, accountId } = await ready(t);
  const body = request(vehicle, "climate_start", {
    tempF: 72,
    durationMin: 30,
  });
  const c = f.services.commands.repository.intent(
    body,
    accountId,
    f.device.id,
    f.device.pubkey,
    NOW,
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
      const duplicate = await f.client.requestControl(body);
      assert.equal(duplicate.id, c.id);
      await f.client.reconcileCommand(c.id);
      assert.equal((await terminal(f)).status, "confirmed");
      assert.equal(
        calls.some(
          (call) => call.method === "PUT" || call.url.endsWith("/start"),
        ),
        false,
      );
    },
  );
});
test("climate invalid settings and revoked device never reach VW", async (t) => {
  const { f, vehicle } = await ready(t);
  await offline([], async () => {
    for (const tempF of [59, 86, NaN])
      await assert.rejects(
        f.client.requestControl(
          request(vehicle, "climate_temperature", { tempF }),
        ),
      );
    await assert.rejects(
      f.client.requestControl({
        ...request(vehicle, "climate_stop"),
        vehicleId: KEY2,
      }),
    );
    f.devices.revoke(f.device.id, Date.now());
    await assert.rejects(
      f.client.requestControl(
        request(vehicle, "climate_start", { tempF: 72, durationMin: 30 }),
      ),
      (e) => e.code === "authorization_rejected",
    );
  });
});

test("climate lost mobile response retries the original durable intent after restart without another start", async (t) => {
  const { f, vehicle } = await ready(t);
  const body = request(vehicle, "climate_start", {
    tempF: 72,
    durationMin: 30,
  });
  await offline(
    [
      ...mint(),
      climate(false),
      ...mint(),
      op("start"),
      history(),
      ...observation(),
      climate(true),
      settings(),
    ],
    async (calls) => {
      await assert.rejects(
        losingClient(f).requestControl(body),
        (e) => e.code === "backend_unreachable",
      );
      const saved = await terminal(f);
      await f.restart();
      assert.equal((await f.client.requestControl(body)).id, saved.id);
      assert.equal(
        calls.filter((c) => c.url.endsWith("/pretripclimate/start")).length,
        1,
      );
    },
  );
});
test("changing running climate waits for observed off, applies and reads setting before a new start", async (t) => {
  const { f, vehicle } = await ready(t);
  await offline(
    [
      ...mint(),
      climate(true, 68),
      ...mint(),
      op("stop"),
      ...mint(),
      climate(false, 68),
      ...mint(),
      settings(68),
      route(
        "PUT",
        settingsPath,
        json({ data: { result: 0, correlationId: CID } }),
      ),
      ...mint(),
      settings(72),
      ...mint(),
      op("start"),
      history(),
      ...observation(),
      climate(true),
      settings(),
    ],
    async (calls) => {
      await f.client.requestControl(
        request(vehicle, "climate_start", { tempF: 72, durationMin: 30 }),
      );
      assert.equal((await terminal(f)).status, "confirmed");
      assert.deepEqual(
        calls
          .filter(
            (c) =>
              c.method === "PUT" ||
              (c.method === "POST" && !c.url.endsWith("/session")),
          )
          .map((c) => c.method),
        ["POST", "PUT", "POST"],
      );
    },
  );
});
test("climate target conflict stays unconfirmed despite acknowledged setting mutation", async (t) => {
  const { f, vehicle } = await ready(t);
  await offline(
    [
      ...mint(),
      climate(false, 68),
      ...mint(),
      settings(68),
      route(
        "PUT",
        settingsPath,
        json({ data: { result: 0, correlationId: CID } }),
      ),
      history(),
      ...observation(),
      climate(false, 68),
      settings(68),
    ],
    async () => {
      await f.client.requestControl(
        request(vehicle, "climate_temperature", { tempF: 72 }),
      );
      const done = await terminal(f);
      assert.equal(done.status, "timed_out");
      assert.equal(done.observation.targetTempF, 68);
    },
  );
});
test("climate application deadline fences a late accepted mutation without fabricated observations", async (t) => {
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
    [
      ...mint(),
      op("stop", async () => {
        entered();
        await blocked;
        return json({ data: { result: 0, correlationId: CID } });
      }),
    ],
    async () => {
      await f.client.requestControl(request(vehicle, "climate_stop"));
      await submitted;
      t.mock.timers.tick(200);
      t.mock.timers.reset();
      const done = await terminal(f);
      assert.equal(done.status, "unknown");
      assert.equal(done.observation, null);
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(await f.client.commandByKey(KEY), done);
      assert.equal(
        new VehicleRepository(f.storage).getCurrentState(vehicle.id),
        null,
      );
    },
  );
});

test("interrupted multi-step climate start never borrows settings history for final start confirmation", async (t) => {
  const { f, vehicle } = await ready(t);
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  await offline(
    [
      ...mint(),
      climate(false, 68),
      ...mint(),
      settings(68),
      route(
        "PUT",
        settingsPath,
        json({ data: { result: 0, correlationId: CID } }),
      ),
      ...mint(),
      settings(72),
      ...mint(),
      op("start", async () => {
        await blocked;
        throw Error("synthetic lost start acknowledgement");
      }),
    ],
    async () => {
      await f.client.requestControl(
        request(vehicle, "climate_start", { tempF: 72, durationMin: 30 }),
      );
      for (let i = 0; i < 100; i++) {
        const current = f.storage.db
          .prepare("SELECT execution_stage FROM commands")
          .get();
        if (current.execution_stage === "climate_start") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const staged = f.storage.db.prepare("SELECT * FROM commands").get();
      assert.equal(staged.execution_stage, "climate_start");
      assert.equal(staged.correlation_id, null);
      release();
      assert.equal((await terminal(f)).status, "unknown");
    },
  );
  await f.restart();
  await offline(
    [...observation(), climate(true), settings()],
    async (calls) => {
      const c = await f.client.commandByKey(KEY);
      await f.client.reconcileCommand(c.id);
      const result = await terminal(f);
      assert.equal(result.status, "timed_out");
      assert.equal(result.historyConfirmed, null);
      assert.equal(
        calls.some(
          (c) =>
            c.url.includes("/history/") ||
            c.method === "POST" ||
            c.method === "PUT",
        ),
        false,
      );
    },
  );
});
