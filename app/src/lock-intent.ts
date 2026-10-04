import {
  lockActionSchema,
  type LockCommand,
  type LockRequest,
} from "@vwapp/contract/lock-command";
import { z } from "zod";

const intentSchema = z.strictObject({
  vehicleId: z.uuid(),
  action: lockActionSchema,
  idempotencyKey: z.uuid(),
});
export interface IntentStorage {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  clear(): Promise<void>;
}
export interface LockClient {
  requestLock(input: LockRequest): Promise<LockCommand>;
}
/** Only nonsecret intent metadata is persisted, before any signed submission. */
export async function readLockIntent(
  storage: IntentStorage,
): Promise<LockRequest | null> {
  const saved = await storage.get();
  if (saved === null) return null;
  try {
    return intentSchema.parse(JSON.parse(saved) as unknown);
  } catch {
    throw new Error(
      "Saved command request is invalid. Resolve it before sending a new command.",
    );
  }
}
export async function prepareLockIntent(
  storage: IntentStorage,
  vehicleId: string,
  action: LockRequest["action"],
  createKey: () => string,
): Promise<LockRequest> {
  const saved = await readLockIntent(storage);
  if (saved !== null) {
    if (saved.vehicleId !== vehicleId || saved.action !== action)
      throw new Error(
        "Check or resolve the previous command before requesting a different action.",
      );
    return saved;
  }
  const intent = intentSchema.parse({
    vehicleId,
    action,
    idempotencyKey: createKey(),
  });
  await storage.set(JSON.stringify(intent));
  return intent;
}
/** Future native biometric/passcode gate runs locally, before unlock signing. */
export async function submitLockIntent(
  client: LockClient,
  intent: LockRequest,
  authorizeUnlock: () => Promise<void>,
): Promise<LockCommand> {
  if (intent.action === "unlock") await authorizeUnlock();
  return client.requestLock(intent);
}
export function lockPresentation(
  command: LockCommand | undefined,
  cached: { lock: "locked" | "unlocked" | "unknown"; fetchedAt: number },
  sending: boolean,
  sendingAction: LockRequest["action"] = "lock",
) {
  const observation = command?.observation;
  const lock =
    observation !== null &&
    observation !== undefined &&
    observation.fetchedAt > cached.fetchedAt
      ? observation.lock
      : cached.lock;
  const physicalLabel =
    lock === "locked"
      ? "Locked"
      : lock === "unlocked"
        ? "Unlocked"
        : "Status unknown";
  const label =
    sending ||
    command?.status === "requested" ||
    command?.status === "submitting"
      ? (command?.action ?? sendingAction) === "unlock"
        ? "Unlocking…"
        : "Locking…"
      : command?.status === "accepted" ||
          command?.status === "waiting_for_vehicle"
        ? "Waiting for vehicle…"
        : command?.status === "timed_out" || command?.status === "unknown"
          ? "Could not confirm"
          : command?.status === "failed"
            ? "Command failed"
            : physicalLabel;
  return { lock, physicalLabel, label };
}

/** Coalesce taps before storage/signing finishes; different intents stay explicit. */
export class LockSubmissionCoordinator {
  private readonly pending = new Map<
    string,
    { action: LockRequest["action"]; work: Promise<LockCommand> }
  >();
  run(
    namespace: string,
    action: LockRequest["action"],
    submit: () => Promise<LockCommand>,
  ): Promise<LockCommand> {
    const existing = this.pending.get(namespace);
    if (existing !== undefined)
      return existing.action === action
        ? existing.work
        : Promise.reject(
            new Error(
              "Check or resolve the previous command before requesting a different action.",
            ),
          );
    const work = Promise.resolve()
      .then(submit)
      .finally(() => {
        this.pending.delete(namespace);
      });
    this.pending.set(namespace, { action, work });
    return work;
  }
}
