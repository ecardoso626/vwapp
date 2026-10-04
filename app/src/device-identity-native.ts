import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { loadOrCreateDeviceIdentity } from "./device-identity";

const KEY = "buzzkey-device-secret-v1";
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/** App-specific Nostr key in iOS Keychain; no AsyncStorage or social identity. */
export const getDeviceIdentity = () =>
  loadOrCreateDeviceIdentity(
    {
      get: () => SecureStore.getItemAsync(KEY, OPTIONS),
      set: (value) => SecureStore.setItemAsync(KEY, value, OPTIONS),
    },
    Crypto.getRandomBytesAsync,
  );

/** Explicit recovery only: the server must authorize a newly generated key. */
export const resetDeviceIdentity = () =>
  SecureStore.deleteItemAsync(KEY, OPTIONS);
