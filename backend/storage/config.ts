import { readFileSync } from "node:fs";

export interface StorageConfig {
  path: string;
  keyId: string;
  masterKey: Buffer;
}

/** Runtime-only input; never persist the key or echo supplied values in errors. */
export function loadStorageConfig(source: NodeJS.ProcessEnv): StorageConfig {
  const path = source["BUZZKEY_SQLITE_PATH"];
  const keyId = source["BUZZKEY_MASTER_KEY_ID"];
  const encoded = source["BUZZKEY_MASTER_KEY_B64"];
  const keyFile = source["BUZZKEY_MASTER_KEY_FILE"];
  if (!path || path.trim() === "")
    throw new Error("BUZZKEY_SQLITE_PATH is required");
  if (!keyId || !/^[A-Za-z0-9_-]{1,64}$/.test(keyId))
    throw new Error(
      "BUZZKEY_MASTER_KEY_ID is required and must be a short identifier",
    );
  if (Boolean(encoded) === Boolean(keyFile))
    throw new Error(
      "Supply exactly one of BUZZKEY_MASTER_KEY_FILE or BUZZKEY_MASTER_KEY_B64",
    );
  let base64: string;
  if (keyFile !== undefined && keyFile !== "") {
    try {
      base64 = readFileSync(keyFile, "utf8").trim();
    } catch {
      throw new Error("BUZZKEY_MASTER_KEY_FILE cannot be read");
    }
  } else {
    base64 = encoded ?? "";
  }
  if (!/^[A-Za-z0-9+/]{43}=$/.test(base64))
    throw new Error("Master key must be padded base64 of exactly 32 bytes");
  const masterKey = Buffer.from(base64, "base64");
  if (masterKey.length !== 32)
    throw new Error("Master key must be exactly 32 bytes");
  return { path, keyId, masterKey };
}
