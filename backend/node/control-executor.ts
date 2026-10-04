import type { ControlCommand } from "@vwapp/contract/control";
import type { StoredAccount, StoredVehicle } from "../src/application-store";
import type { AppEnv } from "../src/env";
import { readStatus } from "../src/status";
import { ensureCarnetToken, ensureTokens, reauth } from "../src/tokens";
import { mapVehicleStatus } from "../src/vw/adapter";
import {
  VwAuthError,
  vwAwaitCommandResult,
  VwBusyError,
  vwChargeStart,
  vwChargeStop,
  VwCommandError,
  vwGetClimate,
  vwGetClimateTargetTempF,
  vwMintSpinSession,
  vwSetChargeLimit,
} from "../src/vw/client";
import type {
  DurableLockCommand,
  LockCommandRepository,
} from "../storage/lock-commands";
import type { VehicleRepository } from "../storage/repositories";
import { submitClimate } from "./climate-protocol";
import type { LockCommandOptions } from "./lock-commands";
import type { NodeSqliteStore } from "./sqlite-store";
import { executeWake } from "./wake-control";

export interface Execution {
  command: DurableLockCommand;
  submit: boolean;
  account: StoredAccount;
  vehicle: StoredVehicle;
  spin: string;
  db: NodeSqliteStore;
  env: AppEnv;
  repository: LockCommandRepository;
  vehicles: VehicleRepository;
  options: Required<LockCommandOptions>;
  bounded: <T>(work: Promise<T>) => Promise<T>;
  check: () => void;
  authorized(): boolean;
}
export async function executeControl(
  x: Execution,
): Promise<DurableLockCommand> {
  if (x.command.action === "wake") return executeWake(x);
  let command = x.command;
  const update = (patch: Parameters<LockCommandRepository["update"]>[1]) => {
    command = x.repository.update(command.id, patch);
    return command;
  };
  const { db, env, account, vehicle, spin, options, bounded, check } = x;
  if (
    x.submit &&
    (command.stage === "local_schedule" || command.stage === "local_stop")
  )
    return update({
      status: "confirmed",
      completedAt: options.now(),
      evidenceBasis: "local_schedule",
    });
  let tokens = await bounded(ensureTokens(db, env, account, true));
  const mint = async () => {
    check();
    try {
      return await bounded(vwMintSpinSession(tokens, vehicle.uuid, spin));
    } catch (error) {
      if (!(error instanceof VwAuthError)) throw error;
      tokens = await bounded(reauth(db, env, account, true, true));
      check();
      return bounded(vwMintSpinSession(tokens, vehicle.uuid, spin));
    }
  };
  if (x.submit) {
    check();
    if (!x.authorized()) throw new Error("Device unavailable");
    update({ status: "submitting", submittedAt: options.now() });
    let correlation: string | null = null;
    if (command.action.startsWith("climate_")) {
      correlation = await submitClimate({
        x,
        tokens: () => tokens,
        mint,
        stage: (stage, id) => {
          update({
            stage,
            ...(id === undefined
              ? { correlationId: null }
              : { correlationId: id, acceptedAt: options.now() }),
          });
        },
      });
      if (correlation === null) {
        update({ acceptedAt: null });
      } else
        update({
          status: "accepted",
          acceptedAt: options.now(),
          correlationId: correlation,
        });
    } else {
      // Retry only VW's explicit busy refusal, preserving its bounded fresh-mint policy.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const authorization = await mint();
          check();
          if (!x.authorized()) throw Error("Device unavailable");
          correlation = await bounded(
            command.action === "charge_start"
              ? vwChargeStart(authorization, vehicle.uuid)
              : command.action === "charge_stop"
                ? vwChargeStop(authorization, vehicle.uuid)
                : vwSetChargeLimit(
                    authorization,
                    vehicle.uuid,
                    requireTarget(command.parameters.targetSoc),
                  ),
          );
          check();
          break;
        } catch (error) {
          if (!(error instanceof VwBusyError) || attempt === 2) throw error;
          await bounded(
            new Promise((resolve) =>
              setTimeout(resolve, options.intervalMs === 0 ? 0 : 5000),
            ),
          );
        }
      }
      if (correlation === null || !/^[A-Za-z0-9._:-]{1,200}$/.test(correlation))
        throw new Error("Missing correlation");
      update({
        status: "accepted",
        acceptedAt: options.now(),
        correlationId: correlation,
      });
    }
  }
  update({
    status: "waiting_for_vehicle",
    failureCode: null,
    completedAt: null,
    confirmationRounds: command.confirmationRounds + 1,
  });
  const authorization = await bounded(
    ensureCarnetToken(db, env, account, vehicle.uuid, spin, {
      safeErrors: true,
    }),
  );
  check();
  let ignition = false;
  let historyFailed = false,
    unavailable = false;
  try {
    if (command.correlationId !== null) {
      const history = await bounded(
        vwAwaitCommandResult(
          authorization,
          vehicle.uuid,
          command.correlationId,
          {
            attempts:
              options.historyAttempts === 8 ? 6 : options.historyAttempts,
            intervalMs: options.intervalMs,
          },
        ),
      );
      check();
      update({ historyConfirmed: history.confirmed });
    }
  } catch (error) {
    check();
    historyFailed = error instanceof VwCommandError;
    ignition =
      historyFailed &&
      error instanceof Error &&
      /ignition/i.test(error.message);
    unavailable = !historyFailed;
    update({ historyConfirmed: false });
  }
  for (let index = 0; index < options.observationAttempts; index++) {
    if (index > 0)
      await bounded(
        new Promise((resolve) => setTimeout(resolve, options.intervalMs)),
      );
    check();
    try {
      const status = await bounded(
        readStatus(db, env, account, vehicle, spin, { safeErrors: true }),
      );
      check();
      const fetchedAt = options.now();
      const state = mapVehicleStatus(
        {
          localId: vehicle.id,
          reference: vehicle.uuid,
          vin: vehicle.vin,
          name: vehicle.nickname,
          model: vehicle.model,
        },
        status,
        fetchedAt,
      );
      // Recognize only explicit idle/completed states, never an arbitrary unknown string.
      if (
        [
          "notCharging",
          "chargingOff",
          "chargeComplete",
          "chargingCompleted",
        ].includes(status.chargeState ?? "")
      )
        state.battery.charging = "not_charging";
      let climate: {
        on: boolean;
        remainingMin: number | null;
        targetTempF: number | null;
      } | null = null;
      let settings: number | null = null;
      if (command.action.startsWith("climate_")) {
        climate = await bounded(
          vwGetClimate(authorization, tokens, vehicle.uuid),
        );
        check();
        settings = await bounded(
          vwGetClimateTargetTempF(authorization, vehicle.uuid),
        );
        check();
        state.climate = {
          fetchedAt: options.now(),
          activity: climate.on
            ? "active"
            : climate.remainingMin === 0
              ? "inactive"
              : "unknown",
          targetTempF: settings,
          remainingMin: climate.remainingMin,
        };
      }
      // Other category observations do not erase separately observed climate evidence.
      else {
        const prior = x.vehicles.getCurrentState(vehicle.id);
        if (prior !== null) state.climate = prior.state.climate;
      }
      x.vehicles.saveState(vehicle.id, state, fetchedAt);
      const observation: NonNullable<ControlCommand["observation"]> = {
        lock: state.security.lock,
        fetchedAt,
        sourceUpdatedAt: climate === null ? status.chargeUpdatedAt : null,
        charging: state.battery.charging,
        targetSoc: state.battery.targetSocPercent,
        ...(climate === null
          ? {}
          : {
              climate: state.climate.activity,
              targetTempF: settings,
              remainingMin: climate.remainingMin,
            }),
      };
      update({ observation, statusReads: command.statusReads + 1 });
      const matches =
        command.action === "charge_start"
          ? observation.charging === "charging"
          : command.action === "charge_stop"
            ? observation.charging === "not_charging"
            : observation.targetSoc === command.parameters.targetSoc;
      const climateMatch =
        command.action === "climate_start"
          ? state.climate.activity === "active" &&
            settings === command.parameters.tempF &&
            (command.stage === "climate_already_running" ||
              command.stage === "climate_start")
          : command.action === "climate_stop"
            ? state.climate.activity === "inactive"
            : settings !== null && settings === command.parameters.tempF;
      const climateEvidence =
        command.action === "climate_temperature"
          ? climateMatch
          : climateMatch &&
            (command.historyConfirmed === true ||
              command.stage === "climate_already_running");
      if (
        command.action.startsWith("climate_") &&
        !historyFailed &&
        climateEvidence
      )
        return update({
          status: "confirmed",
          completedAt: options.now(),
          failureCode: null,
          evidenceBasis:
            command.action === "climate_temperature"
              ? "settings_read"
              : command.correlationId === null
                ? "climate_read"
                : "history_and_climate",
        });
      if (
        !command.action.startsWith("climate_") &&
        !historyFailed &&
        matches &&
        observation.sourceUpdatedAt !== null &&
        command.submittedAt !== null &&
        observation.sourceUpdatedAt >= command.submittedAt
      )
        return update({
          status: "confirmed",
          completedAt: options.now(),
          failureCode: null,
          evidenceBasis: "vehicle_status",
        });
      if (historyFailed) break;
    } catch {
      check();
      unavailable = true;
    }
  }
  return update({
    status: historyFailed ? "failed" : unavailable ? "unknown" : "timed_out",
    completedAt: options.now(),
    failureCode: historyFailed
      ? ignition
        ? "ignition_on"
        : "vehicle_rejected"
      : unavailable
        ? "confirmation_unavailable"
        : "confirmation_timeout",
  });
}

function requireTarget(target: number | undefined): number {
  if (target === undefined) throw Error("Target missing");
  return target;
}
