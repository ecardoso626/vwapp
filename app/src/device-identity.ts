import { getPublicKey } from "nostr-tools/pure";

export interface SecureIdentityStorage {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
}
export interface DeviceIdentity {
  secretKey: Uint8Array;
  pubkey: string;
}

export class DeviceIdentityRecoveryError extends Error {
  constructor() {
    super("Stored device identity is invalid; pairing recovery is required");
  }
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");

function decodeSecret(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new DeviceIdentityRecoveryError();
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index++)
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  try {
    getPublicKey(bytes);
  } catch {
    throw new DeviceIdentityRecoveryError();
  }
  return bytes;
}

/** Never replaces a malformed or unreadable stored key without an explicit reset. */
export async function loadOrCreateDeviceIdentity(
  storage: SecureIdentityStorage,
  randomBytes: (count: number) => Promise<Uint8Array>,
): Promise<DeviceIdentity> {
  const saved = await storage.get();
  if (saved !== null) {
    const secretKey = decodeSecret(saved);
    return { secretKey, pubkey: getPublicKey(secretKey) };
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = await randomBytes(32);
    if (candidate.length !== 32) throw new Error("Device entropy unavailable");
    try {
      const pubkey = getPublicKey(candidate);
      await storage.set(hex(candidate));
      return { secretKey: candidate, pubkey };
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  throw new Error("Device identity generation failed");
}
