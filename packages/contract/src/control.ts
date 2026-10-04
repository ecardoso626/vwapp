import { z } from "zod";
import { lockCommandSchema } from "./lock-command";

const identity = { vehicleId: z.uuid(), idempotencyKey: z.uuid() };
export const controlRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ ...identity, action: z.literal("lock") }),
  z.strictObject({ ...identity, action: z.literal("unlock") }),
  z.strictObject({ ...identity, action: z.literal("charge_start") }),
  z.strictObject({ ...identity, action: z.literal("charge_stop") }),
  z.strictObject({
    ...identity,
    action: z.literal("charge_target"),
    targetSoc: z.number().int().min(50).max(100).multipleOf(10),
  }),
  z.strictObject({
    ...identity,
    action: z.literal("climate_start"),
    tempF: z.number().int().min(60).max(85),
    durationMin: z.number().int().min(5).max(1440),
  }),
  z.strictObject({ ...identity, action: z.literal("climate_stop") }),
  z.strictObject({
    ...identity,
    action: z.literal("climate_temperature"),
    tempF: z.number().int().min(60).max(85),
  }),
  z.strictObject({ ...identity, action: z.literal("wake") }),
]);
export const controlCommandSchema = lockCommandSchema.extend({
  action: z.enum([
    "lock",
    "unlock",
    "charge_start",
    "charge_stop",
    "charge_target",
    "climate_start",
    "climate_stop",
    "climate_temperature",
    "wake",
  ]),
  evidenceBasis: z
    .enum([
      "vehicle_status",
      "history_and_climate",
      "climate_read",
      "settings_read",
      "local_schedule",
      "wake_freshness",
    ])
    .nullable()
    .optional(),
  failureCode: lockCommandSchema.shape.failureCode
    .or(z.literal("ignition_on"))
    .or(z.literal("vehicle_busy")),
  parameters: z
    .object({
      targetSoc: z.number().optional(),
      tempF: z.number().optional(),
      durationMin: z.number().optional(),
    })
    .default({}),
  observation: z
    .object({
      lock: z.enum(["locked", "unlocked", "unknown"]),
      fetchedAt: z.number(),
      sourceUpdatedAt: z.number().nullable(),
      vehicleDataFresh: z.boolean().optional(),
      climate: z.enum(["active", "inactive", "unknown"]).optional(),
      targetTempF: z.number().nullable().optional(),
      remainingMin: z.number().nullable().optional(),
      charging: z.enum(["charging", "not_charging", "unknown"]).optional(),
      targetSoc: z.number().nullable().optional(),
    })
    .nullable(),
});
export type ControlRequest = z.infer<typeof controlRequestSchema>;
export type ControlCommand = z.infer<typeof controlCommandSchema>;

export const campSessionSchema = z.object({
  id: z.uuid(),
  vehicleId: z.uuid(),
  tempF: z.number(),
  expiresAt: z.number(),
  startedAt: z.number(),
  state: z.string(),
  controlState: z.enum([
    "inactive",
    "starting",
    "active",
    "waiting_for_restart",
    "paused",
    "stopping",
    "expired",
    "failed",
    "unknown",
  ]),
  commandId: z.string().nullable(),
  remainingMin: z.number().nullable(),
  pausedAt: z.number().nullable(),
  error: z.string().nullable(),
  automationEnabled: z.boolean(),
});
export const campResponseSchema = z.object({
  session: campSessionSchema.nullable(),
  schedulerEnabled: z.boolean(),
});
export type CampSession = z.infer<typeof campSessionSchema>;
