import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import { requireBuzzKey } from "./buzzkey-native";
import { getDeviceIdentity } from "./device-identity-native";
import {
  LockSubmissionCoordinator,
  prepareLockIntent,
  readLockIntent,
  submitLockIntent,
  type IntentStorage,
} from "./lock-intent";

export async function lockIntentStorage(
  vehicleId: string,
): Promise<IntentStorage & { namespace: string }> {
  const identity = await getDeviceIdentity();
  const origin = process.env.EXPO_PUBLIC_NODE_ORIGIN;
  if (origin === undefined || origin === "")
    throw new Error("BuzzKey origin is required");
  const key = `buzzkey-lock-intent-v1:${origin}:${identity.pubkey}:${vehicleId}`;
  return {
    namespace: key,
    get: () => AsyncStorage.getItem(key),
    set: (value) => AsyncStorage.setItem(key, value),
    clear: () => AsyncStorage.removeItem(key),
  };
}
/** Hook for a later Face ID/passcode implementation. No biometric assurance is claimed or sent. */
export function authorizeLocalUnlock(): Promise<void> {
  return Promise.resolve();
}
export async function pendingLockIntent(vehicleId: string) {
  return readLockIntent(await lockIntentStorage(vehicleId));
}
const submissions = new LockSubmissionCoordinator();
export async function requestNodeLock(
  vehicleId: string,
  action: "lock" | "unlock",
  onPrepared: (intent: Awaited<ReturnType<typeof prepareLockIntent>>) => void,
) {
  const storage = await lockIntentStorage(vehicleId);
  return submissions.run(storage.namespace, action, async () => {
    const intent = await prepareLockIntent(
      storage,
      vehicleId,
      action,
      Crypto.randomUUID,
    );
    onPrepared(intent);
    return submitLockIntent(requireBuzzKey(), intent, authorizeLocalUnlock);
  });
}
export async function clearLockIntent(vehicleId: string) {
  await (await lockIntentStorage(vehicleId)).clear();
}
