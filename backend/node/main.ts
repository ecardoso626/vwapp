import { SqliteStorage } from "../storage/database";
import { loadNodeConfig } from "./config";
import { createNodeRuntime, installShutdownSignals } from "./runtime";
import { createNodeServices } from "./services";

const config = loadNodeConfig(process.env);
const authStorage = SqliteStorage.open(config.sqlitePath);

try {
  const runtime = createNodeRuntime(
    config,
    createNodeServices(authStorage, config),
  );
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
