import { z } from "zod";

/** Cached connection evidence, separate from NIP-98 device authorization. */
export const accountConnectionSchema = z.object({
  state: z.enum([
    "unlinked",
    "pin_required",
    "connected",
    "session_unusable",
    "reauthentication_required",
    "credentials_missing",
    "disconnected",
  ]),
  accountId: z.string().nullable(),
  linked: z.boolean(),
  credentialsPresent: z.boolean(),
  spinPresent: z.boolean(),
  session: z.enum(["missing", "unverified", "usable", "expired", "unusable"]),
  verifiedAt: z.number().nullable(),
  vehicleAvailable: z.boolean(),
  reconnectAvailable: z.boolean(),
  pendingPin: z.boolean(),
  lastFailure: z
    .enum([
      "authentication_failed",
      "service_unavailable",
      "status_read_failed",
    ])
    .nullable(),
});
export const accountAttemptSchema = z.object({
  attemptId: z.uuid(),
  expiresAt: z.number(),
});
export const accountActionSchema = z.object({
  connection: accountConnectionSchema,
  pending: accountAttemptSchema.nullable(),
});
export const accountCredentialsSchema = z.strictObject({
  username: z.string().min(1).max(320),
  password: z.string().min(1).max(4096),
});
export const accountConnectSchema = z.strictObject({
  attemptId: z.uuid(),
  spin: z.string().regex(/^\d{4,6}$/),
});
export const accountEmptySchema = z.strictObject({});
export type AccountConnection = z.infer<typeof accountConnectionSchema>;
export type AccountAttempt = z.infer<typeof accountAttemptSchema>;
export type AccountAction = z.infer<typeof accountActionSchema>;
