import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";
import { URL } from "node:url";
import {
  createVwAdapter,
  mapClimateState,
  mapVehicleIdentity,
  mapVehicleStatus,
} from "../src/vw/adapter.ts";
import {
  ACCESS,
  API,
  bearer,
  bodyJson,
  CARNET,
  ID_TOKEN,
  json,
  route,
  SPIN,
  UUID,
  VIN,
  withFetchQueue,
} from "./harness.mjs";

const fixture = (name) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  );
const identity = {
  localId: "synthetic-local-id",
  reference: UUID,
  vin: VIN,
  name: "Fixture Buzz",
  model: "Synthetic ID. Buzz",
};
const readRoutes = () => [
  route(
    "GET",
    `${API}/rvs/v1/vehicle/${UUID}`,
    json(fixture("rvs")),
    bearer(CARNET),
  ),
  route(
    "GET",
    `${API}/ev/v1/vehicle/${UUID}/charge/summary`,
    json(fixture("charge")),
    bearer(CARNET),
  ),
];
const makeAdapter = (now = () => 1_700_000_010_000) => {
  const access = {
    accessTokens: async () => ({ accessToken: ACCESS, idToken: ID_TOKEN }),
    readAuthorization: async (reference) => {
      assert.equal(reference, UUID);
      return CARNET;
    },
    commandAuthorization: async (reference) => {
      assert.equal(reference, UUID);
      return CARNET;
    },
    spin: async () => SPIN,
  };
  return createVwAdapter(access, now);
};
const accepted = () =>
  json({ data: { result: 0, correlationId: "synthetic-correlation-id" } });
const spinRoutes = () => [
  route(
    "GET",
    `${API}/ss/v1/user/synthetic-user-id/challenge`,
    json({
      data: { challenge: "synthetic-challenge", remainingTries: 8 },
    }),
    bearer(ACCESS),
  ),
  route(
    "POST",
    `${API}/ss/v1/user/synthetic-user-id/vehicle/${UUID}/session`,
    json({ data: { carnetVehicleToken: CARNET } }),
    bearer(ACCESS),
  ),
];

test("adapter discovery maps the existing garage into opaque vehicle identities", async () => {
  const vehicles = await withFetchQueue(
    [
      route(
        "GET",
        `${API}/account/v1/garage`,
        json(fixture("garage")),
        bearer(ACCESS),
      ),
    ],
    () => makeAdapter().discoverVehicles(),
  );
  assert.deepEqual(vehicles, [{ ...identity, localId: null }]);
});

test("adapter status maps battery, security, location and category freshness without climate inference", async () => {
  const state = await withFetchQueue(readRoutes(), () =>
    makeAdapter().readVehicleState(identity),
  );
  assert.equal(state.identity, identity);
  assert.deepEqual(state.battery, {
    socPercent: 74,
    estimatedRangeKm: 161,
    charging: "charging",
    chargePowerKw: 7.2,
    minutesToFull: 90,
    pluggedIn: true,
    plugLocked: true,
    targetSocPercent: 80,
  });
  assert.deepEqual(state.security, {
    lock: "locked",
    openDoors: ["front left"],
    openWindows: ["rear right"],
    unlockedDoors: ["front left"],
  });
  assert.deepEqual(state.climate, {
    activity: "unknown",
    targetTempF: null,
    remainingMin: null,
  });
  assert.equal(state.odometerKm, 12345);
  assert.deepEqual(state.location, {
    latitude: 40.000001,
    longitude: -89.000001,
    parkedAt: 1_700_000_000_000,
  });
  assert.deepEqual(state.freshness, {
    fetchedAt: 1_700_000_010_000,
    sourceCapturedAt: 1_700_000_005_000,
    rvsUpdatedAt: 1_700_000_000_000,
    chargeUpdatedAt: 1_700_000_005_000,
    doorsUpdatedAt: 1_700_000_000_000,
    locksUpdatedAt: 1_700_000_000_000,
    windowsUpdatedAt: 1_700_000_000_000,
  });
  assert.deepEqual(state.capabilities, {
    lock: "unknown",
    unlock: "unknown",
    charging: "unknown",
    chargeTarget: "unknown",
    climate: "unknown",
    location: "supported",
  });
});

test("missing and ambiguous status remains unknown, including false legacy lock and empty closures", async () => {
  const state = await withFetchQueue(
    [
      route(
        "GET",
        `${API}/rvs/v1/vehicle/${UUID}`,
        json({ data: { exteriorStatus: { secure: "UNKNOWN" } } }),
      ),
      route(
        "GET",
        `${API}/ev/v1/vehicle/${UUID}/charge/summary`,
        json({ data: {} }),
      ),
    ],
    () => makeAdapter().readVehicleState(identity),
  );
  assert.equal(state.security.lock, "unknown");
  assert.equal(state.security.openDoors, null);
  assert.equal(state.security.openWindows, null);
  assert.equal(state.security.unlockedDoors, null);
  assert.equal(state.battery.socPercent, null);
  assert.equal(state.battery.charging, "unknown");
  assert.equal(state.location, null);
  assert.equal(state.capabilities.location, "unknown");
  assert.equal(state.freshness.sourceCapturedAt, null);
  assert.equal(state.freshness.fetchedAt, 1_700_000_010_000);
});

test("mapping rejects nonfinite measurements and invalid coordinates without fabricating timestamps", () => {
  const status = {
    vin: VIN,
    soc: Number.NaN,
    rangeKm: Number.POSITIVE_INFINITY,
    chargeState: "unrecognized",
    chargePowerKw: null,
    minutesToFull: null,
    pluggedIn: null,
    plugLocked: null,
    targetSoc: null,
    locked: false,
    openDoors: [],
    openWindows: [],
    unlockedDoors: [],
    odometerKm: null,
    parkedLat: 123,
    parkedLng: 20,
    parkedAt: null,
    capturedAt: Number.NaN,
    rvsUpdatedAt: null,
    doorsUpdatedAt: null,
    locksUpdatedAt: null,
    windowsUpdatedAt: null,
    chargeUpdatedAt: null,
  };
  const state = mapVehicleStatus(identity, status, 7);
  assert.equal(state.battery.socPercent, null);
  assert.equal(state.battery.estimatedRangeKm, null);
  assert.equal(state.battery.charging, "unknown");
  assert.equal(state.security.lock, "unknown");
  assert.equal(state.location, null);
  assert.equal(state.freshness.sourceCapturedAt, null);
  assert.equal(state.freshness.fetchedAt, 7);
});

test("climate read maps active and missing/off legacy states conservatively", async () => {
  const summary = `${API}/ev/v1/user/synthetic-user-id/vehicle/${UUID}/summary?tempUnit=fahrenheit`;
  const active = await withFetchQueue(
    [
      route(
        "GET",
        summary,
        json({
          data: {
            climateStatus: {
              climateStatusReport: {
                climateStatusInd: "on",
                remainingClimatizationTimeMin: 15,
              },
              climateSettings: { targetTemperature: { temperature: 72 } },
            },
          },
        }),
        bearer(CARNET),
      ),
    ],
    () => makeAdapter().readClimate(identity),
  );
  assert.deepEqual(active, {
    activity: "active",
    targetTempF: 72,
    remainingMin: 15,
  });
  const missing = await withFetchQueue(
    [route("GET", summary, json({ data: {} }), bearer(CARNET))],
    () => makeAdapter().readClimate(identity),
  );
  assert.deepEqual(missing, {
    activity: "unknown",
    targetTempF: null,
    remainingMin: null,
  });
  assert.deepEqual(
    mapClimateState({ on: false, targetTempF: 70, remainingMin: null }),
    {
      activity: "unknown",
      targetTempF: 70,
      remainingMin: null,
    },
  );
});

test("adapter reads climate target through existing carnet-gated settings endpoint", async () => {
  const value = await withFetchQueue(
    [
      route(
        "GET",
        `${API}/ev/v1/vehicle/${UUID}/pretripclimate/settings?tempUnit=fahrenheit`,
        json({ data: { targetTemperature: { temperature: 68 } } }),
        bearer(CARNET),
      ),
    ],
    () => makeAdapter().readClimateTargetTempF(identity),
  );
  assert.equal(value, 68);
});

test("wake acceptance records request time, not a new vehicle observation", async () => {
  const receipt = await withFetchQueue(
    [
      ...spinRoutes(),
      route(
        "POST",
        `${API}/rvs/v1/vehicle/${UUID}/refresh`,
        json({ data: { result: 0 } }),
        (init) => {
          bearer(CARNET)(init);
          assert.equal(init.body, undefined);
        },
      ),
    ],
    () => makeAdapter().requestWake(identity),
  );
  assert.deepEqual(receipt, {
    vehicleReference: UUID,
    acceptedAt: 1_700_000_010_000,
  });
});

for (const action of ["lock", "unlock"]) {
  test(`adapter ${action} submission preserves S-PIN path and returns intent separately`, async () => {
    const adapter = makeAdapter();
    const observed = await withFetchQueue(readRoutes(), () =>
      adapter.readVehicleState(identity),
    );
    const receipt = await withFetchQueue(
      [
        ...spinRoutes(),
        route(
          "PUT",
          `${API}/lockunlock/v1/vehicle/${UUID}`,
          accepted(),
          (init) => {
            bearer(CARNET)(init);
            bodyJson({ lock: action === "lock" })(init);
          },
        ),
      ],
      () =>
        action === "lock"
          ? adapter.submitLock(identity)
          : adapter.submitUnlock(identity),
    );
    assert.deepEqual(receipt, {
      vehicleReference: UUID,
      kind: action,
      correlationId: "synthetic-correlation-id",
      acceptedAt: 1_700_000_010_000,
    });
    assert.equal(observed.security.lock, "locked");
  });
}

test("EV adapter methods delegate charging and climate requests without adding orchestration", async () => {
  const adapter = makeAdapter();
  const operations = [
    [
      "charge_start",
      "POST",
      `${API}/ev/v1/vehicle/${UUID}/charging/start`,
      () => adapter.submitChargeStart(identity),
      { actionMode: "immediate" },
    ],
    [
      "charge_stop",
      "POST",
      `${API}/ev/v1/vehicle/${UUID}/charging/stop`,
      () => adapter.submitChargeStop(identity),
      { actionMode: "immediate" },
    ],
    [
      "climate_start",
      "POST",
      `${API}/ev/v1/vehicle/${UUID}/pretripclimate/start`,
      () => adapter.submitClimateStart(identity),
      null,
    ],
    [
      "climate_stop",
      "POST",
      `${API}/ev/v1/vehicle/${UUID}/pretripclimate/stop`,
      () => adapter.submitClimateStop(identity),
      null,
    ],
  ];
  for (const [kind, method, url, run, body] of operations) {
    const receipt = await withFetchQueue(
      [
        route(method, url, accepted(), (init) => {
          bearer(CARNET)(init);
          if (body === null) assert.equal(init.body, null);
          else bodyJson(body)(init);
        }),
      ],
      run,
    );
    assert.equal(receipt.kind, kind);
    assert.equal(receipt.correlationId, "synthetic-correlation-id");
  }
  const limit = await withFetchQueue(
    [
      route(
        "GET",
        `${API}/ev/v1/vehicle/${UUID}/charging/settings`,
        json({ data: { chargingSettings: { targetSOCPercentage: 80 } } }),
        bearer(CARNET),
      ),
      route(
        "PUT",
        `${API}/ev/v1/vehicle/${UUID}/charging/settings`,
        accepted(),
        bodyJson({ targetSOCPercentage: 90 }),
      ),
    ],
    () => adapter.submitChargeTarget(identity, 90),
  );
  assert.equal(limit.kind, "charge_target");
  const temperature = await withFetchQueue(
    [
      route(
        "GET",
        `${API}/ev/v1/vehicle/${UUID}/pretripclimate/settings?tempUnit=fahrenheit`,
        json({ data: {} }),
        bearer(CARNET),
      ),
      route(
        "PUT",
        `${API}/ev/v1/vehicle/${UUID}/pretripclimate/settings?tempUnit=fahrenheit`,
        accepted(),
      ),
    ],
    () => adapter.submitClimateTemperature(identity, 68),
  );
  assert.equal(temperature.kind, "climate_temperature");
});

test("confirmation remains distinct from command submission and uses existing history polling", async () => {
  const adapter = makeAdapter();
  const timer = mock.method(globalThis, "setTimeout", (callback) => {
    globalThis.queueMicrotask(callback);
    return 1;
  });
  try {
    const receipt = await withFetchQueue(
      [
        route(
          "POST",
          `${API}/ev/v1/vehicle/${UUID}/charging/start`,
          accepted(),
        ),
      ],
      () => adapter.submitChargeStart(identity),
    );
    const confirmation = await withFetchQueue(
      [
        route(
          "GET",
          `${API}/history/v1/vehicle/${UUID}/correlationId/synthetic-correlation-id/ro/`,
          json({
            data: {
              responseBody: JSON.stringify({
                eventStatus: { responseOutcome: 2 },
              }),
            },
          }),
          bearer(CARNET),
        ),
      ],
      () => adapter.awaitCommandResult(receipt, { attempts: 1, intervalMs: 1 }),
    );
    assert.deepEqual(confirmation, { confirmed: true });
  } finally {
    timer.mock.restore();
  }
});

test("adapter propagates protocol failures instead of turning them into state or support claims", async () => {
  await assert.rejects(
    withFetchQueue(
      [route("GET", `${API}/account/v1/garage`, json({}, 503))],
      () => makeAdapter().discoverVehicles(),
    ),
    /garage/,
  );
});

test("discovery mapper carries no synthetic local ID until persistence assigns one", () => {
  assert.deepEqual(
    mapVehicleIdentity({
      vin: VIN,
      uuid: UUID,
      nickname: null,
      model: null,
    }),
    { localId: null, reference: UUID, vin: VIN, name: null, model: null },
  );
});
