import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";
import { URL } from "node:url";
import { createRouterClient } from "@orpc/server";
import { seal } from "../src/crypto.ts";
import { router } from "../src/router.ts";
import {
  ACCESS,
  API,
  assertNoSyntheticSecrets,
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
const historyUrl = `${API}/history/v1/vehicle/${UUID}/correlationId/synthetic-correlation-id/ro/`;

function fakeDb(sealed) {
  const snapshots = [];
  const account = {
    id: "synthetic-account-id",
    credCiphertext: sealed.ciphertext,
    credIv: sealed.iv,
    accessToken: ACCESS,
    refreshToken: "synthetic-refresh-token",
    idToken: ID_TOKEN,
    tokenExpiresAt: Date.now() + 600_000,
    codeVerifier: "synthetic-verifier",
    carnetTokens: JSON.stringify({
      [UUID]: { token: CARNET, expiresAt: Date.now() + 600_000 },
    }),
    vehicles: [
      {
        id: "synthetic-vehicle-row",
        uuid: UUID,
        vin: VIN,
        vehicleNickName: "Fixture Buzz",
      },
    ],
  };
  return {
    snapshots,
    query: async (query) =>
      query.$users ? { $users: [{ account }] } : { snapshots: [] },
    transact: async (operation) => operation,
    tx: {
      snapshots: new Proxy(
        {},
        {
          get: () => ({
            create: (data) => ({
              link: ({ vehicle }) => {
                snapshots.push({ ...data, vehicle });
                return { ...data, vehicle };
              },
            }),
          }),
        },
      ),
    },
  };
}

test("router returns optimistic unlock success after eight unconfirmed history reads and overwrites contrary RVS state", async () => {
  const key = Buffer.alloc(32, 7).toString("base64"); // fixture-only key
  const db = fakeDb(
    await seal(
      key,
      JSON.stringify({
        username: "nobody@example.invalid",
        password: "synthetic-password",
        spin: SPIN,
      }),
    ),
  );
  const client = createRouterClient(router, {
    context: {
      db,
      env: { CREDS_ENC_KEY: key },
      userId: "synthetic-guest-id",
      waitUntil: () => undefined,
    },
  });
  const logs = [];
  const log = mock.method(globalThis.console, "log", (...parts) => {
    logs.push(parts.join(" "));
  });
  const timer = mock.method(globalThis, "setTimeout", (callback) => {
    globalThis.queueMicrotask(callback);
    return 1;
  });
  try {
    const challenge = `${API}/ss/v1/user/synthetic-user-id/challenge`;
    const session = `${API}/ss/v1/user/synthetic-user-id/vehicle/${UUID}/session`;
    const steps = [
      route(
        "GET",
        challenge,
        json({ data: { challenge: "synthetic-challenge", remainingTries: 8 } }),
      ),
      route("POST", session, json({ data: { carnetVehicleToken: CARNET } })),
      route(
        "PUT",
        `${API}/lockunlock/v1/vehicle/${UUID}`,
        json({
          data: { result: 0, correlationId: "synthetic-correlation-id" },
        }),
      ),
      ...Array.from({ length: 8 }, () =>
        route(
          "GET",
          historyUrl,
          json({
            data: {
              responseBody: JSON.stringify({
                eventStatus: { responseOutcome: 1 },
              }),
            },
          }),
        ),
      ),
      route("GET", `${API}/rvs/v1/vehicle/${UUID}`, json(fixture("rvs"))), // reports SECURE/locked
      route(
        "GET",
        `${API}/ev/v1/vehicle/${UUID}/charge/summary`,
        json(fixture("charge")),
      ),
    ];
    const result = await withFetchQueue(steps, () =>
      client.vehicle.command({ uuid: UUID, action: "unlock" }),
    );
    assert.deepEqual(result, { ok: true, locked: false });
    assert.equal(db.snapshots.length, 1);
    assert.equal(db.snapshots[0].locked, false); // source observation said true
    assert.equal(db.snapshots[0].vehicle, "synthetic-vehicle-row");
    assertNoSyntheticSecrets(logs.join("\n"));
  } finally {
    timer.mock.restore();
    log.mock.restore();
  }
});
