/** Application-facing vehicle state. Null means the current source did not establish a value. */
export type Known<T> = T | null;
export type Support = "supported" | "unsupported" | "unknown";

/** `reference` is opaque to callers; the VW adapter currently uses its vehicle UUID. */
export interface VehicleIdentity {
  localId: Known<string>;
  reference: string;
  vin: string;
  name: Known<string>;
  model: Known<string>;
}

/** Support is per vehicle, not inferred from the presence of an adapter method. */
export interface VehicleCapabilities {
  lock: Support;
  unlock: Support;
  charging: Support;
  chargeTarget: Support;
  climate: Support;
  location: Support;
}

export interface BatteryState {
  socPercent: Known<number>;
  estimatedRangeKm: Known<number>;
  charging: "charging" | "not_charging" | "unknown";
  chargePowerKw: Known<number>;
  minutesToFull: Known<number>;
  pluggedIn: Known<boolean>;
  plugLocked: Known<boolean>;
  targetSocPercent: Known<number>;
}

export interface VehicleSecurityState {
  lock: "locked" | "unlocked" | "unknown";
  /** Null means the source cannot distinguish no open closures from missing data. */
  openDoors: Known<string[]>;
  openWindows: Known<string[]>;
  unlockedDoors: Known<string[]>;
}

export interface ClimateState {
  activity: "active" | "inactive" | "unknown";
  targetTempF: Known<number>;
  remainingMin: Known<number>;
}

export interface VehicleLocation {
  latitude: number;
  longitude: number;
  parkedAt: Known<number>;
}

/** Fetched time is local; every other timestamp is source-reported and nullable. */
export interface VehicleFreshness {
  fetchedAt: number;
  sourceCapturedAt: Known<number>;
  rvsUpdatedAt: Known<number>;
  chargeUpdatedAt: Known<number>;
  doorsUpdatedAt: Known<number>;
  locksUpdatedAt: Known<number>;
  windowsUpdatedAt: Known<number>;
}

/** Physical observations. No requested command is stored in this structure. */
export interface VehicleState {
  identity: VehicleIdentity;
  capabilities: VehicleCapabilities;
  battery: BatteryState;
  security: VehicleSecurityState;
  climate: ClimateState;
  odometerKm: Known<number>;
  location: Known<VehicleLocation>;
  freshness: VehicleFreshness;
}

export type VehicleCommandKind =
  | "lock"
  | "unlock"
  | "charge_start"
  | "charge_stop"
  | "charge_target"
  | "climate_start"
  | "climate_stop"
  | "climate_temperature";

/** Submission/acceptance is separate from observed state and execution confirmation. */
export interface CommandSubmission {
  vehicleReference: string;
  kind: VehicleCommandKind;
  correlationId: string;
  acceptedAt: number;
}

export interface WakeSubmission {
  vehicleReference: string;
  acceptedAt: number;
}

export interface CommandConfirmation {
  confirmed: boolean;
}
