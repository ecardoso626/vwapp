import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import { requireBuzzKey } from "./buzzkey-native";
import {
  ControlSubmissions,
  prepareControlIntent,
  type ControlInput,
} from "./control-intent";
import { getDeviceIdentity } from "./device-identity-native";

const submissions = new ControlSubmissions();
export async function controlStorage(vehicleId: string, channel: string) {
  const identity = await getDeviceIdentity();
  const origin = process.env.EXPO_PUBLIC_NODE_ORIGIN;
  if (!origin) throw new Error("BuzzKey origin is required");
  const namespace = `buzzkey-control-intent-v1:${origin}:${identity.pubkey}:${vehicleId}:${channel}`;
  return {
    namespace,
    get: () => AsyncStorage.getItem(namespace),
    set: (value: string) => AsyncStorage.setItem(namespace, value),
    clear: () => AsyncStorage.removeItem(namespace),
  };
}
export async function submitControl(
  input: ControlInput,
  channel: string,
  prepared: (intent: Awaited<ReturnType<typeof prepareControlIntent>>) => void,
) {
  const storage = await controlStorage(input.vehicleId, channel);
  return submissions.run(storage.namespace, input, async () => {
    const intent = await prepareControlIntent(
      storage,
      input,
      Crypto.randomUUID,
    );
    prepared(intent);
    return requireBuzzKey().requestControl(intent);
  });
}
