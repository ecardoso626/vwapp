import "./polyfills";
import * as Crypto from "expo-crypto";
import { createBuzzKeyClient } from "./buzzkey-client";
import { getDeviceIdentity } from "./device-identity-native";

const origin = process.env.EXPO_PUBLIC_NODE_ORIGIN;

/** Undefined configuration is shown as a boot error, never a legacy fallback. */
export const buzzkey =
  origin === undefined || origin === ""
    ? null
    : createBuzzKeyClient({
        origin,
        getIdentity: getDeviceIdentity,
        randomBytes: Crypto.getRandomBytesAsync,
        sha256: async (bytes) => {
          const buffer = new ArrayBuffer(bytes.length);
          new Uint8Array(buffer).set(bytes);
          return new Uint8Array(
            await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, buffer),
          );
        },
        nowMs: Date.now,
        fetcher: globalThis.fetch,
      });

export function requireBuzzKey() {
  if (buzzkey === null)
    throw new Error(
      "Set EXPO_PUBLIC_NODE_ORIGIN to the external HTTPS BuzzKey origin",
    );
  return buzzkey;
}
