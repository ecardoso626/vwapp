import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandRepository } from "../repositories.ts";
import { seededStore, vehicleState } from "./helper.mjs";

test("vehicle identity and unknown state round-trip with every timestamp", (t) => {
  const { vehicles } = seededStore(t);
  const state = vehicleState();
  state.freshness.sourceCapturedAt = 1_699_999_990_000;
  state.freshness.rvsUpdatedAt = 1_699_999_980_000;
  state.freshness.chargeUpdatedAt = 1_699_999_970_000;
  state.freshness.doorsUpdatedAt = 1_699_999_960_000;
  state.freshness.locksUpdatedAt = 1_699_999_950_000;
  state.freshness.windowsUpdatedAt = 1_699_999_940_000;
  assert.equal(
    vehicles.getVehicle("synthetic-vehicle").vin,
    "TESTVIN0000000000",
  );
  assert.deepEqual(
    vehicles.saveState("synthetic-vehicle", state, 1_700_000_000_100),
    { revision: 1, observed: true, sampled: false },
  );
  const current = vehicles.getCurrentState("synthetic-vehicle");
  assert.equal(current.revision, 1);
  assert.equal(current.persistedAt, 1_700_000_000_100);
  assert.deepEqual(current.state, {
    ...state,
    identity: { ...state.identity, localId: "synthetic-vehicle" },
  });
  assert.equal(current.state.security.lock, "unknown");
  assert.equal(current.state.security.openDoors, null);
  assert.equal(current.state.battery.socPercent, null);
});

test("history records meaningful changes, not every identical fetch", (t) => {
  const { vehicles } = seededStore(t);
  const base =
    Math.floor(1_700_000_000_000 / (15 * 60_000)) * (15 * 60_000) + 60_000;
  const first = vehicleState(base);
  first.battery.socPercent = 60;
  first.battery.estimatedRangeKm = 300;
  first.odometerKm = 12_345;
  const unchanged = globalThis.structuredClone(first);
  unchanged.freshness.fetchedAt += 60_000;
  const changed = globalThis.structuredClone(unchanged);
  changed.freshness.fetchedAt += 60_000;
  changed.battery.socPercent = 59;
  assert.deepEqual(vehicles.saveState("synthetic-vehicle", first, 10), {
    revision: 1,
    observed: true,
    sampled: true,
  });
  assert.deepEqual(vehicles.saveState("synthetic-vehicle", unchanged, 11), {
    revision: 2,
    observed: false,
    sampled: false,
  });
  assert.deepEqual(vehicles.saveState("synthetic-vehicle", changed, 12), {
    revision: 3,
    observed: true,
    sampled: false,
  });
  assert.equal(
    vehicles.getCurrentState("synthetic-vehicle").state.battery.socPercent,
    59,
  );
  assert.deepEqual(
    vehicles
      .listObservations("synthetic-vehicle")
      .map((row) => row.state.battery.socPercent),
    [60, 59],
  );
  const later = globalThis.structuredClone(changed);
  later.freshness.fetchedAt += 15 * 60_000;
  const result = vehicles.saveState("synthetic-vehicle", later, 13);
  assert.equal(result.observed, false);
  assert.equal(result.sampled, true);
  assert.equal(vehicles.listTelemetrySamples("synthetic-vehicle").length, 2);
});

test("source freshness changes produce distinct observations and preserve order", (t) => {
  const { vehicles } = seededStore(t);
  const first = vehicleState();
  first.freshness.sourceCapturedAt = 100;
  const next = globalThis.structuredClone(first);
  next.freshness.fetchedAt += 1_000;
  next.freshness.sourceCapturedAt = 200;
  vehicles.saveState("synthetic-vehicle", first, 1);
  vehicles.saveState("synthetic-vehicle", next, 2);
  assert.deepEqual(
    vehicles
      .listObservations("synthetic-vehicle")
      .map((row) => row.state.freshness.sourceCapturedAt),
    [100, 200],
  );
});

test("current state and observation insert roll back together on error", (t) => {
  const { store, vehicles } = seededStore(t);
  const first = vehicleState();
  vehicles.saveState("synthetic-vehicle", first, 1);
  store.db
    .exec(`CREATE TRIGGER fail_synthetic_observation BEFORE INSERT ON vehicle_observations
    BEGIN SELECT RAISE(ABORT, 'synthetic observation failure'); END`);
  const next = globalThis.structuredClone(first);
  next.battery.socPercent = 55;
  assert.throws(
    () => vehicles.saveState("synthetic-vehicle", next, 2),
    /synthetic observation failure/,
  );
  assert.equal(vehicles.getCurrentState("synthetic-vehicle").revision, 1);
  assert.equal(
    vehicles.getCurrentState("synthetic-vehicle").state.battery.socPercent,
    null,
  );
  assert.equal(vehicles.listObservations("synthetic-vehicle").length, 1);
});

test("commands retain request, acceptance, completion, correlation and failure fields", (t) => {
  const { store } = seededStore(t);
  const commands = new CommandRepository(store);
  commands.insert({
    id: "synthetic-command",
    vehicleId: "synthetic-vehicle",
    kind: "unlock",
    status: "requested",
    requestedAt: 1000,
    acceptedAt: null,
    completedAt: null,
    correlationId: null,
    failureCode: null,
    failureReason: null,
    requestingDeviceId: null,
  });
  commands.update("synthetic-command", {
    status: "accepted",
    acceptedAt: 1100,
    correlationId: "synthetic-correlation",
  });
  commands.update("synthetic-command", {
    status: "failed",
    completedAt: 1200,
    failureCode: "synthetic-rejection",
    failureReason: "Synthetic terminal rejection",
  });
  assert.deepEqual(commands.get("synthetic-command"), {
    id: "synthetic-command",
    vehicleId: "synthetic-vehicle",
    kind: "unlock",
    status: "failed",
    requestedAt: 1000,
    acceptedAt: 1100,
    completedAt: 1200,
    correlationId: "synthetic-correlation",
    failureCode: "synthetic-rejection",
    failureReason: "Synthetic terminal rejection",
    requestingDeviceId: null,
  });
});

test("foreign keys, nested transactions and async transaction callbacks fail safely", (t) => {
  const { store, vehicles } = seededStore(t);
  assert.throws(
    () =>
      vehicles.upsertVehicle({
        id: "orphan",
        accountId: "missing-account",
        reference: "orphan",
        vin: "TESTVIN1111111111",
        displayName: null,
        model: null,
        createdAt: 0,
      }),
    /FOREIGN KEY/,
  );
  assert.throws(
    () =>
      store.transaction(() => {
        vehicles.createAccount("rolled-back-account", 1);
        store.transaction(() => undefined);
      }),
    /Nested SQLite transactions/,
  );
  assert.equal(
    store.db
      .prepare("SELECT id FROM accounts WHERE id = 'rolled-back-account'")
      .get(),
    undefined,
  );
  assert.throws(
    () => store.transaction(async () => undefined),
    /must be synchronous/,
  );
});
