import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock, test } from "node:test";
import {
  VwAuthError,
  vwAwaitCommandResult,
  VwBusyError,
  vwChargeStart,
  vwChargeStop,
  vwClimateStart,
  vwClimateStop,
  VwCommandError,
  vwForceRefresh,
  vwGetClimate,
  vwLockUnlock,
  vwMintSpinSession,
  vwSetChargeLimit,
  vwSetClimateTemp,
} from "../src/vw/client.ts";
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
  withFetchQueue,
} from "./harness.mjs";

const USER = "synthetic-user-id";
const CORRELATION = "synthetic-correlation-id";
const tokens = { accessToken: ACCESS, idToken: ID_TOKEN };
const challengeUrl = `${API}/ss/v1/user/${USER}/challenge`;
const sessionUrl = `${API}/ss/v1/user/${USER}/vehicle/${UUID}/session`;
const spinRoutes = (remaining = 8) => [
  route(
    "GET",
    challengeUrl,
    json({
      data: { challenge: "synthetic-challenge", remainingTries: remaining },
    }),
    bearer(ACCESS),
  ),
  route(
    "POST",
    sessionUrl,
    json({ data: { carnetVehicleToken: CARNET } }),
    (init) => {
      bearer(ACCESS)(init);
      bodyJson({
        idToken: ID_TOKEN,
        spinHash: createHash("sha512")
          .update(`synthetic-challenge.${SPIN}`)
          .digest("hex"),
        tsp: "WCT",
      })(init);
    },
  ),
];

test("S-PIN GET, lowercase SHA-512 challenge response, access bearer and carnet output", async () => {
  assert.equal(
    await withFetchQueue(spinRoutes(), () =>
      vwMintSpinSession(tokens, UUID, SPIN),
    ),
    CARNET,
  );
});

test("S-PIN guard refuses low remaining attempts before the session POST", async () => {
  await assert.rejects(
    withFetchQueue(spinRoutes(2).slice(0, 1), () =>
      vwMintSpinSession(tokens, UUID, SPIN),
    ),
    /Only 2 S-PIN attempts remain/,
  );
});

test("incorrect S-PIN is distinct from missing id_token and challenge 401", async () => {
  await assert.rejects(
    vwMintSpinSession({ accessToken: ACCESS, idToken: null }, UUID, SPIN),
    VwAuthError,
  );
  await assert.rejects(
    withFetchQueue(
      [spinRoutes()[0], route("POST", sessionUrl, json({}, 403))],
      () => vwMintSpinSession(tokens, UUID, SPIN),
    ),
    /Incorrect S-PIN/,
  );
  await assert.rejects(
    withFetchQueue([route("GET", challengeUrl, json({}, 401))], () =>
      vwMintSpinSession(tokens, UUID, SPIN),
    ),
    VwAuthError,
  );
});

for (const [action, want] of [
  ["lock", true],
  ["unlock", false],
]) {
  test(`${action} submits exact boolean body with carnet bearer; accepted result returns correlation only`, async () => {
    const steps = [
      ...spinRoutes(),
      route(
        "PUT",
        `${API}/lockunlock/v1/vehicle/${UUID}`,
        json({ data: { result: 0, correlationId: CORRELATION } }),
        (init) => {
          bearer(CARNET)(init);
          bodyJson({ lock: want })(init);
          assert.equal(init.headers["x-spin-session"], undefined);
        },
      ),
    ];
    assert.equal(
      await withFetchQueue(steps, () =>
        vwLockUnlock(tokens, UUID, SPIN, action),
      ),
      CORRELATION,
    );
  });
}

test("accepted lock response without correlation is rejected; nonzero result is refusal", async () => {
  for (const data of [
    { result: 0 },
    { result: 7, correlationId: CORRELATION },
  ]) {
    await assert.rejects(
      withFetchQueue(
        [
          ...spinRoutes(),
          route("PUT", `${API}/lockunlock/v1/vehicle/${UUID}`, json({ data })),
        ],
        () => vwLockUnlock(tokens, UUID, SPIN, "lock"),
      ),
      VwCommandError,
    );
  }
});

test("forced refresh is a bodyless carnet-authenticated POST; acceptance is not vehicle response", async () => {
  await withFetchQueue(
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
    () => vwForceRefresh(tokens, UUID, SPIN),
  );
});

test("charge start/stop use immediate mode; charge target preserves existing settings", async () => {
  for (const action of ["start", "stop"]) {
    assert.equal(
      await withFetchQueue(
        [
          route(
            "POST",
            `${API}/ev/v1/vehicle/${UUID}/charging/${action}`,
            json({ data: { result: 0, correlationId: CORRELATION } }),
            (init) => {
              bearer(CARNET)(init);
              bodyJson({ actionMode: "immediate" })(init);
            },
          ),
        ],
        () =>
          action === "start"
            ? vwChargeStart(CARNET, UUID)
            : vwChargeStop(CARNET, UUID),
      ),
      CORRELATION,
    );
  }
  const settings = {
    autoUnlockPlugWhenCharged: "off",
    maxChargingCurrent: "max",
    targetSOCPercentage: 80,
  };
  assert.equal(
    await withFetchQueue(
      [
        route(
          "GET",
          `${API}/ev/v1/vehicle/${UUID}/charging/settings`,
          json({ data: { chargingSettings: settings } }),
          bearer(CARNET),
        ),
        route(
          "PUT",
          `${API}/ev/v1/vehicle/${UUID}/charging/settings`,
          json({ data: { result: 0, correlationId: CORRELATION } }),
          (init) => {
            bearer(CARNET)(init);
            bodyJson({ ...settings, targetSOCPercentage: 90 })(init);
          },
        ),
      ],
      () => vwSetChargeLimit(CARNET, UUID, 90),
    ),
    CORRELATION,
  );
});

test("climate read, start/stop and temperature write preserve current payloads/settings", async () => {
  const summary = `${API}/ev/v1/user/${USER}/vehicle/${UUID}/summary?tempUnit=fahrenheit`;
  const state = await withFetchQueue(
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
    () => vwGetClimate(CARNET, tokens, UUID),
  );
  assert.deepEqual(state, { on: true, remainingMin: 15, targetTempF: 72 });
  for (const action of ["start", "stop"]) {
    assert.equal(
      await withFetchQueue(
        [
          route(
            "POST",
            `${API}/ev/v1/vehicle/${UUID}/pretripclimate/${action}`,
            json({ data: { result: 0, correlationId: CORRELATION } }),
            (init) => {
              bearer(CARNET)(init);
              assert.equal(init.body, null);
            },
          ),
        ],
        () =>
          action === "start"
            ? vwClimateStart(CARNET, UUID)
            : vwClimateStop(CARNET, UUID),
      ),
      CORRELATION,
    );
  }
  const settingsUrl = `${API}/ev/v1/vehicle/${UUID}/pretripclimate/settings?tempUnit=fahrenheit`;
  const elements = { mirrorHeatingEnabled: true, zoneFrontLeftEnabled: true };
  assert.equal(
    await withFetchQueue(
      [
        route(
          "GET",
          settingsUrl,
          json({
            data: {
              climatizationWithoutExternalPower: false,
              climatizationElementSettings: elements,
            },
          }),
          bearer(CARNET),
        ),
        route(
          "PUT",
          settingsUrl,
          json({ data: { result: 0, correlationId: CORRELATION } }),
          (init) => {
            bearer(CARNET)(init);
            bodyJson({
              targetTemperature: { temperature: 68, unit: "fahrenheit" },
              climatizationWithoutExternalPower: false,
              climatizationElementSettings: elements,
            })(init);
          },
        ),
      ],
      () => vwSetClimateTemp(CARNET, UUID, 68),
    ),
    CORRELATION,
  );
});

test("EV busy code is specialized; 401 is auth; generic 429 and 5xx are command errors", async () => {
  for (const [status, body, Type] of [
    [429, { error: { errorCode: "EV_THRESHOLD_EXCEEDED" } }, VwBusyError],
    [401, {}, VwAuthError],
    [429, {}, VwCommandError],
    [503, {}, VwCommandError],
  ]) {
    await assert.rejects(
      withFetchQueue(
        [
          route(
            "POST",
            `${API}/ev/v1/vehicle/${UUID}/charging/start`,
            json(body, status),
          ),
        ],
        () => vwChargeStart(CARNET, UUID),
      ),
      Type,
    );
  }
});

const historyUrl = `${API}/history/v1/vehicle/${UUID}/correlationId/${CORRELATION}/ro/`;
const history = (eventStatus, payloadString) =>
  json({
    data: {
      responseBody: JSON.stringify({
        ...(eventStatus ? { eventStatus } : {}),
        ...(payloadString ? { payloadString } : {}),
      }),
    },
  });

test("history polls before reads; accepted then success confirms; string responseStatus is ignored", async () => {
  const waits = [];
  const timer = mock.method(globalThis, "setTimeout", (callback, ms) => {
    waits.push(ms);
    globalThis.queueMicrotask(callback);
    return 1;
  });
  try {
    assert.deepEqual(
      await withFetchQueue(
        [
          route(
            "GET",
            historyUrl,
            history({ responseOutcome: 1 }),
            bearer(CARNET),
          ),
          route(
            "GET",
            historyUrl,
            history({ responseOutcome: 2, responseStatus: "1" }),
            bearer(CARNET),
          ),
        ],
        () =>
          vwAwaitCommandResult(CARNET, UUID, CORRELATION, {
            attempts: 2,
            intervalMs: 12,
          }),
      ),
      { confirmed: true },
    );
    assert.deepEqual(waits, [12, 12]);
  } finally {
    timer.mock.restore();
  }
});

test("history explicit failure throws; pending, malformed and 503 exhaust to unconfirmed", async () => {
  const timer = mock.method(globalThis, "setTimeout", (callback) => {
    globalThis.queueMicrotask(callback);
    return 1;
  });
  try {
    await assert.rejects(
      withFetchQueue(
        [
          route(
            "GET",
            historyUrl,
            history(
              { responseOutcome: 3 },
              JSON.stringify({
                data: { cause: "synthetic ignition condition" },
              }),
            ),
          ),
        ],
        () =>
          vwAwaitCommandResult(CARNET, UUID, CORRELATION, {
            attempts: 1,
            intervalMs: 1,
          }),
      ),
      /synthetic ignition condition/,
    );
    assert.deepEqual(
      await withFetchQueue(
        [
          route("GET", historyUrl, history({ responseOutcome: 1 })),
          route(
            "GET",
            historyUrl,
            json({ data: { responseBody: "{malformed" } }),
          ),
          route("GET", historyUrl, json({}, 503)),
        ],
        () =>
          vwAwaitCommandResult(CARNET, UUID, CORRELATION, {
            attempts: 3,
            intervalMs: 1,
          }),
      ),
      { confirmed: false },
    );
    await assert.rejects(
      withFetchQueue([route("GET", historyUrl, json({}, 401))], () =>
        vwAwaitCommandResult(CARNET, UUID, CORRELATION, {
          attempts: 1,
          intervalMs: 1,
        }),
      ),
      VwAuthError,
    );
  } finally {
    timer.mock.restore();
  }
});

test("history legacy success code confirms, rejected outcome fails, and 403 reads are swallowed", async () => {
  const timer = mock.method(globalThis, "setTimeout", (callback) => {
    globalThis.queueMicrotask(callback);
    return 1;
  });
  try {
    assert.deepEqual(
      await withFetchQueue(
        [
          route(
            "GET",
            historyUrl,
            history({ responseCode: "4101 : RO_DOOR_SUCCESS" }),
          ),
        ],
        () =>
          vwAwaitCommandResult(CARNET, UUID, CORRELATION, {
            attempts: 1,
            intervalMs: 1,
          }),
      ),
      { confirmed: true },
    );
    await assert.rejects(
      withFetchQueue(
        [
          route(
            "GET",
            historyUrl,
            history({ responseOutcome: 0, responseCode: "synthetic failure" }),
          ),
        ],
        () =>
          vwAwaitCommandResult(CARNET, UUID, CORRELATION, {
            attempts: 1,
            intervalMs: 1,
          }),
      ),
      VwCommandError,
    );
    assert.deepEqual(
      await withFetchQueue([route("GET", historyUrl, json({}, 403))], () =>
        vwAwaitCommandResult(CARNET, UUID, CORRELATION, {
          attempts: 1,
          intervalMs: 1,
        }),
      ),
      { confirmed: false },
    );
  } finally {
    timer.mock.restore();
  }
});

test("network failure is swallowed during history polling, then reports unconfirmed", async () => {
  const timer = mock.method(globalThis, "setTimeout", (callback) => {
    globalThis.queueMicrotask(callback);
    return 1;
  });
  try {
    assert.deepEqual(
      await withFetchQueue(
        [
          route("GET", historyUrl, () => {
            throw new TypeError("synthetic network failure");
          }),
        ],
        () =>
          vwAwaitCommandResult(CARNET, UUID, CORRELATION, {
            attempts: 1,
            intervalMs: 1,
          }),
      ),
      { confirmed: false },
    );
  } finally {
    timer.mock.restore();
  }
});

test("wake maps 401 to auth, 429/503 and explicit result rejection to command errors", async () => {
  for (const [response, Type] of [
    [json({}, 401), VwAuthError],
    [json({}, 429), VwCommandError],
    [json({}, 503), VwCommandError],
    [json({ data: { result: 7 } }), VwCommandError],
  ]) {
    await assert.rejects(
      withFetchQueue(
        [
          ...spinRoutes(),
          route("POST", `${API}/rvs/v1/vehicle/${UUID}/refresh`, response),
        ],
        () => vwForceRefresh(tokens, UUID, SPIN),
      ),
      Type,
    );
  }
});

test("wake fetch has no AbortSignal or deadline; a silent vehicle transport waits until resolved", async () => {
  let release;
  let reached;
  const entered = new Promise((resolve) => {
    reached = resolve;
  });
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const request = withFetchQueue(
    [
      ...spinRoutes(),
      route(
        "POST",
        `${API}/rvs/v1/vehicle/${UUID}/refresh`,
        () => {
          reached();
          return pending;
        },
        (init) => assert.equal(init.signal, undefined),
      ),
    ],
    () => vwForceRefresh(tokens, UUID, SPIN),
  );
  await entered;
  let settled = false;
  void request.then(() => {
    settled = true;
  });
  await new Promise((resolve) => globalThis.setImmediate(resolve));
  assert.equal(settled, false);
  release(json({ data: { result: 0 } }));
  await request;
});

test("climate off and missing summary fields normalize to false/null", async () => {
  for (const payload of [
    {
      data: {
        climateStatus: { climateStatusReport: { climateStatusInd: "off" } },
      },
    },
    { data: {} },
  ]) {
    assert.deepEqual(
      await withFetchQueue(
        [
          route(
            "GET",
            `${API}/ev/v1/user/${USER}/vehicle/${UUID}/summary?tempUnit=fahrenheit`,
            json(payload),
            bearer(CARNET),
          ),
        ],
        () => vwGetClimate(CARNET, tokens, UUID),
      ),
      {
        on: false,
        remainingMin: null,
        targetTempF: null,
      },
    );
  }
});

test("failed climate settings read currently falls through to a PUT with default settings", async () => {
  const settingsUrl = `${API}/ev/v1/vehicle/${UUID}/pretripclimate/settings?tempUnit=fahrenheit`;
  assert.equal(
    await withFetchQueue(
      [
        route("GET", settingsUrl, json({}, 503), bearer(CARNET)),
        route(
          "PUT",
          settingsUrl,
          json({ data: { result: 0, correlationId: CORRELATION } }),
          (init) => {
            bearer(CARNET)(init);
            bodyJson({
              targetTemperature: { temperature: 68, unit: "fahrenheit" },
              climatizationWithoutExternalPower: true,
              climatizationElementSettings: {
                climatizationAtUnlock: true,
                mirrorHeatingEnabled: false,
                zoneFrontLeftEnabled: false,
                zoneFrontRightEnabled: false,
                zoneRearLeftEnabled: false,
                zoneRearRightEnabled: false,
              },
            })(init);
          },
        ),
      ],
      () => vwSetClimateTemp(CARNET, UUID, 68),
    ),
    CORRELATION,
  );
});
