import { randomUUID } from "node:crypto";
import type { CampSession, ControlRequest } from "@vwapp/contract/control";
import { unseal } from "../src/crypto";
import type { AppEnv } from "../src/env";
import { ensureCarnetToken, ensureTokens } from "../src/tokens";
import { vwGetClimate } from "../src/vw/client";
import type { SqliteStorage } from "../storage/database";
import type { DurableLockCommand } from "../storage/lock-commands";
import { VehicleRepository } from "../storage/repositories";
import type { NodeSqliteStore } from "./sqlite-store";

interface Row {
  id: string;
  vehicle_id: string;
  temp_f: number;
  expires_at: number;
  started_at: number;
  state: string;
  control_state: CampSession["controlState"];
  command_id: string | null;
  requesting_device_id: string;
  cycle: number;
  automation_enabled: number;
  remaining_min: number | null;
  paused_at: number | null;
  error: string | null;
}
export function campFor(
  storage: SqliteStorage,
  vehicleId: string,
): CampSession | null {
  const r = storage.db
    .prepare(
      "SELECT * FROM climate_sessions WHERE vehicle_id = ? ORDER BY started_at DESC,rowid DESC LIMIT 1",
    )
    .get(vehicleId) as Row | undefined;
  return r === undefined
    ? null
    : {
        id: r.id,
        vehicleId: r.vehicle_id,
        tempF: r.temp_f,
        expiresAt: r.expires_at,
        startedAt: r.started_at,
        state: r.state,
        controlState: r.control_state,
        commandId: r.command_id,
        remainingMin: r.remaining_min,
        pausedAt: r.paused_at,
        error: r.error,
        automationEnabled: r.automation_enabled === 1,
      };
}
/** Called inside intent transaction. Logical session intent never changes observed climate. */
export function prepareCamp(
  storage: SqliteStorage,
  c: DurableLockCommand,
  now: number,
  automation = false,
): void {
  if (!c.action.startsWith("climate_")) return;
  const active = storage.db
    .prepare(
      "SELECT * FROM climate_sessions WHERE vehicle_id=? AND state='active'",
    )
    .get(c.vehicleId) as Row | undefined;
  if (c.action === "climate_start") {
    const { tempF, durationMin } = c.parameters;
    if (tempF === undefined || durationMin === undefined)
      throw Error("Climate parameters missing");
    const reschedule =
      !automation &&
      active?.automation_enabled === 1 &&
      active.temp_f === c.parameters.tempF &&
      ["active", "paused", "waiting_for_restart"].includes(
        active.control_state,
      );
    if (active === undefined)
      storage.db
        .prepare(
          "INSERT INTO climate_sessions(id,vehicle_id,temp_f,expires_at,started_at,state,control_state,command_id,requesting_device_id,automation_enabled) VALUES (?,?,?,?,?,'active','starting',?,?,1)",
        )
        .run(
          randomUUID(),
          c.vehicleId,
          tempF,
          now + durationMin * 60000,
          now,
          c.id,
          c.deviceId,
        );
    else
      storage.db
        .prepare(
          "UPDATE climate_sessions SET temp_f=?,expires_at=?,command_id=?,requesting_device_id=?,automation_enabled=1,control_state=?,error=NULL,cycle=cycle+? WHERE id=?",
        )
        .run(
          tempF,
          automation ? active.expires_at : now + durationMin * 60000,
          c.id,
          c.deviceId,
          reschedule ? active.control_state : "starting",
          automation ? 1 : 0,
          active.id,
        );
    if (reschedule)
      storage.db
        .prepare(
          "UPDATE commands SET execution_stage='local_schedule' WHERE id=?",
        )
        .run(c.id);
  } else if (c.action === "climate_temperature" && active !== undefined) {
    const { tempF } = c.parameters;
    if (tempF === undefined) throw Error("Climate temperature missing");
    storage.db
      .prepare(
        "UPDATE climate_sessions SET temp_f=?,command_id=?,requesting_device_id=?,control_state='unknown',error=NULL WHERE id=?",
      )
      .run(tempF, c.id, c.deviceId, active.id);
  } else if (c.action === "climate_stop" && active !== undefined) {
    storage.db
      .prepare(
        "UPDATE climate_sessions SET control_state='stopping',command_id=?,automation_enabled=0 WHERE id=?",
      )
      .run(c.id, active.id);
    if (active.control_state === "paused")
      storage.db
        .prepare("UPDATE commands SET execution_stage='local_stop' WHERE id=?")
        .run(c.id);
  }
}
export function applyCampResult(
  storage: SqliteStorage,
  c: DurableLockCommand,
  now: number,
): void {
  const r = storage.db
    .prepare(
      "SELECT * FROM climate_sessions WHERE command_id=? AND state='active'",
    )
    .get(c.id) as Row | undefined;
  if (r === undefined) return;
  if (c.stage === "local_schedule") return;
  if (c.action === "climate_stop") {
    const expired = now >= r.expires_at;
    storage.db
      .prepare(
        "UPDATE climate_sessions SET state=?,control_state=?,automation_enabled=0,error=? WHERE id=?",
      )
      .run(
        expired ? "expired" : "stopped",
        c.status === "confirmed"
          ? expired
            ? "expired"
            : "inactive"
          : "unknown",
        c.status === "confirmed" ? null : "stop_unconfirmed",
        r.id,
      );
    return;
  }
  if (c.status === "confirmed")
    storage.db
      .prepare(
        "UPDATE climate_sessions SET control_state=?,last_start_at=CASE WHEN ? THEN ? ELSE last_start_at END,remaining_min=?,paused_at=NULL,error=NULL WHERE id=?",
      )
      .run(
        c.action === "climate_temperature"
          ? c.observation?.climate === "active"
            ? "active"
            : c.observation?.climate === "inactive"
              ? "waiting_for_restart"
              : "unknown"
          : "active",
        c.action === "climate_start" ? 1 : 0,
        now,
        c.observation?.remainingMin ?? null,
        r.id,
      );
  else if (c.failureCode === "ignition_on")
    storage.db
      .prepare(
        "UPDATE climate_sessions SET control_state='paused',paused_at=?,error='ignition_on' WHERE id=?",
      )
      .run(now, r.id);
  else if (c.failureCode === "vehicle_busy")
    storage.db
      .prepare(
        "UPDATE climate_sessions SET control_state='waiting_for_restart',error='vehicle_busy' WHERE id=?",
      )
      .run(r.id);
  else if (["failed", "unknown", "timed_out"].includes(c.status))
    storage.db
      .prepare(
        "UPDATE climate_sessions SET control_state=?,state=?,error=? WHERE id=?",
      )
      .run(
        c.status === "failed" ? "failed" : "unknown",
        c.status === "failed" ? "failed" : "active",
        c.failureCode,
        r.id,
      );
}
export interface CampCommands {
  get(id: string): DurableLockCommand | null;
  reconcile(id: string): Promise<DurableLockCommand | null>;
  submit(
    input: ControlRequest,
    deviceId: string,
  ): Promise<DurableLockCommand | null>;
}
export async function campTick(
  storage: SqliteStorage,
  db: NodeSqliteStore,
  env: AppEnv,
  commands: CampCommands,
  now: () => number = Date.now,
  deadlineMs = 60000,
): Promise<void> {
  const rows = storage.db
    .prepare(
      "SELECT * FROM climate_sessions WHERE state='active' AND (automation_enabled=1 OR control_state='stopping')",
    )
    .all() as unknown as Row[];
  for (const row of rows) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(Error("deadline"));
      }, deadlineMs);
    });
    const bounded = <T>(p: Promise<T>) => Promise.race([p, deadline]);
    const check = () => {
      if (expired) throw Error("deadline");
    };
    try {
      const user = await bounded(db.getUser("owner"));
      check();
      const vehicle = user.vehicles.find((v) => v.id === row.vehicle_id);
      const device = storage.db
        .prepare("SELECT revoked_at FROM authorized_devices WHERE id=?")
        .get(row.requesting_device_id) as
        { revoked_at: number | null } | undefined;
      if (
        user.account === null ||
        vehicle === undefined ||
        device?.revoked_at !== null
      ) {
        storage.db
          .prepare(
            "UPDATE climate_sessions SET control_state='paused',error='account_or_device_unavailable' WHERE id=?",
          )
          .run(row.id);
        continue;
      }
      let prior = row.command_id === null ? null : commands.get(row.command_id);
      if (
        prior !== null &&
        ["requested", "submitting", "accepted", "waiting_for_vehicle"].includes(
          prior.status,
        )
      ) {
        if (
          prior.status === "accepted" ||
          prior.status === "waiting_for_vehicle"
        )
          prior = await bounded(commands.reconcile(prior.id));
        check();
        if (prior !== null) applyCampResult(storage, prior, now());
        continue;
      }
      if (
        prior !== null &&
        ["unknown", "timed_out"].includes(prior.status) &&
        now() < row.expires_at
      ) {
        if (prior.acceptedAt !== null)
          await bounded(commands.reconcile(prior.id));
        check();
        continue;
      }
      if (row.control_state === "paused" && now() < row.expires_at) {
        const parked = await bounded(db.latestParkedAt(row.vehicle_id));
        check();
        if (
          !(parked !== null && parked > (row.paused_at ?? now())) &&
          now() - (row.paused_at ?? now()) < 600000
        )
          continue;
      }
      const credentials = JSON.parse(
        await bounded(unseal(env.CREDS_ENC_KEY, user.account.sealed)),
      ) as { spin?: string };
      check();
      if (!credentials.spin) throw Error("PIN missing");
      if (now() >= row.expires_at) {
        const result = await bounded(
          commands.submit(
            {
              vehicleId: vehicle.id,
              action: "climate_stop",
              idempotencyKey: randomUUID(),
            },
            row.requesting_device_id,
          ),
        );
        check();
        if (result !== null) applyCampResult(storage, result, now());
        continue;
      }
      const tokens = await bounded(ensureTokens(db, env, user.account, true));
      check();
      const carnet = await bounded(
        ensureCarnetToken(
          db,
          env,
          user.account,
          vehicle.uuid,
          credentials.spin,
          { safeErrors: true },
        ),
      );
      check();
      const climate = await bounded(vwGetClimate(carnet, tokens, vehicle.uuid));
      check();
      const vehicles = new VehicleRepository(storage);
      const priorState = vehicles.getCurrentState(vehicle.id);
      if (priorState !== null) {
        const observed = {
          ...priorState.state,
          climate: {
            activity: climate.on
              ? ("active" as const)
              : climate.remainingMin === 0
                ? ("inactive" as const)
                : ("unknown" as const),
            targetTempF: climate.targetTempF,
            remainingMin: climate.remainingMin,
            fetchedAt: now(),
          },
        };
        vehicles.saveState(vehicle.id, observed, now());
      }
      if (climate.on) {
        storage.db
          .prepare(
            "UPDATE climate_sessions SET control_state='active',remaining_min=?,paused_at=NULL,error=NULL WHERE id=?",
          )
          .run(climate.remainingMin, row.id);
        continue;
      }
      if (climate.remainingMin !== 0) {
        storage.db
          .prepare(
            "UPDATE climate_sessions SET control_state='unknown',error='climate_state_ambiguous' WHERE id=?",
          )
          .run(row.id);
        continue;
      }
      // Only a positive zero-duration stopped observation or explicit busy refusal permits another cycle.
      const result = await bounded(
        commands.submit(
          {
            vehicleId: vehicle.id,
            action: "climate_start",
            tempF: row.temp_f,
            durationMin: Math.max(
              5,
              Math.min(1440, Math.ceil((row.expires_at - now()) / 60000)),
            ),
            idempotencyKey: randomUUID(),
          },
          row.requesting_device_id,
        ),
      );
      check();
      if (result !== null) applyCampResult(storage, result, now());
    } catch {
      storage.db
        .prepare(
          "UPDATE climate_sessions SET control_state='unknown',error='reconciliation_unavailable' WHERE id=? AND state='active'",
        )
        .run(row.id);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
