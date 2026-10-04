import {
  controlRequestSchema,
  type ControlCommand,
  type ControlRequest,
} from "@vwapp/contract/control";
import type { IntentStorage } from "./lock-intent";

export type ControlInput = ControlRequest extends infer R
  ? R extends ControlRequest
    ? Omit<R, "idempotencyKey">
    : never
  : never;
export async function readControlIntent(
  storage: IntentStorage,
): Promise<ControlRequest | null> {
  const saved = await storage.get();
  if (saved === null) return null;
  try {
    return controlRequestSchema.parse(JSON.parse(saved) as unknown);
  } catch {
    throw new Error(
      "Saved command is invalid. Resolve it before sending another command.",
    );
  }
}
export async function prepareControlIntent(
  storage: IntentStorage,
  input: ControlInput,
  key: () => string,
): Promise<ControlRequest> {
  const saved = await readControlIntent(storage);
  const next = controlRequestSchema.parse({
    ...input,
    idempotencyKey: saved?.idempotencyKey ?? key(),
  });
  if (saved !== null && JSON.stringify(saved) !== JSON.stringify(next))
    throw new Error(
      "Check or resolve the previous command before a different action.",
    );
  if (saved === null) await storage.set(JSON.stringify(next));
  return next;
}
export class ControlSubmissions {
  private readonly jobs = new Map<
    string,
    { input: string; work: Promise<ControlCommand> }
  >();
  run(
    namespace: string,
    input: ControlInput,
    submit: () => Promise<ControlCommand>,
  ): Promise<ControlCommand> {
    const active = this.jobs.get(namespace);
    const fingerprint = JSON.stringify(input);
    if (active !== undefined)
      return active.input === fingerprint
        ? active.work
        : Promise.reject(new Error("A different command is pending."));
    const work = Promise.resolve()
      .then(submit)
      .finally(() => {
        this.jobs.delete(namespace);
      });
    this.jobs.set(namespace, { input: fingerprint, work });
    return work;
  }
}
export function controlLabel(
  command: ControlCommand | undefined,
  pending: boolean,
) {
  if (pending) return "Submitting…";
  if (command === undefined) return null;
  if (["requested", "submitting"].includes(command.status))
    return "Submitting…";
  if (["accepted", "waiting_for_vehicle"].includes(command.status))
    return "Waiting for vehicle…";
  if (command.status === "confirmed") {
    if (command.evidenceBasis === "local_schedule") return "Schedule updated";
    if (command.evidenceBasis === "wake_freshness")
      return "Fresh vehicle data received";
    if (command.evidenceBasis === "settings_read")
      return "Temperature setting verified";
    return "Confirmed from vehicle evidence";
  }
  if (command.status === "failed") return "Command failed";
  return "Could not confirm. Check the vehicle.";
}
