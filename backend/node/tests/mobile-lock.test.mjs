import assert from "node:assert/strict";
import { test } from "node:test";
import {
  lockPresentation,
  LockSubmissionCoordinator,
  prepareLockIntent,
  readLockIntent,
  submitLockIntent,
} from "../../../app/src/lock-intent.ts";

const vehicleId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const key = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function storage(initial = null) {
  let value = initial;
  return {
    get: async () => value,
    set: async (next) => {
      value = next;
    },
    clear: async () => {
      value = null;
    },
  };
}

test("mobile restart/network retry reuses persisted nonsecret intent key before signed submission", async () => {
  const store = storage();
  const intent = await prepareLockIntent(store, vehicleId, "unlock", () => key);
  const client = {
    requestLock: async (input) => {
      assert.deepEqual(await readLockIntent(store), input);
      throw new Error("BuzzKey server is unavailable.");
    },
  };
  await assert.rejects(
    submitLockIntent(client, intent, async () => undefined),
    /unavailable/,
  );
  const restored = await prepareLockIntent(store, vehicleId, "unlock", () => {
    throw new Error("must reuse");
  });
  assert.deepEqual(restored, intent);
  await assert.rejects(
    prepareLockIntent(store, vehicleId, "lock", () => key),
    /previous command/,
  );
  assert.deepEqual(Object.keys(JSON.parse(await store.get())).sort(), [
    "action",
    "idempotencyKey",
    "vehicleId",
  ]);
});

test("mobile storage failure/malformed record fail closed before a new intent can be sent", async () => {
  await assert.rejects(
    prepareLockIntent(
      {
        get: async () => null,
        set: async () => {
          throw new Error("storage unavailable");
        },
      },
      vehicleId,
      "unlock",
      () => key,
    ),
    /storage unavailable/,
  );
  await assert.rejects(
    prepareLockIntent(storage("malformed"), vehicleId, "unlock", () => key),
    /invalid/,
  );
});

test("local unlock authorization hook runs before signing; no trusted biometric flag enters payload", async () => {
  const intent = await prepareLockIntent(
    storage(),
    vehicleId,
    "unlock",
    () => key,
  );
  let called = false;
  await assert.rejects(
    submitLockIntent(
      {
        requestLock: async () => {
          called = true;
        },
      },
      intent,
      async () => {
        throw new Error("local authorization cancelled");
      },
    ),
    /cancelled/,
  );
  assert.equal(called, false);
  await submitLockIntent(
    {
      requestLock: async (input) => {
        assert.equal(input.faceIdVerified, undefined);
        called = true;
      },
    },
    intent,
    async () => undefined,
  );
  assert.equal(called, true);
});

test("mobile progress/timeout/unknown never replace observed locked state with requested unlock", () => {
  const cached = { lock: "locked", fetchedAt: 100 };
  for (const status of [
    "requested",
    "submitting",
    "accepted",
    "waiting_for_vehicle",
    "timed_out",
    "unknown",
    "failed",
  ]) {
    const result = lockPresentation(
      { action: "unlock", status, observation: null },
      cached,
      false,
    );
    assert.equal(result.lock, "locked");
    assert.equal(result.physicalLabel, "Locked");
    assert.notEqual(result.label, "Unlocked");
  }
  assert.equal(
    lockPresentation(
      { action: "unlock", status: "timed_out", observation: null },
      cached,
      false,
    ).label,
    "Could not confirm",
  );
  assert.equal(
    lockPresentation(undefined, cached, true, "unlock").label,
    "Unlocking…",
  );
});

test("mobile lock icon uses newest actual observation and retains unknown without evidence", () => {
  assert.equal(
    lockPresentation(
      {
        action: "unlock",
        status: "confirmed",
        observation: { lock: "unlocked", fetchedAt: 200 },
      },
      { lock: "locked", fetchedAt: 100 },
      false,
    ).physicalLabel,
    "Unlocked",
  );
  assert.equal(
    lockPresentation(
      {
        action: "unlock",
        status: "confirmed",
        observation: { lock: "unlocked", fetchedAt: 50 },
      },
      { lock: "locked", fetchedAt: 100 },
      false,
    ).physicalLabel,
    "Locked",
  );
  assert.equal(
    lockPresentation(
      { action: "lock", status: "accepted", observation: null },
      { lock: "unknown", fetchedAt: 0 },
      false,
    ).physicalLabel,
    "Status unknown",
  );
});

test("duplicate mobile taps coalesce before storage/signing; a conflicting tap fails closed", async () => {
  const coordinator = new LockSubmissionCoordinator();
  const store = storage();
  let submissions = 0;
  const submit = async () => {
    submissions++;
    return prepareLockIntent(store, vehicleId, "unlock", () => key);
  };
  const first = coordinator.run("synthetic-device-vehicle", "unlock", submit);
  const duplicate = coordinator.run(
    "synthetic-device-vehicle",
    "unlock",
    submit,
  );
  assert.equal(first, duplicate);
  await assert.rejects(
    coordinator.run("synthetic-device-vehicle", "lock", submit),
    /previous command/,
  );
  await first;
  assert.equal(submissions, 1);
});
