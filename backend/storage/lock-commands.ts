import { randomUUID } from "node:crypto";
import {
  controlRequestSchema,
  type ControlCommand as LockCommand,
  type ControlRequest as LockRequest,
} from "@vwapp/contract/control";
import type { SqliteStorage } from "./database";
import { CommandRepository } from "./repositories";

export class CommandConflict extends Error {}
export interface DurableLockCommand extends LockCommand {
  accountId: string;
  deviceId: string;
  idempotencyKey: string;
  correlationId: string | null;
  stage: string | null;
  baselineSourceAt: number | null;
}
interface Row {
  id: string;
  vehicle_id: string;
  kind: LockCommand["action"];
  status: LockCommand["status"];
  requested_at: number;
  submitted_at: number | null;
  accepted_at: number | null;
  completed_at: number | null;
  history_confirmed: number | null;
  observed_lock: NonNullable<LockCommand["observation"]>["lock"] | null;
  observed_fetched_at: number | null;
  observed_source_at: number | null;
  failure_code: LockCommand["failureCode"];
  confirmation_rounds: number;
  status_reads: number;
  account_id: string;
  requesting_device_id: string;
  idempotency_key: string;
  correlation_id: string | null;
  request_payload: string | null;
  evidence_payload: string | null;
  execution_stage: string | null;
  baseline_source_at: number | null;
  evidence_basis: LockCommand["evidenceBasis"];
}
/** Extends the Phase 5 command ledger; idempotency keys have no automatic expiry. */
export class LockCommandRepository {
  private readonly storage: SqliteStorage;
  constructor(storage: SqliteStorage) {
    this.storage = storage;
  }
  private map(row: Row | undefined): DurableLockCommand | null {
    if (row === undefined) return null;
    return {
      id: row.id,
      stage: row.execution_stage,
      baselineSourceAt: row.baseline_source_at,
      evidenceBasis: row.evidence_basis,
      vehicleId: row.vehicle_id,
      action: row.kind,
      parameters:
        row.request_payload === null
          ? {}
          : this.parameters(
              controlRequestSchema.parse(
                JSON.parse(row.request_payload) as unknown,
              ),
            ),
      status: row.status,
      requestedAt: row.requested_at,
      submittedAt: row.submitted_at,
      acceptedAt: row.accepted_at,
      completedAt: row.completed_at,
      historyConfirmed:
        row.history_confirmed === null ? null : row.history_confirmed === 1,
      observation:
        row.evidence_payload !== null
          ? (JSON.parse(row.evidence_payload) as LockCommand["observation"])
          : row.observed_lock === null || row.observed_fetched_at === null
            ? null
            : {
                lock: row.observed_lock,
                fetchedAt: row.observed_fetched_at,
                sourceUpdatedAt: row.observed_source_at,
              },
      failureCode: row.failure_code,
      confirmationRounds: row.confirmation_rounds,
      statusReads: row.status_reads,
      accountId: row.account_id,
      deviceId: row.requesting_device_id,
      idempotencyKey: row.idempotency_key,
      correlationId: row.correlation_id,
    };
  }
  private parameters(request: LockRequest): LockCommand["parameters"] {
    if (request.action === "charge_target")
      return { targetSoc: request.targetSoc };
    if (request.action === "climate_start")
      return { tempF: request.tempF, durationMin: request.durationMin };
    if (request.action === "climate_temperature")
      return { tempF: request.tempF };
    return {};
  }

  get(id: string): DurableLockCommand | null {
    return this.map(
      this.storage.db
        .prepare(
          "SELECT * FROM commands WHERE id = ? AND idempotency_key IS NOT NULL",
        )
        .get(id) as Row | undefined,
    );
  }
  byKey(deviceId: string, key: string): DurableLockCommand | null {
    return this.map(
      this.storage.db
        .prepare(
          "SELECT * FROM commands WHERE requesting_device_id = ? AND idempotency_key = ?",
        )
        .get(deviceId, key) as Row | undefined,
    );
  }
  intent(
    request: LockRequest,
    accountId: string,
    deviceId: string,
    pubkey: string,
    now: number,
    prepared?: (command: DurableLockCommand) => void,
  ): { command: DurableLockCommand; created: boolean } {
    return this.storage.transaction(() => {
      const existing = this.byKey(deviceId, request.idempotencyKey);
      if (existing !== null) {
        if (
          existing.vehicleId !== request.vehicleId ||
          existing.action !== request.action ||
          existing.accountId !== accountId ||
          JSON.stringify(existing.parameters) !==
            JSON.stringify(this.parameters(controlRequestSchema.parse(request)))
        )
          throw new CommandConflict("idempotency_conflict");
        return { command: existing, created: false };
      }
      const active = this.storage.db
        .prepare(
          "SELECT 1 FROM commands WHERE vehicle_id = ? AND idempotency_key IS NOT NULL AND status IN ('requested','submitting','accepted','waiting_for_vehicle')",
        )
        .get(request.vehicleId);
      if (active !== undefined) throw new CommandConflict("vehicle_busy");
      const id = randomUUID();
      new CommandRepository(this.storage).insert({
        id,
        vehicleId: request.vehicleId,
        kind: request.action,
        status: "requested",
        requestedAt: now,
        acceptedAt: null,
        completedAt: null,
        correlationId: null,
        failureCode: null,
        failureReason: null,
        requestingDeviceId: deviceId,
      });
      this.storage.db
        .prepare(
          "UPDATE commands SET account_id = ?, idempotency_key = ?, requesting_pubkey = ?, request_payload = ? WHERE id = ?",
        )
        .run(
          accountId,
          request.idempotencyKey,
          pubkey,
          JSON.stringify(controlRequestSchema.parse(request)),
          id,
        );
      const command = this.get(id);
      if (command === null) throw new Error("Command insert failed");
      prepared?.(command);
      const persisted = this.get(id);
      if (persisted === null) throw Error("Command persistence failed");
      return { command: persisted, created: true };
    });
  }
  update(
    id: string,
    patch: Partial<
      Pick<
        DurableLockCommand,
        | "baselineSourceAt"
        | "stage"
        | "evidenceBasis"
        | "status"
        | "submittedAt"
        | "acceptedAt"
        | "completedAt"
        | "correlationId"
        | "historyConfirmed"
        | "observation"
        | "failureCode"
        | "confirmationRounds"
        | "statusReads"
      >
    >,
  ): DurableLockCommand {
    const current = this.get(id);
    if (current === null) throw new Error("Command missing");
    const next = { ...current, ...patch };
    this.storage.db
      .prepare(
        "UPDATE commands SET status = ?, submitted_at = ?, accepted_at = ?, completed_at = ?, correlation_id = ?, history_confirmed = ?, observed_lock = ?, observed_fetched_at = ?, observed_source_at = ?, failure_code = ?, confirmation_rounds = ?, status_reads = ?, evidence_payload = ?, execution_stage = ?, evidence_basis = ?, baseline_source_at = ? WHERE id = ?",
      )
      .run(
        next.status,
        next.submittedAt,
        next.acceptedAt,
        next.completedAt,
        next.correlationId,
        next.historyConfirmed === null ? null : Number(next.historyConfirmed),
        next.observation?.lock ?? null,
        next.observation?.fetchedAt ?? null,
        next.observation?.sourceUpdatedAt ?? null,
        next.failureCode,
        next.confirmationRounds,
        next.statusReads,
        next.observation === null ? null : JSON.stringify(next.observation),
        next.stage,
        next.evidenceBasis ?? null,
        next.baselineSourceAt,
        id,
      );
    return next;
  }
  recover(now: number): void {
    this.storage.transaction(() => {
      this.storage.db
        .prepare(
          "UPDATE commands SET failure_code = CASE status WHEN 'requested' THEN 'restart_before_submission' ELSE 'restart_during_submission' END, status = 'unknown', completed_at = MAX(?, requested_at) WHERE idempotency_key IS NOT NULL AND status IN ('requested','submitting')",
        )
        .run(now);
      this.storage.db
        .prepare(
          "UPDATE commands SET status = 'waiting_for_vehicle', failure_code = 'reconciliation_required' WHERE idempotency_key IS NOT NULL AND status IN ('accepted','waiting_for_vehicle')",
        )
        .run();
    });
  }
}
