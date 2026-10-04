import { createHash } from "node:crypto";
import type { VehicleCommandKind, VehicleState } from "@vwapp/contract";
import type { SqliteStorage } from "./database";

export interface VehicleRecord {
  id: string;
  accountId: string;
  reference: string;
  vin: string;
  displayName: string | null;
  model: string | null;
  createdAt: number;
}

export interface ObservationRecord {
  id: number;
  vehicleId: string;
  state: VehicleState;
  recordedAt: number;
}

export interface TelemetrySample {
  vehicleId: string;
  bucketStart: number;
  fetchedAt: number;
  sourceCapturedAt: number | null;
  socPercent: number | null;
  estimatedRangeKm: number | null;
  odometerKm: number | null;
  charging: VehicleState["battery"]["charging"];
  pluggedIn: boolean | null;
  chargePowerKw: number | null;
  targetSocPercent: number | null;
  climateActivity: VehicleState["climate"]["activity"];
  targetTempF: number | null;
}

export type CommandStatus =
  | "requested"
  | "accepted"
  | "confirmed"
  | "failed"
  | "unconfirmed"
  | "cancelled";

export interface CommandRecord {
  id: string;
  vehicleId: string;
  kind: VehicleCommandKind;
  status: CommandStatus;
  requestedAt: number;
  acceptedAt: number | null;
  completedAt: number | null;
  correlationId: string | null;
  failureCode: string | null;
  failureReason: string | null;
  requestingDeviceId: string | null;
}

/** Deterministic JSON rejects unsupported/nonfinite values instead of silently changing evidence. */
function canonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Nonfinite state value");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort())
      result[key] = canonical((value as Record<string, unknown>)[key]);
    return result;
  }
  throw new Error("Unsupported state value");
}
const json = (value: unknown): string => JSON.stringify(canonical(value));
const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const readState = (payload: string, version: number): VehicleState => {
  if (version !== 1)
    throw new Error(`Unsupported vehicle state schema ${String(version)}`);
  return JSON.parse(payload) as VehicleState;
};

export class VehicleRepository {
  private readonly storage: SqliteStorage;

  constructor(storage: SqliteStorage) {
    this.storage = storage;
  }

  createAccount(id: string, createdAt: number): void {
    this.storage.db
      .prepare("INSERT INTO accounts(id, created_at) VALUES (?, ?)")
      .run(id, createdAt);
  }

  upsertVehicle(vehicle: VehicleRecord): void {
    this.storage.db
      .prepare(
        `INSERT INTO vehicles(id, account_id, reference, vin, display_name, model, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET reference=excluded.reference, vin=excluded.vin,
          display_name=excluded.display_name, model=excluded.model`,
      )
      .run(
        vehicle.id,
        vehicle.accountId,
        vehicle.reference,
        vehicle.vin,
        vehicle.displayName,
        vehicle.model,
        vehicle.createdAt,
      );
  }

  getVehicle(id: string): VehicleRecord | null {
    const row = this.storage.db
      .prepare(
        "SELECT id, account_id, reference, vin, display_name, model, created_at FROM vehicles WHERE id = ?",
      )
      .get(id) as
      | {
          id: string;
          account_id: string;
          reference: string;
          vin: string;
          display_name: string | null;
          model: string | null;
          created_at: number;
        }
      | undefined;
    return row === undefined
      ? null
      : {
          id: row.id,
          accountId: row.account_id,
          reference: row.reference,
          vin: row.vin,
          displayName: row.display_name,
          model: row.model,
          createdAt: row.created_at,
        };
  }

  /** Current freshness updates on every read; history records only meaningful change. */
  saveState(
    vehicleId: string,
    state: VehicleState,
    recordedAt: number,
    sampleIntervalMs = 15 * 60_000,
  ): { revision: number; observed: boolean; sampled: boolean } {
    if (!Number.isInteger(sampleIntervalMs) || sampleIntervalMs <= 0)
      throw new Error("sampleIntervalMs must be a positive integer");
    const vehicle = this.getVehicle(vehicleId);
    if (vehicle === null) throw new Error("Vehicle not found");
    if (
      state.identity.reference !== vehicle.reference ||
      state.identity.vin !== vehicle.vin
    )
      throw new Error("State identity does not match vehicle");
    const normalized: VehicleState = {
      ...state,
      identity: { ...state.identity, localId: vehicleId },
    };
    const payload = json(normalized);
    // A new local fetch time is not itself a new physical observation.
    const fingerprint = digest(
      json({
        ...normalized,
        freshness: { ...normalized.freshness, fetchedAt: null },
      }),
    );
    const fetchedAt = normalized.freshness.fetchedAt;
    const sourceCapturedAt = normalized.freshness.sourceCapturedAt;
    const bucketStart =
      Math.floor(fetchedAt / sampleIntervalMs) * sampleIntervalMs;
    const b = normalized.battery;
    const c = normalized.climate;
    const sampleHasEvidence =
      b.socPercent !== null ||
      b.estimatedRangeKm !== null ||
      normalized.odometerKm !== null ||
      b.charging !== "unknown" ||
      b.pluggedIn !== null ||
      b.chargePowerKw !== null ||
      b.targetSocPercent !== null ||
      c.activity !== "unknown" ||
      c.targetTempF !== null;
    return this.storage.transaction(() => {
      const previous = this.storage.db
        .prepare(
          "SELECT fingerprint, revision FROM vehicle_current_state WHERE vehicle_id = ?",
        )
        .get(vehicleId) as
        { fingerprint: string; revision: number } | undefined;
      const revision = (previous?.revision ?? 0) + 1;
      this.storage.db
        .prepare(
          `INSERT INTO vehicle_current_state
        (vehicle_id, state_schema_version, payload, fingerprint, fetched_at,
         source_captured_at, persisted_at, revision) VALUES (?, 1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(vehicle_id) DO UPDATE SET payload=excluded.payload,
          fingerprint=excluded.fingerprint, fetched_at=excluded.fetched_at,
          source_captured_at=excluded.source_captured_at,
          persisted_at=excluded.persisted_at, revision=excluded.revision`,
        )
        .run(
          vehicleId,
          payload,
          fingerprint,
          fetchedAt,
          sourceCapturedAt,
          recordedAt,
          revision,
        );
      const observed = previous?.fingerprint !== fingerprint;
      if (observed) {
        this.storage.db
          .prepare(
            `INSERT INTO vehicle_observations
          (vehicle_id, state_schema_version, payload, fingerprint, fetched_at,
           source_captured_at, recorded_at) VALUES (?, 1, ?, ?, ?, ?, ?)`,
          )
          .run(
            vehicleId,
            payload,
            fingerprint,
            fetchedAt,
            sourceCapturedAt,
            recordedAt,
          );
      }
      let sampled = false;
      if (sampleHasEvidence) {
        const result = this.storage.db
          .prepare(
            `INSERT OR IGNORE INTO telemetry_samples
          (vehicle_id, bucket_start, fetched_at, source_captured_at,
           soc_percent, estimated_range_km, odometer_km, charging, plugged_in,
           charge_power_kw, target_soc_percent, climate_activity, target_temp_f)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            vehicleId,
            bucketStart,
            fetchedAt,
            sourceCapturedAt,
            b.socPercent,
            b.estimatedRangeKm,
            normalized.odometerKm,
            b.charging,
            b.pluggedIn === null ? null : Number(b.pluggedIn),
            b.chargePowerKw,
            b.targetSocPercent,
            c.activity,
            c.targetTempF,
          );
        sampled = result.changes === 1;
      }
      return { revision, observed, sampled };
    });
  }

  getCurrentState(
    vehicleId: string,
  ): { state: VehicleState; revision: number; persistedAt: number } | null {
    const row = this.storage.db
      .prepare(
        `SELECT payload, state_schema_version, revision, persisted_at
      FROM vehicle_current_state WHERE vehicle_id = ?`,
      )
      .get(vehicleId) as
      | {
          payload: string;
          state_schema_version: number;
          revision: number;
          persisted_at: number;
        }
      | undefined;
    return row === undefined
      ? null
      : {
          state: readState(row.payload, row.state_schema_version),
          revision: row.revision,
          persistedAt: row.persisted_at,
        };
  }

  listObservations(vehicleId: string): ObservationRecord[] {
    const rows = this.storage.db
      .prepare(
        `SELECT id, vehicle_id, payload,
      state_schema_version, recorded_at FROM vehicle_observations
      WHERE vehicle_id = ? ORDER BY fetched_at, id`,
      )
      .all(vehicleId) as unknown as {
      id: number;
      vehicle_id: string;
      payload: string;
      state_schema_version: number;
      recorded_at: number;
    }[];
    return rows.map((row) => ({
      id: row.id,
      vehicleId: row.vehicle_id,
      state: readState(row.payload, row.state_schema_version),
      recordedAt: row.recorded_at,
    }));
  }

  listTelemetrySamples(vehicleId: string): TelemetrySample[] {
    const rows = this.storage.db
      .prepare(
        `SELECT * FROM telemetry_samples
      WHERE vehicle_id = ? ORDER BY bucket_start`,
      )
      .all(vehicleId) as unknown as {
      vehicle_id: string;
      bucket_start: number;
      fetched_at: number;
      source_captured_at: number | null;
      soc_percent: number | null;
      estimated_range_km: number | null;
      odometer_km: number | null;
      charging: TelemetrySample["charging"];
      plugged_in: number | null;
      charge_power_kw: number | null;
      target_soc_percent: number | null;
      climate_activity: TelemetrySample["climateActivity"];
      target_temp_f: number | null;
    }[];
    return rows.map((row) => ({
      vehicleId: row.vehicle_id,
      bucketStart: row.bucket_start,
      fetchedAt: row.fetched_at,
      sourceCapturedAt: row.source_captured_at,
      socPercent: row.soc_percent,
      estimatedRangeKm: row.estimated_range_km,
      odometerKm: row.odometer_km,
      charging: row.charging,
      pluggedIn: row.plugged_in === null ? null : row.plugged_in === 1,
      chargePowerKw: row.charge_power_kw,
      targetSocPercent: row.target_soc_percent,
      climateActivity: row.climate_activity,
      targetTempF: row.target_temp_f,
    }));
  }
}

export class CommandRepository {
  private readonly storage: SqliteStorage;

  constructor(storage: SqliteStorage) {
    this.storage = storage;
  }

  insert(command: CommandRecord): void {
    this.storage.db
      .prepare(
        `INSERT INTO commands
      (id, vehicle_id, kind, status, requested_at, accepted_at, completed_at,
       correlation_id, failure_code, failure_reason, requesting_device_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        command.id,
        command.vehicleId,
        command.kind,
        command.status,
        command.requestedAt,
        command.acceptedAt,
        command.completedAt,
        command.correlationId,
        command.failureCode,
        command.failureReason,
        command.requestingDeviceId,
      );
  }

  get(id: string): CommandRecord | null {
    const row = this.storage.db
      .prepare("SELECT * FROM commands WHERE id = ?")
      .get(id) as
      | {
          id: string;
          vehicle_id: string;
          kind: VehicleCommandKind;
          status: CommandStatus;
          requested_at: number;
          accepted_at: number | null;
          completed_at: number | null;
          correlation_id: string | null;
          failure_code: string | null;
          failure_reason: string | null;
          requesting_device_id: string | null;
        }
      | undefined;
    return row === undefined
      ? null
      : {
          id: row.id,
          vehicleId: row.vehicle_id,
          kind: row.kind,
          status: row.status,
          requestedAt: row.requested_at,
          acceptedAt: row.accepted_at,
          completedAt: row.completed_at,
          correlationId: row.correlation_id,
          failureCode: row.failure_code,
          failureReason: row.failure_reason,
          requestingDeviceId: row.requesting_device_id,
        };
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        CommandRecord,
        | "status"
        | "acceptedAt"
        | "completedAt"
        | "correlationId"
        | "failureCode"
        | "failureReason"
      >
    >,
  ): CommandRecord {
    const current = this.get(id);
    if (current === null) throw new Error("Command not found");
    const next = { ...current, ...patch };
    this.storage.db
      .prepare(
        `UPDATE commands SET status=?, accepted_at=?,
      completed_at=?, correlation_id=?, failure_code=?, failure_reason=? WHERE id=?`,
      )
      .run(
        next.status,
        next.acceptedAt,
        next.completedAt,
        next.correlationId,
        next.failureCode,
        next.failureReason,
        id,
      );
    return next;
  }
}
