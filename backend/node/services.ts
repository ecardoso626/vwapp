import { DeviceRepository } from "../auth/devices";
import { DeviceAuthService } from "../auth/service";
import { pollAllVehicles, runClimateKeepalive } from "../src/poll";
import type { SqliteStorage } from "../storage/database";
import { SecretRepository } from "../storage/secrets";
import type { NodeConfig } from "./config";
import type { NodeServices } from "./runtime";
import { NodeSqliteStore } from "./sqlite-store";

/** Node alone owns SQLite application state; the Worker retains InstantDB. */
export function createNodeServices(
  storage: SqliteStorage,
  config: NodeConfig,
): NodeServices {
  const db = new NodeSqliteStore(
    storage,
    new SecretRepository(storage, config.masterKeyId, config.masterKey),
    config.env.CREDS_ENC_KEY,
  );
  return {
    auth: new DeviceAuthService(
      new DeviceRepository(storage),
      config.publicOrigin,
    ),
    db,
    poll: () => pollAllVehicles(db, config.env),
    climate: () => runClimateKeepalive(db, config.env),
  };
}
