import { z } from "zod";

const knownNumber = z.number().nullable();
const knownBoolean = z.boolean().nullable();
const support = z.enum(["supported", "unsupported", "unknown"]);

/** The SQLite-backed Node API publishes observations, never command intent. */
export const vehicleStateSchema = z.object({
  identity: z.object({
    localId: z.string().nullable(),
    reference: z.string(),
    vin: z.string(),
    name: z.string().nullable(),
    model: z.string().nullable(),
  }),
  capabilities: z.object({
    lock: support,
    unlock: support,
    charging: support,
    chargeTarget: support,
    climate: support,
    location: support,
  }),
  battery: z.object({
    socPercent: knownNumber,
    estimatedRangeKm: knownNumber,
    charging: z.enum(["charging", "not_charging", "unknown"]),
    chargePowerKw: knownNumber,
    minutesToFull: knownNumber,
    pluggedIn: knownBoolean,
    plugLocked: knownBoolean,
    targetSocPercent: knownNumber,
  }),
  security: z.object({
    lock: z.enum(["locked", "unlocked", "unknown"]),
    openDoors: z.array(z.string()).nullable(),
    openWindows: z.array(z.string()).nullable(),
    unlockedDoors: z.array(z.string()).nullable(),
  }),
  climate: z.object({
    fetchedAt: z.number().optional(),
    activity: z.enum(["active", "inactive", "unknown"]),
    targetTempF: knownNumber,
    remainingMin: knownNumber,
  }),
  odometerKm: knownNumber,
  location: z
    .object({
      latitude: z.number(),
      longitude: z.number(),
      parkedAt: knownNumber,
    })
    .nullable(),
  freshness: z.object({
    fetchedAt: z.number(),
    sourceCapturedAt: knownNumber,
    rvsUpdatedAt: knownNumber,
    chargeUpdatedAt: knownNumber,
    doorsUpdatedAt: knownNumber,
    locksUpdatedAt: knownNumber,
    windowsUpdatedAt: knownNumber,
  }),
});

export const passiveOwnerSchema = z.object({
  device: z.object({ id: z.string(), name: z.string(), pubkey: z.string() }),
  accountLinked: z.boolean(),
  vehicleAvailable: z.boolean(),
});
export const passivePairedSchema = z.object({
  device: passiveOwnerSchema.shape.device,
});
export const passiveClimateSessionSchema = z.object({
  id: z.string(),
  tempF: z.number(),
  expiresAt: z.number(),
  startedAt: z.number(),
  state: z.string(),
  lastStartAt: knownNumber,
  remainingMin: knownNumber,
  pausedAt: knownNumber,
});
export const passiveVehicleSchema = z.object({
  id: z.string(),
  identity: vehicleStateSchema.shape.identity,
  current: z
    .object({
      state: vehicleStateSchema,
      revision: z.number().int(),
      persistedAt: z.number(),
    })
    .nullable(),
  climateSession: passiveClimateSessionSchema.nullable(),
});
export const passiveVehiclesSchema = z.object({
  vehicles: z.array(passiveVehicleSchema),
});
export const passiveCurrentSchema = z.object({
  current: passiveVehicleSchema.shape.current,
});
export const passiveHistorySchema = z.object({
  observations: z.array(
    z.object({
      id: z.number().int(),
      vehicleId: z.string(),
      state: vehicleStateSchema,
      recordedAt: z.number(),
    }),
  ),
});
export const passiveMessageSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  at: knownNumber,
  read: z.boolean(),
  readOverride: knownBoolean,
  deletedAt: knownNumber,
  createdAt: z.number(),
});
export const passiveMessagesSchema = z.object({
  messages: z.array(passiveMessageSchema),
});

export type PassiveOwner = z.infer<typeof passiveOwnerSchema>;
export type PassiveVehicle = z.infer<typeof passiveVehicleSchema>;
export type PassiveVehicles = z.infer<typeof passiveVehiclesSchema>;
export type PassiveCurrent = z.infer<typeof passiveCurrentSchema>;
export type PassiveHistory = z.infer<typeof passiveHistorySchema>;
export type PassiveMessage = z.infer<typeof passiveMessageSchema>;
export type PassiveMessages = z.infer<typeof passiveMessagesSchema>;
