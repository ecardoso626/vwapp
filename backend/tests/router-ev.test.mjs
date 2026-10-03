import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";
import { URL } from "node:url";
import { createRouterClient } from "@orpc/server";
import { pollAllVehicles, runClimateKeepalive } from "../src/poll.ts";
import { router } from "../src/router.ts";
import {
  ACCESS,
  API,
  bearer,
  bodyJson,
  CARNET,
  json,
  route,
  UUID,
  withFetchQueue,
} from "./harness.mjs";
import { routerFixture } from "./router-fixture.mjs";

const fixture = (name) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  );
const challenge = `${API}/ss/v1/user/synthetic-user-id/challenge`;
const session = `${API}/ss/v1/user/synthetic-user-id/vehicle/${UUID}/session`;
const climateSummary = `${API}/ev/v1/user/synthetic-user-id/vehicle/${UUID}/summary?tempUnit=fahrenheit`;
const climateSettings = `${API}/ev/v1/vehicle/${UUID}/pretripclimate/settings?tempUnit=fahrenheit`;
const history = `${API}/history/v1/vehicle/${UUID}/correlationId/synthetic-correlation-id/ro/`;
const accepted = () =>
  json({ data: { result: 0, correlationId: "synthetic-correlation-id" } });
const busy = () => json({ error: { errorCode: "EV_THRESHOLD_EXCEEDED" } }, 429);
const spin = () => [
  route(
    "GET",
    challenge,
    json({ data: { challenge: "synthetic-challenge", remainingTries: 8 } }),
    bearer(ACCESS),
  ),
  route(
    "POST",
    session,
    json({ data: { carnetVehicleToken: CARNET } }),
    bearer(ACCESS),
  ),
];
const status = () => [
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
const event = (outcome, cause) =>
  json({
    data: {
      responseBody: JSON.stringify({
        eventStatus: { responseOutcome: outcome },
        ...(cause
          ? { payloadString: JSON.stringify({ data: { cause } }) }
          : {}),
      }),
    },
  });
const clock = () =>
  mock.method(globalThis, "setTimeout", (callback) => {
    globalThis.queueMicrotask(callback);
    return 1;
  });
const clientFor = (context) => createRouterClient(router, { context });
const active = (overrides = {}) => ({
  id: "synthetic-climate-session",
  tempF: 72,
  expiresAt: Date.now() + 600_000,
  startedAt: Date.now() - 60_000,
  state: "active",
  lastStartAt: null,
  remainingMin: null,
  pausedAt: null,
  ...overrides,
});

for (const [name, path, invoke] of [
  ["start", "charging/start", (c) => c.vehicle.chargeStart({ uuid: UUID })],
  ["stop", "charging/stop", (c) => c.vehicle.chargeStop({ uuid: UUID })],
]) {
  test(`router charge ${name} mints S-PIN, confirms terminal success and snapshots cloud status`, async () => {
    const { db, context } = await routerFixture();
    const timer = clock();
    try {
      assert.deepEqual(
        await withFetchQueue(
          [
            ...spin(),
            route(
              "POST",
              `${API}/ev/v1/vehicle/${UUID}/${path}`,
              accepted(),
              (init) => {
                bearer(CARNET)(init);
                bodyJson({ actionMode: "immediate" })(init);
              },
            ),
            route("GET", history, event(2), bearer(CARNET)),
            ...status(),
          ],
          () => invoke(clientFor(context)),
        ),
        { ok: true },
      );
      assert.equal(db.snapshots.length, 1);
    } finally {
      timer.mock.restore();
    }
  });
}

test("charge limit preserves settings, retries EV busy twice with fresh S-PIN mints, and accepts unconfirmed history", async () => {
  const { db, context } = await routerFixture();
  const timer = clock();
  const settings = {
    maxChargingCurrent: "max",
    targetSOCPercentage: 80,
    chargeModeSelection: "immediate",
  };
  try {
    const steps = [
      ...spin(),
      route(
        "GET",
        `${API}/ev/v1/vehicle/${UUID}/charging/settings`,
        json({ data: { chargingSettings: settings } }),
        bearer(CARNET),
      ),
      route(
        "PUT",
        `${API}/ev/v1/vehicle/${UUID}/charging/settings`,
        busy(),
        bearer(CARNET),
      ),
      ...spin(),
      route(
        "GET",
        `${API}/ev/v1/vehicle/${UUID}/charging/settings`,
        json({ data: { chargingSettings: settings } }),
        bearer(CARNET),
      ),
      route(
        "PUT",
        `${API}/ev/v1/vehicle/${UUID}/charging/settings`,
        busy(),
        bearer(CARNET),
      ),
      ...spin(),
      route(
        "GET",
        `${API}/ev/v1/vehicle/${UUID}/charging/settings`,
        json({ data: { chargingSettings: settings } }),
        bearer(CARNET),
      ),
      route(
        "PUT",
        `${API}/ev/v1/vehicle/${UUID}/charging/settings`,
        accepted(),
        (init) => {
          bearer(CARNET)(init);
          bodyJson({ ...settings, targetSOCPercentage: 90 })(init);
        },
      ),
      ...Array.from({ length: 6 }, () =>
        route("GET", history, event(1), bearer(CARNET)),
      ),
      ...status(),
    ];
    assert.deepEqual(
      await withFetchQueue(steps, () =>
        clientFor(context).vehicle.setChargeLimit({
          uuid: UUID,
          targetSoc: 90,
        }),
      ),
      { ok: true },
    );
    assert.equal(db.snapshots.length, 1);
  } finally {
    timer.mock.restore();
  }
});

test("charge command explicit history rejection fails without a snapshot", async () => {
  const { db, context } = await routerFixture();
  const timer = clock();
  try {
    await assert.rejects(
      withFetchQueue(
        [
          ...spin(),
          route(
            "POST",
            `${API}/ev/v1/vehicle/${UUID}/charging/start`,
            accepted,
          ),
          route("GET", history, event(3, "synthetic rejected")),
        ],
        () => clientFor(context).vehicle.chargeStart({ uuid: UUID }),
      ),
      /synthetic rejected/,
    );
    assert.equal(db.snapshots.length, 0);
  } finally {
    timer.mock.restore();
  }
});

for (const [statusCode, body] of [
  [429, {}],
  [503, {}],
]) {
  test(`charge generic HTTP ${statusCode} fails without retry or snapshot`, async () => {
    const { db, context } = await routerFixture();
    await assert.rejects(
      withFetchQueue(
        [
          ...spin(),
          route(
            "POST",
            `${API}/ev/v1/vehicle/${UUID}/charging/start`,
            json(body, statusCode),
          ),
        ],
        () => clientFor(context).vehicle.chargeStart({ uuid: UUID }),
      ),
      /EV command failed/,
    );
    assert.equal(db.snapshots.length, 0);
  });
}

test("climate start at current target submits start and saves session without initial history confirmation", async () => {
  const { db, context } = await routerFixture();
  assert.deepEqual(
    await withFetchQueue(
      [
        ...spin(),
        route(
          "GET",
          climateSummary,
          json({
            data: {
              climateStatus: {
                climateStatusReport: { climateStatusInd: "off" },
                climateSettings: { targetTemperature: { temperature: 72 } },
              },
            },
          }),
          bearer(CARNET),
        ),
        ...spin(),
        route(
          "POST",
          `${API}/ev/v1/vehicle/${UUID}/pretripclimate/start`,
          accepted(),
          bearer(CARNET),
        ),
      ],
      () =>
        clientFor(context).vehicle.climateStart({
          uuid: UUID,
          tempF: 72,
          durationMin: 30,
        }),
    ),
    { ok: true },
  );
  assert.equal(db.sessions.length, 1);
  assert.equal(db.sessions[0].tempF, 72);
  assert.equal(db.sessions[0].state, "active");
});

test("climate same-temperature reschedule and paused stop require no VW requests", async () => {
  const first = await routerFixture({ activeSession: active() });
  assert.deepEqual(
    await withFetchQueue([], () =>
      clientFor(first.context).vehicle.climateStart({
        uuid: UUID,
        tempF: 72,
        durationMin: 45,
      }),
    ),
    { ok: true },
  );
  assert.equal(first.db.sessions[0].state, "active");
  assert.ok(first.db.sessions[0].expiresAt > Date.now() + 44 * 60_000);
  const second = await routerFixture({
    activeSession: active({ pausedAt: Date.now() - 30_000 }),
  });
  assert.deepEqual(
    await withFetchQueue([], () =>
      clientFor(second.context).vehicle.climateStop({ uuid: UUID }),
    ),
    { ok: true },
  );
  assert.equal(second.db.sessions[0].state, "stopped");
});

test("climate target change while off writes settings, observes target, then starts", async () => {
  const { db, context } = await routerFixture();
  const settings = {
    climatizationWithoutExternalPower: false,
    climatizationElementSettings: { mirrorHeatingEnabled: true },
  };
  assert.deepEqual(
    await withFetchQueue(
      [
        ...spin(),
        route(
          "GET",
          climateSummary,
          json({
            data: {
              climateStatus: {
                climateStatusReport: { climateStatusInd: "off" },
                climateSettings: { targetTemperature: { temperature: 70 } },
              },
            },
          }),
          bearer(CARNET),
        ),
        ...spin(),
        route("GET", climateSettings, json({ data: settings }), bearer(CARNET)),
        route("PUT", climateSettings, accepted(), (init) => {
          bearer(CARNET)(init);
          bodyJson({
            ...settings,
            targetTemperature: { temperature: 68, unit: "fahrenheit" },
          })(init);
        }),
        ...spin(),
        route(
          "GET",
          climateSettings,
          json({ data: { targetTemperature: { temperature: 68 } } }),
          bearer(CARNET),
        ),
        ...spin(),
        route(
          "POST",
          `${API}/ev/v1/vehicle/${UUID}/pretripclimate/start`,
          accepted(),
          bearer(CARNET),
        ),
      ],
      () =>
        clientFor(context).vehicle.climateStart({
          uuid: UUID,
          tempF: 68,
          durationMin: 30,
        }),
    ),
    { ok: true },
  );
  assert.equal(db.sessions[0].tempF, 68);
});

test("climate start busy exhausts three attempts and defers to managed session", async () => {
  const { db, context } = await routerFixture();
  const timer = clock();
  try {
    assert.deepEqual(
      await withFetchQueue(
        [
          ...spin(),
          route(
            "GET",
            climateSummary,
            json({
              data: {
                climateStatus: {
                  climateStatusReport: { climateStatusInd: "off" },
                  climateSettings: { targetTemperature: { temperature: 72 } },
                },
              },
            }),
          ),
          ...Array.from({ length: 3 }, () => [
            ...spin(),
            route(
              "POST",
              `${API}/ev/v1/vehicle/${UUID}/pretripclimate/start`,
              busy(),
            ),
          ]).flat(),
        ],
        () =>
          clientFor(context).vehicle.climateStart({
            uuid: UUID,
            tempF: 72,
            durationMin: 30,
          }),
      ),
      { ok: true },
    );
    assert.equal(db.sessions[0].state, "active");
  } finally {
    timer.mock.restore();
  }
});

test("climate start rejection does not create a session; stop confirms and ends one", async () => {
  const first = await routerFixture();
  await assert.rejects(
    withFetchQueue(
      [
        ...spin(),
        route(
          "GET",
          climateSummary,
          json({
            data: {
              climateStatus: {
                climateStatusReport: { climateStatusInd: "off" },
                climateSettings: { targetTemperature: { temperature: 72 } },
              },
            },
          }),
        ),
        ...spin(),
        route(
          "POST",
          `${API}/ev/v1/vehicle/${UUID}/pretripclimate/start`,
          json({ data: { result: 9 } }),
        ),
      ],
      () =>
        clientFor(first.context).vehicle.climateStart({
          uuid: UUID,
          tempF: 72,
          durationMin: 30,
        }),
    ),
    /rejected/,
  );
  assert.equal(first.db.sessions.length, 0);
  const second = await routerFixture({ activeSession: active() });
  const timer = clock();
  try {
    assert.deepEqual(
      await withFetchQueue(
        [
          ...spin(),
          route(
            "POST",
            `${API}/ev/v1/vehicle/${UUID}/pretripclimate/stop`,
            accepted(),
            bearer(CARNET),
          ),
          route("GET", history, event(2), bearer(CARNET)),
        ],
        () => clientFor(second.context).vehicle.climateStop({ uuid: UUID }),
      ),
      { ok: true },
    );
    assert.equal(second.db.sessions[0].state, "stopped");
  } finally {
    timer.mock.restore();
  }
});

test("normal cron status poll reads cached cloud state without a wake request", async () => {
  const { db, env } = await routerFixture();
  await withFetchQueue(status(), () => pollAllVehicles(db, env));
  assert.equal(db.snapshots.length, 1);
});

test("forced refresh accepts wake then returns immediate cloud status without waiting for vehicle response", async () => {
  const { db, context } = await routerFixture();
  const result = await withFetchQueue(
    [
      ...spin(),
      route(
        "POST",
        `${API}/rvs/v1/vehicle/${UUID}/refresh`,
        json({ data: { result: 0 } }),
        (init) => {
          bearer(CARNET)(init);
          assert.equal(init.body, undefined);
        },
      ),
      ...status(),
    ],
    () => clientFor(context).vehicle.refresh({ uuid: UUID }),
  );
  assert.equal(result.locked, true);
  assert.equal(db.snapshots.length, 1);
});

for (const [name, response] of [
  ["rejected", json({ data: { result: 7 } })],
  ["HTTP 503", json({}, 503)],
  [
    "network failure",
    () => {
      throw new TypeError("synthetic network failure");
    },
  ],
]) {
  test(`forced refresh ${name} still returns cached cloud status`, async () => {
    const { db, context } = await routerFixture();
    const result = await withFetchQueue(
      [
        ...spin(),
        route("POST", `${API}/rvs/v1/vehicle/${UUID}/refresh`, response),
        ...status(),
      ],
      () => clientFor(context).vehicle.refresh({ uuid: UUID }),
    );
    assert.equal(result.locked, true);
    assert.equal(db.snapshots.length, 1);
  });
}

test("keepalive restarts off climate and confirms history before recording start", async () => {
  const { db, env } = await routerFixture({ activeSession: active() });
  const timer = clock();
  try {
    await withFetchQueue(
      [
        ...spin(),
        route(
          "GET",
          climateSummary,
          json({
            data: {
              climateStatus: {
                climateStatusReport: { climateStatusInd: "off" },
              },
            },
          }),
        ),
        route(
          "POST",
          `${API}/ev/v1/vehicle/${UUID}/pretripclimate/start`,
          accepted,
        ),
        route("GET", history, event(2), bearer(CARNET)),
      ],
      () => runClimateKeepalive(db, env),
    );
    assert.ok(db.sessions[0].lastStartAt !== null);
    assert.equal(db.sessions[0].pausedAt, null);
  } finally {
    timer.mock.restore();
  }
});

test("keepalive pauses on ignition rejection and skips subsequent ticks until parked", async () => {
  const { db, env } = await routerFixture({ activeSession: active() });
  const timer = clock();
  try {
    await withFetchQueue(
      [
        ...spin(),
        route(
          "GET",
          climateSummary,
          json({
            data: {
              climateStatus: {
                climateStatusReport: { climateStatusInd: "off" },
              },
            },
          }),
        ),
        route(
          "POST",
          `${API}/ev/v1/vehicle/${UUID}/pretripclimate/start`,
          accepted,
        ),
        route("GET", history, event(3, "synthetic ignition is on")),
      ],
      () => runClimateKeepalive(db, env),
    );
    assert.ok(db.sessions[0].pausedAt !== null);
    await withFetchQueue([], () => runClimateKeepalive(db, env));
  } finally {
    timer.mock.restore();
  }
});

test("keepalive expires a session by sending stop without climate state or history reads", async () => {
  const { db, env } = await routerFixture({
    activeSession: active({ expiresAt: Date.now() - 1 }),
  });
  await withFetchQueue(
    [
      ...spin(),
      route(
        "POST",
        `${API}/ev/v1/vehicle/${UUID}/pretripclimate/stop`,
        accepted(),
        bearer(CARNET),
      ),
    ],
    () => runClimateKeepalive(db, env),
  );
  assert.equal(db.sessions[0].state, "expired");
});

test("keepalive clears pause after a newer parked snapshot and running climate read", async () => {
  const pausedAt = Date.now() - 60_000;
  const { db, env } = await routerFixture({
    activeSession: active({ pausedAt }),
  });
  db.snapshots.push({ parkedAt: pausedAt + 1 });
  await withFetchQueue(
    [
      ...spin(),
      route(
        "GET",
        climateSummary,
        json({
          data: {
            climateStatus: {
              climateStatusReport: {
                climateStatusInd: "on",
                remainingClimatizationTimeMin: 17,
              },
            },
          },
        }),
        bearer(CARNET),
      ),
    ],
    () => runClimateKeepalive(db, env),
  );
  assert.equal(db.sessions[0].pausedAt, null);
  assert.equal(db.sessions[0].remainingMin, 17);
});

test("climate stop terminal rejection keeps the managed session active", async () => {
  const { db, context } = await routerFixture({ activeSession: active() });
  const timer = clock();
  try {
    await assert.rejects(
      withFetchQueue(
        [
          ...spin(),
          route(
            "POST",
            `${API}/ev/v1/vehicle/${UUID}/pretripclimate/stop`,
            accepted(),
          ),
          route("GET", history, event(3, "synthetic stop rejected")),
        ],
        () => clientFor(context).vehicle.climateStop({ uuid: UUID }),
      ),
      /synthetic stop rejected/,
    );
    assert.equal(db.sessions[0].state, "active");
  } finally {
    timer.mock.restore();
  }
});

test("wake HTTP 401 attempts a forced full login, then falls back to cached status if login fails", async () => {
  const { db, context } = await routerFixture();
  const result = await withFetchQueue(
    [
      ...spin(),
      route("POST", `${API}/rvs/v1/vehicle/${UUID}/refresh`, json({}, 401)),
      route(
        "GET",
        (url) => assert.ok(url.startsWith(`${API}/oidc/v1/authorize?`)),
        json({}, 503),
      ),
      ...status(),
    ],
    () => clientFor(context).vehicle.refresh({ uuid: UUID }),
  );
  assert.equal(result.locked, true);
  assert.equal(db.snapshots.length, 1);
});
