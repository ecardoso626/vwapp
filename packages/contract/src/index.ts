import { z } from "zod";

export type { LockCommand, LockRequest } from "./lock-command.js";

export type {
  AccountConnection,
  AccountAttempt,
  AccountAction,
} from "./account.js";

export type {
  BatteryState,
  ClimateState,
  CommandConfirmation,
  CommandSubmission,
  Known,
  Support,
  VehicleCapabilities,
  VehicleCommandKind,
  VehicleFreshness,
  VehicleIdentity,
  VehicleLocation,
  VehicleSecurityState,
  VehicleState,
  WakeSubmission,
} from "./vehicle-domain.js";
export type {
  PassiveCurrent,
  PassiveHistory,
  PassiveMessage,
  PassiveMessages,
  PassiveOwner,
  PassiveVehicle,
  PassiveVehicles,
} from "./passive.js";

/** A vehicle in the user's garage. */
export const vehicleSchema = z.object({
  vin: z.string(),
  uuid: z.string(),
  nickname: z.string().nullable(),
  model: z.string().nullable(),
});
export type VehicleDTO = z.infer<typeof vehicleSchema>;

/** Live status for one vehicle (mirrors the verified PoC summary). */
export const statusSchema = z.object({
  vin: z.string(),
  soc: z.number().nullable(),
  chargeState: z.string().nullable(),
  chargePowerKw: z.number().nullable(),
  minutesToFull: z.number().nullable(),
  pluggedIn: z.boolean().nullable(),
  plugLocked: z.boolean().nullable(),
  targetSoc: z.number().nullable(),
  locked: z.boolean().nullable(),
  /** Open closures/windows and unlocked doors, by friendly name (e.g. "trunk"). */
  openDoors: z.array(z.string()),
  openWindows: z.array(z.string()),
  unlockedDoors: z.array(z.string()),
  /** Canonical km (the app converts to the user's preferred units). */
  rangeKm: z.number().nullable(),
  odometerKm: z.number().nullable(),
  /** Where the car last parked (`parkedAt` is epoch ms). */
  parkedLat: z.number().nullable(),
  parkedLng: z.number().nullable(),
  parkedAt: z.number().nullable(),
  /** When VW captured this data, epoch ms. */
  capturedAt: z.number().nullable(),
  /** Per-category update times VW reports alongside the data (epoch ms). */
  rvsUpdatedAt: z.number().nullable(),
  doorsUpdatedAt: z.number().nullable(),
  locksUpdatedAt: z.number().nullable(),
  windowsUpdatedAt: z.number().nullable(),
  chargeUpdatedAt: z.number().nullable(),
});
export type StatusDTO = z.infer<typeof statusSchema>;
