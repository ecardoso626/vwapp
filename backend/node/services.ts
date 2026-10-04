import { DeviceRepository } from "../auth/devices";
import { DeviceAuthService } from "../auth/service";
import { pollAllVehicles, runClimateKeepalive } from "../src/poll";
import type { SqliteStorage } from "../storage/database";
import { SecretRepository } from "../storage/secrets";
import { NodeAccountApi } from "./account";
import type { NodeConfig } from "./config";
import { NodeLockCommands } from "./lock-commands";
import { NodePassiveApi } from "./passive";
import type { NodeServices } from "./runtime";
import { NodeSqliteStore } from "./sqlite-store";

/** Node alone owns SQLite application state; the Worker retains InstantDB. */
export function createNodeServices(
  storage: SqliteStorage,
  config: NodeConfig,
): NodeServices {
  const secrets = new SecretRepository(
    storage,
    config.masterKeyId,
    config.masterKey,
  );
  const db = new NodeSqliteStore(storage, secrets, config.env.CREDS_ENC_KEY);
  return {
    auth: new DeviceAuthService(
      new DeviceRepository(storage),
      config.publicOrigin,
    ),
    db,
    commands: new NodeLockCommands(storage, db, config.env),
    account: new NodeAccountApi(storage, db, secrets, config.env),
    passive: new NodePassiveApi(storage, db),
    poll: () => pollAllVehicles(db, config.env),
    climate: () => runClimateKeepalive(db, config.env),
  };
}
