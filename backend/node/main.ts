import { DeviceRepository } from "../auth/devices";
import { DeviceAuthService } from "../auth/service";
import { pollAllVehicles, runClimateKeepalive } from "../src/poll";
import { getDb } from "../src/store";
import { SqliteStorage } from "../storage/database";
import { loadNodeConfig } from "./config";
import { createNodeRuntime, installShutdownSignals } from "./runtime";

const config = loadNodeConfig(process.env);
const authStorage = SqliteStorage.open(config.sqlitePath);

try {
  const auth = new DeviceAuthService(
    new DeviceRepository(authStorage),
    config.publicOrigin,
  );
  const db = getDb(config.env);
  const runtime = createNodeRuntime(config, {
    auth,
    db,
    poll: () => pollAllVehicles(db, config.env),
    climate: () => runClimateKeepalive(db, config.env),
  });
  const address = await runtime.start();
  installShutdownSignals(async () => {
    await runtime.stop();
    authStorage.close();
  });
  console.log(
    `[node] listening on ${address.host}:${String(address.port)}; scheduler ${config.schedulerEnabled ? "enabled" : "disabled"}`,
  );
} catch (error) {
  authStorage.close();
  console.error("[node] startup failed", error);
  process.exitCode = 1;
}
