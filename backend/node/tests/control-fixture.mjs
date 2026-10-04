import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { getPublicKey } from "nostr-tools";
import { createBuzzKeyClient } from "../../../app/src/buzzkey-client.ts";
import { API, CARNET, json, route, UUID } from "../../tests/harness.mjs";
import { fixture, origin, secret, seed } from "./lock-fixture.mjs";

export { offline, origin, secret } from "./lock-fixture.mjs";
export { CARNET, API, UUID, route, json } from "../../tests/harness.mjs";
export const NOW = Date.now() + 1000;
export const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const KEY2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const CID = "synthetic-control-correlation";
export async function ready(t, options = {}) {
  const f = await fixture(t, { now: () => NOW, ...options });
  const accountId = await seed(f);
  const user = await f.services.db.getUser("owner");
  await f.services.db.saveCarnetToken(user.account, UUID, {
    token: CARNET,
    expiresAt: Date.now() + 3600000,
  });
  f.storage.db
    .prepare(
      "INSERT INTO owner_vw_connection(owner_id,account_id,state,verified_at) VALUES ('owner',?,'connected',?)",
    )
    .run(accountId, NOW);
  return { f, vehicle: user.vehicles[0], accountId };
}
export const mint = () => [
  route(
    "GET",
    `${API}/ss/v1/user/synthetic-user-id/challenge`,
    json({ data: { challenge: "synthetic-challenge", remainingTries: 8 } }),
  ),
  route(
    "POST",
    `${API}/ss/v1/user/synthetic-user-id/vehicle/${UUID}/session`,
    json({ data: { carnetVehicleToken: CARNET } }),
  ),
];
export function ev(
  action,
  response = json({ data: { result: 0, correlationId: CID } }),
) {
  const verb = action === "charge_target" ? "PUT" : "POST";
  const suffix =
    action === "charge_target"
      ? "settings"
      : action === "charge_start"
        ? "start"
        : "stop";
  return [
    ...mint(),
    ...(action === "charge_target"
      ? [
          route(
            "GET",
            `${API}/ev/v1/vehicle/${UUID}/charging/settings`,
            json({ data: { chargingSettings: { maxChargingCurrent: "max" } } }),
          ),
        ]
      : []),
    route(
      verb,
      `${API}/ev/v1/vehicle/${UUID}/charging/${suffix}`,
      response,
      (init) => {
        assert.equal(init.headers.authorization, `Bearer ${CARNET}`);
        assert.deepEqual(
          JSON.parse(init.body),
          action === "charge_target"
            ? { maxChargingCurrent: "max", targetSOCPercentage: 80 }
            : { actionMode: "immediate" },
        );
      },
    ),
  ];
}
export const history = (outcome = 2) =>
  route(
    "GET",
    `${API}/history/v1/vehicle/${UUID}/correlationId/${CID}/ro/`,
    json({
      data: {
        responseBody: JSON.stringify({
          eventStatus: { responseOutcome: outcome },
        }),
      },
    }),
  );
export function observation(
  chargeState = "chargingHVBattery",
  target = 80,
  timestamp = NOW,
) {
  return [
    route(
      "GET",
      `${API}/rvs/v1/vehicle/${UUID}`,
      json({ data: { timestamp, exteriorStatus: { secure: "SECURE" } } }),
    ),
    route(
      "GET",
      `${API}/ev/v1/vehicle/${UUID}/charge/summary`,
      json({
        data: {
          carCapturedTimestamp: timestamp,
          chargingStatus: { currentChargeState: chargeState },
          chargeSettings: { targetSOCPercentage: target },
        },
      }),
    ),
  ];
}
export const input = (vehicle, action, key = KEY) => ({
  vehicleId: vehicle.id,
  action,
  idempotencyKey: key,
  ...(action === "charge_target" ? { targetSoc: 80 } : {}),
});
export async function terminal(f, key = KEY) {
  for (let i = 0; i < 100; i++) {
    const c = await f.client.commandByKey(key);
    if (["confirmed", "failed", "timed_out", "unknown"].includes(c.status))
      return c;
    await setTimeout(5);
  }
  throw Error("Command did not settle");
}
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
export const climateOp = (
  action,
  response = json({ data: { result: 0, correlationId: CID } }),
) =>
  route(
    "POST",
    `${API}/ev/v1/vehicle/${UUID}/pretripclimate/${action}`,
    response,
  );

export function losingClient(f) {
  return createBuzzKeyClient({
    origin,
    getIdentity: async () => ({
      secretKey: secret,
      pubkey: getPublicKey(secret),
    }),
    ...f.material,
    fetcher: async (...args) => {
      await f.raw(...args);
      await terminal(f);
      throw Error("synthetic lost mobile response");
    },
  });
}
