import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { getPublicKey } from "nostr-tools";
import { createBuzzKeyClient } from "../../../app/src/buzzkey-client.ts";
import { signNip98 } from "../../../app/src/nip98.ts";
import { VehicleRepository } from "../../storage/repositories.ts";
import {
  ACCESS,
  API,
  CARNET,
  ID_TOKEN,
  json,
  REFRESH,
  route,
  UUID,
  VIN,
} from "../../tests/harness.mjs";
import {
  fixture,
  offline,
  origin,
  password,
  secret,
  seed,
  spin,
} from "./lock-fixture.mjs";

const NOW = 1_900_000_000_000;
const firstKey = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondKey = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const correlation = "synthetic-lock-correlation";
const historyPath = `${API}/history/v1/vehicle/${UUID}/correlationId/${correlation}/ro/`;
async function ready(t, options = {}) {
  const f = await fixture(t, { now: () => NOW, ...options });
  const accountId = await seed(f);
  const user = await f.services.db.getUser("owner");
  await f.services.db.saveCarnetToken(user.account, UUID, {
    token: CARNET,
    expiresAt: Date.now() + 3_600_000,
  });
  f.storage.db
    .prepare(
      "INSERT INTO owner_vw_connection(owner_id,account_id,state,verified_at) VALUES ('owner',?,'connected',?)",
    )
    .run(accountId, NOW);
  return { f, accountId, vehicle: user.vehicles[0] };
}
const mint = () => [
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
function submit(
  action,
  response = json({ data: { result: 0, correlationId: correlation } }),
  inspect = () => undefined,
) {
  return [
    ...mint(),
    route("PUT", `${API}/lockunlock/v1/vehicle/${UUID}`, response, (init) => {
      assert.equal(init.headers.authorization, `Bearer ${CARNET}`);
      assert.deepEqual(JSON.parse(init.body), { lock: action === "lock" });
      inspect(init);
    }),
  ];
}
function history(result = "success", inspect = () => undefined) {
  const response =
    result === "success"
      ? {
          data: {
            responseBody: JSON.stringify({
              eventStatus: {
                responseOutcome: 2,
                responseCode: "RO_DOOR_SUCCESS",
              },
            }),
          },
        }
      : result === "failed"
        ? {
            data: {
              responseBody: JSON.stringify({
                eventStatus: {
                  responseOutcome: 3,
                  responseCode: "SYNTHETIC_REJECTED",
                },
              }),
            },
          }
        : {
            data: {
              responseBody: JSON.stringify({
                eventStatus: { responseOutcome: 1 },
              }),
            },
          };
  return route("GET", historyPath, json(response), (init) => {
    assert.equal(init.headers.authorization, `Bearer ${CARNET}`);
    inspect(init);
  });
}
function observed(lock, { timestamp = NOW, contradictory = false } = {}) {
  const exteriorStatus =
    lock === "unknown"
      ? {}
      : {
          secure: lock === "locked" ? "SECURE" : "UNSECURE",
          doorLockStatus: {
            frontLeft:
              lock === "unlocked" || contradictory ? "UNLOCKED" : "LOCKED",
            carCapturedTimestamp: timestamp,
          },
        };
  return [
    route(
      "GET",
      `${API}/rvs/v1/vehicle/${UUID}`,
      json({ data: { timestamp, exteriorStatus } }),
    ),
    route(
      "GET",
      `${API}/ev/v1/vehicle/${UUID}/charge/summary`,
      json({ data: {} }),
    ),
  ];
}
function input(vehicle, action = "unlock", key = firstKey) {
  return { vehicleId: vehicle.id, action, idempotencyKey: key };
}
async function terminal(f, key = firstKey) {
  for (let i = 0; i < 35; i++) {
    await setTimeout(5);
    const command = await f.client.lockCommandByKey(key);
    if (
      ["confirmed", "failed", "timed_out", "unknown"].includes(command.status)
    )
      return command;
  }
  throw new Error("Synthetic command did not settle");
}
async function run(f, vehicle, action, steps, key = firstKey) {
  return offline(steps, async () => {
    const receipt = await f.client.requestLock(input(vehicle, action, key));
    assert.equal(receipt.status, "requested");
    return terminal(f, key);
  });
}

for (const action of ["lock", "unlock"]) {
  const target = action === "lock" ? "locked" : "unlocked";
  const conflicting = action === "lock" ? "unlocked" : "locked";
  test(`${action}: intent/submission/acceptance/correlation persist before fresh target observation confirms`, async (t) => {
    const { f, vehicle } = await ready(t);
    const result = await run(f, vehicle, action, [
      ...submit(action, undefined, () => {
        const row = f.storage.db.prepare("SELECT * FROM commands").get();
        assert.equal(row.status, "submitting");
        assert.equal(row.submitted_at, NOW);
        assert.equal(row.kind, action);
        assert.equal(row.requesting_pubkey, getPublicKey(secret));
        assert.equal(row.idempotency_key, firstKey);
        assert.equal(
          new VehicleRepository(f.storage).getCurrentState(vehicle.id),
          null,
        );
      }),
      history("success", () => {
        const row = f.storage.db.prepare("SELECT * FROM commands").get();
        assert.equal(row.status, "waiting_for_vehicle");
        assert.equal(row.accepted_at, NOW);
        assert.equal(row.correlation_id, correlation);
      }),
      ...observed(target),
    ]);
    assert.equal(result.status, "confirmed");
    assert.equal(result.historyConfirmed, true);
    assert.equal(result.observation.lock, target);
    assert.equal(result.completedAt, NOW);
    assert.equal(
      new VehicleRepository(f.storage).getCurrentState(vehicle.id).state
        .security.lock,
      target,
    );
    assert.equal(result.correlationId, undefined);
    assert.equal(result.idempotencyKey, undefined);
    assert.equal(result.requesting_pubkey, undefined);
    await f.restart();
    assert.deepEqual(await f.client.lockCommandByKey(firstKey), result);
  });
  test(`${action}: history success with conflicting vehicle state never confirms or overwrites observed lock`, async (t) => {
    const { f, vehicle } = await ready(t);
    const result = await run(f, vehicle, action, [
      ...submit(action),
      history(),
      ...observed(conflicting),
    ]);
    assert.equal(result.status, "timed_out");
    assert.equal(result.failureCode, "conflicting_observation");
    assert.equal(result.historyConfirmed, true);
    assert.equal(result.observation.lock, conflicting);
    assert.equal(
      new VehicleRepository(f.storage).getCurrentState(vehicle.id).state
        .security.lock,
      conflicting,
    );
  });
  test(`${action}: VW rejection is persisted as failure without changing observation`, async (t) => {
    const { f, vehicle } = await ready(t);
    const result = await run(
      f,
      vehicle,
      action,
      submit(action, json({ data: { result: 7 } })),
    );
    assert.equal(result.status, "failed");
    assert.equal(result.failureCode, "vw_rejected");
    assert.equal(result.acceptedAt, null);
    assert.equal(result.observation, null);
    assert.equal(
      new VehicleRepository(f.storage).getCurrentState(vehicle.id),
      null,
    );
  });
  test(`${action}: eight unconfirmed history reads time out even when observed state matches target`, async (t) => {
    const { f, vehicle } = await ready(t);
    const result = await run(f, vehicle, action, [
      ...submit(action),
      ...Array.from({ length: 8 }, () => history("queued")),
      ...observed(target),
    ]);
    assert.equal(result.status, "timed_out");
    assert.equal(result.historyConfirmed, false);
    assert.equal(result.failureCode, "confirmation_timeout");
    assert.equal(result.observation.lock, target);
  });
  test(`${action}: vehicle history rejection persists failed result and actual observation`, async (t) => {
    const { f, vehicle } = await ready(t);
    const result = await run(f, vehicle, action, [
      ...submit(action),
      history("failed"),
      ...observed(conflicting),
    ]);
    assert.equal(result.status, "failed");
    assert.equal(result.failureCode, "vehicle_rejected");
    assert.equal(result.observation.lock, conflicting);
  });
}

test("known optimistic unlock defect is corrected: eight queued reads plus locked VW status stay locked and unconfirmed", async (t) => {
  const { f, vehicle } = await ready(t);
  const result = await run(f, vehicle, "unlock", [
    ...submit("unlock"),
    ...Array.from({ length: 8 }, () => history("queued")),
    ...observed("locked"),
  ]);
  assert.equal(result.status, "timed_out");
  assert.equal(result.failureCode, "conflicting_observation");
  assert.equal(result.historyConfirmed, false);
  assert.equal(result.observation.lock, "locked");
  assert.equal(
    new VehicleRepository(f.storage).getCurrentState(vehicle.id).state.security
      .lock,
    "locked",
  );
  assert.equal(
    f.storage.db.prepare("SELECT COUNT(*) AS n FROM legacy_snapshots").get().n,
    0,
  );
});

test("missing/ambiguous, stale and internally conflicting status cannot confirm an unlock", async (t) => {
  for (const observation of [
    observed("unknown"),
    observed("unlocked", { timestamp: NOW - 1 }),
    observed("locked", { contradictory: true }),
  ]) {
    const { f, vehicle } = await ready(t);
    const result = await run(f, vehicle, "unlock", [
      ...submit("unlock"),
      history(),
      ...observation,
    ]);
    assert.equal(result.status, "timed_out");
    if (result.observation.sourceUpdatedAt !== NOW - 1)
      assert.equal(result.observation.lock, "unknown");
  }
});

test("duplicate freshly signed requests and conflicting key reuse never send a second VW command", async (t) => {
  const { f, vehicle } = await ready(t);
  await offline(
    [...submit("unlock"), history(), ...observed("unlocked")],
    async (calls) => {
      const initial = await f.client.requestLock(input(vehicle));
      const duplicate = await f.client.requestLock(input(vehicle));
      assert.equal(duplicate.id, initial.id);
      await terminal(f);
      const final = await f.client.requestLock(input(vehicle));
      assert.equal(final.id, initial.id);
      assert.equal(final.status, "confirmed");
      await assert.rejects(
        f.client.requestLock(input(vehicle, "lock")),
        (e) => e.code === "command_conflict",
      );
      assert.equal(
        calls.filter((call) => call.url.includes("/lockunlock/")).length,
        1,
      );
      assert.equal(
        f.storage.db.prepare("SELECT COUNT(*) AS n FROM commands").get().n,
        1,
      );
    },
  );
});

test("mobile response lost after VW acceptance: retry returns original command without resubmission", async (t) => {
  const { f, vehicle } = await ready(t);
  const losing = createBuzzKeyClient({
    origin,
    getIdentity: async () => ({
      secretKey: secret,
      pubkey: getPublicKey(secret),
    }),
    ...f.material,
    fetcher: async (...args) => {
      await f.raw(...args);
      await terminal(f);
      throw new Error("synthetic lost mobile response");
    },
  });
  await offline(
    [...submit("unlock"), history(), ...observed("unlocked")],
    async (calls) => {
      await assert.rejects(
        losing.requestLock(input(vehicle)),
        (e) => e.code === "backend_unreachable",
      );
      const result = await f.client.requestLock(input(vehicle));
      assert.equal(result.status, "confirmed");
      assert.equal(
        calls.filter((call) => call.url.includes("/lockunlock/")).length,
        1,
      );
    },
  );
});

test("same key after Node restart returns durable result; distinct key sends a distinct command", async (t) => {
  const { f, vehicle } = await ready(t);
  const initial = await run(f, vehicle, "unlock", [
    ...submit("unlock"),
    history(),
    ...observed("unlocked"),
  ]);
  await f.restart();
  await offline([], async () =>
    assert.equal((await f.client.requestLock(input(vehicle))).id, initial.id),
  );
  const next = await run(
    f,
    vehicle,
    "lock",
    [...submit("lock"), history(), ...observed("locked")],
    secondKey,
  );
  assert.notEqual(next.id, initial.id);
});

for (const status of [
  "requested",
  "submitting",
  "accepted",
  "waiting_for_vehicle",
]) {
  test(`restart from ${status} never resubmits and preserves queryable uncertainty/reconciliation`, async (t) => {
    const { f, vehicle, accountId } = await ready(t);
    const command = f.services.commands.repository.intent(
      input(vehicle),
      accountId,
      f.device.id,
      f.device.pubkey,
      NOW,
    ).command;
    if (status !== "requested")
      f.services.commands.repository.update(command.id, {
        status,
        submittedAt: NOW,
        ...(["accepted", "waiting_for_vehicle"].includes(status)
          ? { acceptedAt: NOW, correlationId: correlation }
          : {}),
      });
    await f.restart();
    await offline([], async () => {
      const result = await f.client.requestLock(input(vehicle));
      assert.equal(result.id, command.id);
      assert.equal(
        result.status,
        ["requested", "submitting"].includes(status)
          ? "unknown"
          : "waiting_for_vehicle",
      );
      assert.equal(
        result.failureCode,
        status === "requested"
          ? "restart_before_submission"
          : status === "submitting"
            ? "restart_during_submission"
            : "reconciliation_required",
      );
    });
    if (["accepted", "waiting_for_vehicle"].includes(status))
      await offline([history(), ...observed("unlocked")], async (calls) => {
        const receipt = await f.client.reconcileLockCommand(command.id);
        assert.equal(receipt.status, "waiting_for_vehicle");
        const result = await terminal(f);
        assert.equal(result.status, "confirmed");
        assert.equal(
          calls.some((call) => call.url.includes("/lockunlock/")),
          false,
        );
      });
  });
}

test("unresolved vehicle command prevents a different in-flight intent", async (t) => {
  const { f, vehicle } = await ready(t);
  let release, entered;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const block = new Promise((resolve) => {
    release = resolve;
  });
  await offline(
    [
      ...submit("unlock", async () => {
        entered();
        await block;
        return json({ data: { result: 0, correlationId: correlation } });
      }),
      history(),
      ...observed("unlocked"),
    ],
    async () => {
      await f.client.requestLock(input(vehicle));
      await waiting;
      try {
        await assert.rejects(
          f.client.requestLock(input(vehicle, "lock", secondKey)),
          (e) => e.code === "command_conflict",
        );
      } finally {
        release();
      }
      await terminal(f);
    },
  );
});

test("ambiguous submission errors/missing correlation IDs produce unknown and never retry the PUT", async (t) => {
  for (const response of [
    () => {
      throw new Error(password + " " + spin + " " + ACCESS);
    },
    json({ data: { result: 0 } }),
    json({}, 503),
  ]) {
    const { f, vehicle } = await ready(t);
    const result = await run(f, vehicle, "unlock", submit("unlock", response));
    assert.equal(result.status, "unknown");
    assert.equal(result.failureCode, "submission_uncertain");
    await offline([], async () =>
      assert.equal((await f.client.requestLock(input(vehicle))).id, result.id),
    );
  }
});

test("submission deadline fences late VW responses and persists unknown rather than false success", async (t) => {
  const { f, vehicle } = await ready(t, { deadlineMs: 30 });
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  await offline(
    submit("unlock", async () => {
      await blocked;
      return json({ data: { result: 0, correlationId: correlation } });
    }),
    async () => {
      await f.client.requestLock(input(vehicle));
      const result = await terminal(f);
      assert.equal(result.status, "unknown");
      assert.equal(result.acceptedAt, null);
      release();
      await setTimeout(5);
      assert.equal(
        (await f.client.lockCommandByKey(firstKey)).status,
        "unknown",
      );
    },
  );
});

test("history deadline persists accepted command as timed out without observed optimism", async (t) => {
  const { f, vehicle } = await ready(t, { deadlineMs: 30 });
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  await offline(
    [
      ...submit("unlock"),
      route("GET", historyPath, async () => {
        await blocked;
        return json({
          data: {
            responseBody: JSON.stringify({
              eventStatus: { responseOutcome: 2 },
            }),
          },
        });
      }),
    ],
    async () => {
      await f.client.requestLock(input(vehicle));
      const result = await terminal(f);
      assert.equal(result.status, "timed_out");
      assert.equal(result.acceptedAt, NOW);
      assert.equal(result.observation, null);
      release();
      await setTimeout(5);
      assert.equal(
        (await f.client.lockCommandByKey(firstKey)).status,
        "timed_out",
      );
    },
  );
});

test("missing PIN fails durably before protocol submission", async (t) => {
  const { f, vehicle, accountId } = await ready(t);
  f.secrets().delete({ accountId, purpose: "vw_spin" });
  const result = await run(f, vehicle, "unlock", []);
  assert.equal(result.status, "failed");
  assert.equal(result.failureCode, "preparation_failed");
  assert.equal(result.submittedAt, null);
});

test("anonymous, unpaired, revoked and replayed command requests fail before VW", async (t) => {
  const { f, vehicle } = await ready(t);
  const path = "/api/v1/commands";
  const body = JSON.stringify(input(vehicle));
  await offline([], async () => {
    assert.equal(
      (await f.raw(origin + path, { method: "POST", body })).status,
      401,
    );
  });
  const unpaired = await signNip98({
    url: origin + path,
    method: "POST",
    body,
    material: {
      ...f.material,
      secretKey: Uint8Array.from({ length: 32 }, () => 3),
    },
  });
  await offline([], async () =>
    assert.equal(
      (
        await f.raw(origin + path, {
          method: "POST",
          body,
          headers: { authorization: unpaired.authorization },
        })
      ).status,
      401,
    ),
  );
  const signed = await signNip98({
    url: origin + path,
    method: "POST",
    body,
    material: f.material,
  });
  await offline(
    [...submit("unlock"), history(), ...observed("unlocked")],
    async () => {
      assert.equal(
        (
          await f.raw(origin + path, {
            method: "POST",
            body,
            headers: { authorization: signed.authorization },
          })
        ).status,
        202,
      );
      await terminal(f);
      assert.equal(
        (
          await f.raw(origin + path, {
            method: "POST",
            body,
            headers: { authorization: signed.authorization },
          })
        ).status,
        401,
      );
    },
  );
  f.devices.revoke(f.device.id, Date.now());
  await offline([], () =>
    assert.rejects(
      f.client.requestLock(input(vehicle, "lock", secondKey)),
      (e) => e.code === "authorization_rejected",
    ),
  );
});

test("authoritative account/vehicle authorization and strict request shape reject spoofed identity", async (t) => {
  const { f, vehicle } = await ready(t);
  const vehicles = new VehicleRepository(f.storage);
  const foreignId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  vehicles.createAccount("synthetic-other-account", 0);
  vehicles.upsertVehicle({
    id: foreignId,
    accountId: "synthetic-other-account",
    reference: "synthetic-other-reference",
    vin: "TESTOTHER",
    displayName: null,
    model: null,
    createdAt: 0,
  });
  await offline([], async () => {
    await assert.rejects(
      f.client.requestLock({
        vehicleId: foreignId,
        action: "unlock",
        idempotencyKey: firstKey,
      }),
      (e) => e.code === "command_missing",
    );
    await assert.rejects(
      f.client.requestLock({
        ...input(vehicle),
        vin: VIN,
        faceIdVerified: true,
      }),
      (e) => e.code === "invalid_response",
    );
    f.storage.db.prepare("DELETE FROM owner_account_link").run();
    await assert.rejects(
      f.client.requestLock(input(vehicle)),
      (e) => e.code === "command_missing",
    );
    assert.equal(
      f.storage.db.prepare("SELECT COUNT(*) AS n FROM commands").get().n,
      0,
    );
  });
});

test("command mutation uses stricter control limit and private status reads stay cache-only", async (t) => {
  const { f, vehicle } = await ready(t);
  await offline(
    [...submit("unlock"), history(), ...observed("unlocked")],
    async () => {
      await f.client.requestLock(input(vehicle));
      await terminal(f);
    },
  );
  await offline([], async () => {
    for (let i = 0; i < 9; i++) await f.client.requestLock(input(vehicle));
    await assert.rejects(
      f.client.requestLock(input(vehicle, "lock", secondKey)),
      (e) => e.code === "rate_limited",
    );
    assert.equal(
      (await f.client.lockCommandByKey(firstKey)).status,
      "confirmed",
    );
  });
});

test("raw command errors, receipt and structured logs never expose synthetic secrets", async (t) => {
  const logs = [];
  const log = mock.method(globalThis.console, "log", (...args) =>
    logs.push(args.join(" ")),
  );
  const error = mock.method(globalThis.console, "error", (...args) =>
    logs.push(args.join(" ")),
  );
  t.after(() => {
    log.mock.restore();
    error.mock.restore();
  });
  const { f, vehicle } = await ready(t);
  const result = await run(
    f,
    vehicle,
    "unlock",
    submit("unlock", () => {
      throw new Error(
        [password, spin, ACCESS, REFRESH, ID_TOKEN, CARNET].join(" "),
      );
    }),
  );
  for (const secret of [password, spin, ACCESS, REFRESH, ID_TOKEN, CARNET])
    assert.equal(
      (logs.join("\n") + JSON.stringify(result)).includes(secret),
      false,
    );
  assert.equal(result.failureCode, "submission_uncertain");
});

test("retired optimistic command alias cannot bypass durable semantics", async (t) => {
  const { f } = await ready(t);
  const path = "/rpc/vehicle/command";
  const body = "{}";
  const signed = await signNip98({
    url: origin + path,
    method: "POST",
    body,
    material: f.material,
  });
  await offline([], async () =>
    assert.equal(
      (
        await f.raw(origin + path, {
          method: "POST",
          body,
          headers: { authorization: signed.authorization },
        })
      ).status,
      404,
    ),
  );
});
