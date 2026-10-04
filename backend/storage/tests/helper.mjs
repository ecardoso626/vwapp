import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStorage } from "../database.ts";
import { VehicleRepository } from "../repositories.ts";

export function temporaryStore(t) {
  const dir = mkdtempSync(join(tmpdir(), "buzzkey-storage-"));
  const path = join(dir, "storage.sqlite");
  const store = SqliteStorage.open(path);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, path, store };
}

export function seededStore(t) {
  const result = temporaryStore(t);
  const vehicles = new VehicleRepository(result.store);
  vehicles.createAccount("synthetic-account", 1_700_000_000_000);
  vehicles.upsertVehicle({
    id: "synthetic-vehicle",
    accountId: "synthetic-account",
    reference: "synthetic-vw-reference",
    vin: "TESTVIN0000000000",
    displayName: "Test Buzz",
    model: "ID. Buzz",
    createdAt: 1_700_000_000_000,
  });
  return { ...result, vehicles };
}

export function vehicleState(fetchedAt = 1_700_000_000_000) {
  return {
    identity: {
      localId: null,
      reference: "synthetic-vw-reference",
      vin: "TESTVIN0000000000",
      name: "Test Buzz",
      model: "ID. Buzz",
    },
    capabilities: {
      lock: "unknown",
      unlock: "unknown",
      charging: "unknown",
      chargeTarget: "unknown",
      climate: "unknown",
      location: "unknown",
    },
    battery: {
      socPercent: null,
      estimatedRangeKm: null,
      charging: "unknown",
      chargePowerKw: null,
      minutesToFull: null,
      pluggedIn: null,
      plugLocked: null,
      targetSocPercent: null,
    },
    security: {
      lock: "unknown",
      openDoors: null,
      openWindows: null,
      unlockedDoors: null,
    },
    climate: { activity: "unknown", targetTempF: null, remainingMin: null },
    odometerKm: null,
    location: null,
    freshness: {
      fetchedAt,
      sourceCapturedAt: null,
      rvsUpdatedAt: null,
      chargeUpdatedAt: null,
      doorsUpdatedAt: null,
      locksUpdatedAt: null,
      windowsUpdatedAt: null,
    },
  };
}
