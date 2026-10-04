import { z } from "zod";

export const lockActionSchema = z.enum(["lock", "unlock"]);
export const lockRequestSchema = z.strictObject({
  vehicleId: z.uuid(),
  action: lockActionSchema,
  idempotencyKey: z.uuid(),
});
export const lockCommandSchema = z.object({
  id: z.uuid(),
  vehicleId: z.uuid(),
  action: lockActionSchema,
  status: z.enum([
    "requested",
    "submitting",
    "accepted",
    "waiting_for_vehicle",
    "confirmed",
    "failed",
    "timed_out",
    "unknown",
  ]),
  requestedAt: z.number(),
  submittedAt: z.number().nullable(),
  acceptedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
  historyConfirmed: z.boolean().nullable(),
  observation: z
    .object({
      lock: z.enum(["locked", "unlocked", "unknown"]),
      fetchedAt: z.number(),
      sourceUpdatedAt: z.number().nullable(),
    })
    .nullable(),
  failureCode: z
    .enum([
      "preparation_failed",
      "vw_rejected",
      "submission_uncertain",
      "vehicle_rejected",
      "confirmation_unavailable",
      "conflicting_observation",
      "confirmation_timeout",
      "restart_before_submission",
      "restart_during_submission",
      "reconciliation_required",
      "account_changed",
    ])
    .nullable(),
  confirmationRounds: z.number().int().nonnegative(),
  statusReads: z.number().int().nonnegative(),
});
export type LockCommand = z.infer<typeof lockCommandSchema>;
export type LockRequest = z.infer<typeof lockRequestSchema>;
export function lockCommandTerminal(status: LockCommand["status"]): boolean {
  return ["confirmed", "failed", "timed_out", "unknown"].includes(status);
}
