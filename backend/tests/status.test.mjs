import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { URL } from "node:url";
import { VwAuthError, vwGetStatus, vwGetVehicles } from "../src/vw/client.ts";
import {
  ACCESS,
  API,
  bearer,
  CARNET,
  json,
  route,
  UUID,
  VIN,
  withFetchQueue,
} from "./harness.mjs";

const fixture = (name) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  );

test("garage chooses VW UUID over VIN and filters entries missing identity", async () => {
  const vehicles = await withFetchQueue(
    [
      route(
        "GET",
        `${API}/account/v1/garage`,
        json(fixture("garage")),
        bearer(ACCESS),
      ),
    ],
    () => vwGetVehicles(ACCESS),
  );
  assert.deepEqual(vehicles, [
    {
      vin: VIN,
      uuid: UUID,
      nickname: "Fixture Buzz",
      model: "Synthetic ID. Buzz",
    },
  ]);
});

test("RVS and EV status read use carnet bearer and retain current normalization/freshness behavior", async () => {
  const status = await withFetchQueue(
    [
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
    ],
    () => vwGetStatus(CARNET, VIN, UUID),
  );
  assert.deepEqual(status, {
    vin: VIN,
    soc: 74,
    chargeState: "chargingHVBattery",
    chargePowerKw: 7.2,
    minutesToFull: 90,
    pluggedIn: true,
    plugLocked: true,
    targetSoc: 80,
    locked: true,
    openDoors: ["front left"],
    openWindows: ["rear right"],
    unlockedDoors: ["front left"],
    rangeKm: 161,
    odometerKm: 12345,
    parkedLat: 40.000001,
    parkedLng: -89.000001,
    parkedAt: 1_700_000_000_000,
    capturedAt: 1_700_000_005_000,
    rvsUpdatedAt: 1_700_000_000_000,
    doorsUpdatedAt: 1_700_000_000_000,
    locksUpdatedAt: 1_700_000_000_000,
    windowsUpdatedAt: 1_700_000_000_000,
    chargeUpdatedAt: 1_700_000_005_000,
  });
});

test("missing optional data becomes null while missing closures become empty arrays", async () => {
  const status = await withFetchQueue(
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
    () => vwGetStatus(CARNET, VIN, UUID),
  );
  assert.equal(status.locked, false); // unknown secure string currently maps to false
  assert.equal(status.soc, null);
  assert.equal(status.pluggedIn, null);
  assert.equal(status.capturedAt, null);
  assert.deepEqual(status.openDoors, []); // absent is indistinguishable from all closed
  assert.deepEqual(status.openWindows, []);
});

test("401 is a typed auth error; 429 and 5xx are generic GET errors", async () => {
  for (const [status, ErrorType] of [
    [401, VwAuthError],
    [429, Error],
    [503, Error],
  ]) {
    await assert.rejects(
      withFetchQueue(
        [route("GET", `${API}/account/v1/garage`, json({}, status))],
        () => vwGetVehicles(ACCESS),
      ),
      ErrorType,
    );
  }
});
