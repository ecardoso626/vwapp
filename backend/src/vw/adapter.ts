import type {
  ClimateState,
  CommandConfirmation,
  CommandSubmission,
  StatusDTO,
  VehicleCommandKind,
  VehicleDTO,
  VehicleIdentity,
  VehicleState,
  WakeSubmission,
} from "@vwapp/contract";
import {
  vwAwaitCommandResult,
  vwChargeStart,
  vwChargeStop,
  vwClimateStart,
  vwClimateStop,
  vwForceRefresh,
  vwGetClimate,
  vwGetClimateTargetTempF,
  vwGetStatus,
  vwGetVehicles,
  vwLockUnlock,
  vwSetChargeLimit,
  vwSetClimateTemp,
} from "./client";

/** Application operations. A submission is not evidence that the car acted. */
export interface VwAdapter {
  discoverVehicles(): Promise<VehicleIdentity[]>;
  readVehicleState(vehicle: VehicleIdentity): Promise<VehicleState>;
  readClimate(vehicle: VehicleIdentity): Promise<ClimateState>;
  readClimateTargetTempF(vehicle: VehicleIdentity): Promise<number | null>;
  requestWake(vehicle: VehicleIdentity): Promise<WakeSubmission>;
  submitLock(vehicle: VehicleIdentity): Promise<CommandSubmission>;
  submitUnlock(vehicle: VehicleIdentity): Promise<CommandSubmission>;
  submitChargeStart(vehicle: VehicleIdentity): Promise<CommandSubmission>;
  submitChargeStop(vehicle: VehicleIdentity): Promise<CommandSubmission>;
  submitChargeTarget(
    vehicle: VehicleIdentity,
    targetSocPercent: number,
  ): Promise<CommandSubmission>;
  submitClimateStart(vehicle: VehicleIdentity): Promise<CommandSubmission>;
  submitClimateStop(vehicle: VehicleIdentity): Promise<CommandSubmission>;
  submitClimateTemperature(
    vehicle: VehicleIdentity,
    targetTempF: number,
  ): Promise<CommandSubmission>;
  awaitCommandResult(
    submission: CommandSubmission,
    options?: { attempts?: number; intervalMs?: number },
  ): Promise<CommandConfirmation>;
}

/** Internal session supply. The existing token manager can implement these callbacks later. */
export interface VwAdapterSession {
  accessTokens(): Promise<{ accessToken: string; idToken: string | null }>;
  readAuthorization(vehicleReference: string): Promise<string>;
  commandAuthorization(vehicleReference: string): Promise<string>;
  spin(): Promise<string>;
}

const knownNumber = (value: number | null): number | null =>
  value !== null && Number.isFinite(value) ? value : null;
const observedNames = (names: string[]): string[] | null =>
  names.length > 0 ? [...names] : null;

export function mapVehicleIdentity(vehicle: VehicleDTO): VehicleIdentity {
  return {
    localId: null,
    reference: vehicle.uuid,
    vin: vehicle.vin,
    name: vehicle.nickname,
    model: vehicle.model,
  };
}

/**
 * The legacy StatusDTO loses evidence for false lock and empty closure lists.
 * Preserve only positive observations rather than promoting ambiguity to safety.
 */
export function mapVehicleStatus(
  identity: VehicleIdentity,
  status: StatusDTO,
  fetchedAt: number,
): VehicleState {
  const latitude = knownNumber(status.parkedLat);
  const longitude = knownNumber(status.parkedLng);
  const location =
    latitude !== null &&
    longitude !== null &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
      ? {
          latitude,
          longitude,
          parkedAt: knownNumber(status.parkedAt),
        }
      : null;
  return {
    identity,
    capabilities: {
      lock: "unknown",
      unlock: "unknown",
      charging: "unknown",
      chargeTarget: "unknown",
      climate: "unknown",
      location: location === null ? "unknown" : "supported",
    },
    battery: {
      socPercent: knownNumber(status.soc),
      estimatedRangeKm: knownNumber(status.rangeKm),
      charging:
        status.chargeState === "chargingHVBattery" ? "charging" : "unknown",
      chargePowerKw: knownNumber(status.chargePowerKw),
      minutesToFull: knownNumber(status.minutesToFull),
      pluggedIn: status.pluggedIn,
      plugLocked: status.plugLocked,
      targetSocPercent: knownNumber(status.targetSoc),
    },
    security: {
      lock: status.locked === true ? "locked" : "unknown",
      openDoors: observedNames(status.openDoors),
      openWindows: observedNames(status.openWindows),
      unlockedDoors: observedNames(status.unlockedDoors),
    },
    climate: { activity: "unknown", targetTempF: null, remainingMin: null },
    odometerKm: knownNumber(status.odometerKm),
    location,
    freshness: {
      fetchedAt,
      sourceCapturedAt: knownNumber(status.capturedAt),
      rvsUpdatedAt: knownNumber(status.rvsUpdatedAt),
      chargeUpdatedAt: knownNumber(status.chargeUpdatedAt),
      doorsUpdatedAt: knownNumber(status.doorsUpdatedAt),
      locksUpdatedAt: knownNumber(status.locksUpdatedAt),
      windowsUpdatedAt: knownNumber(status.windowsUpdatedAt),
    },
  };
}

/** The legacy climate boolean also collapses explicit off and missing status. */
export function mapClimateState(raw: {
  on: boolean;
  remainingMin: number | null;
  targetTempF: number | null;
}): ClimateState {
  return {
    activity: raw.on ? "active" : "unknown",
    targetTempF: knownNumber(raw.targetTempF),
    remainingMin: knownNumber(raw.remainingMin),
  };
}

/** Wraps the current protocol client; retry, session and climate intent policies stay above it. */
export function createVwAdapter(
  session: VwAdapterSession,
  now: () => number = Date.now,
): VwAdapter {
  const submitted = (
    vehicle: VehicleIdentity,
    kind: VehicleCommandKind,
    correlationId: string,
  ): CommandSubmission => ({
    vehicleReference: vehicle.reference,
    kind,
    correlationId,
    acceptedAt: now(),
  });
  const ev = async (
    vehicle: VehicleIdentity,
    kind: VehicleCommandKind,
    run: (authorization: string, reference: string) => Promise<string>,
  ): Promise<CommandSubmission> => {
    const authorization = await session.commandAuthorization(vehicle.reference);
    return submitted(
      vehicle,
      kind,
      await run(authorization, vehicle.reference),
    );
  };
  const door = async (
    vehicle: VehicleIdentity,
    action: "lock" | "unlock",
  ): Promise<CommandSubmission> =>
    submitted(
      vehicle,
      action,
      await vwLockUnlock(
        await session.accessTokens(),
        vehicle.reference,
        await session.spin(),
        action,
      ),
    );
  return {
    async discoverVehicles() {
      return (
        await vwGetVehicles((await session.accessTokens()).accessToken)
      ).map(mapVehicleIdentity);
    },
    async readVehicleState(vehicle) {
      const authorization = await session.readAuthorization(vehicle.reference);
      const status = await vwGetStatus(
        authorization,
        vehicle.vin,
        vehicle.reference,
      );
      return mapVehicleStatus(vehicle, status, now());
    },
    async readClimate(vehicle) {
      const authorization = await session.readAuthorization(vehicle.reference);
      return mapClimateState(
        await vwGetClimate(
          authorization,
          await session.accessTokens(),
          vehicle.reference,
        ),
      );
    },
    async readClimateTargetTempF(vehicle) {
      return knownNumber(
        await vwGetClimateTargetTempF(
          await session.readAuthorization(vehicle.reference),
          vehicle.reference,
        ),
      );
    },
    async requestWake(vehicle) {
      await vwForceRefresh(
        await session.accessTokens(),
        vehicle.reference,
        await session.spin(),
      );
      return { vehicleReference: vehicle.reference, acceptedAt: now() };
    },
    submitLock: (vehicle) => door(vehicle, "lock"),
    submitUnlock: (vehicle) => door(vehicle, "unlock"),
    submitChargeStart: (vehicle) => ev(vehicle, "charge_start", vwChargeStart),
    submitChargeStop: (vehicle) => ev(vehicle, "charge_stop", vwChargeStop),
    submitChargeTarget: (vehicle, targetSocPercent) =>
      ev(vehicle, "charge_target", (authorization, reference) =>
        vwSetChargeLimit(authorization, reference, targetSocPercent),
      ),
    submitClimateStart: (vehicle) =>
      ev(vehicle, "climate_start", vwClimateStart),
    submitClimateStop: (vehicle) => ev(vehicle, "climate_stop", vwClimateStop),
    submitClimateTemperature: (vehicle, targetTempF) =>
      ev(vehicle, "climate_temperature", (authorization, reference) =>
        vwSetClimateTemp(authorization, reference, targetTempF),
      ),
    async awaitCommandResult(submission, options) {
      return vwAwaitCommandResult(
        await session.readAuthorization(submission.vehicleReference),
        submission.vehicleReference,
        submission.correlationId,
        options,
      );
    },
  };
}
