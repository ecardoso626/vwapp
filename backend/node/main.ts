import { pollAllVehicles, runClimateKeepalive } from "../src/poll";
import { getDb } from "../src/store";
import { loadNodeConfig } from "./config";
import { createNodeRuntime, installShutdownSignals } from "./runtime";

const config = loadNodeConfig(process.env);
const db = getDb(config.env);
const runtime = createNodeRuntime(config, {
  db,
  poll: () => pollAllVehicles(db, config.env),
  climate: () => runClimateKeepalive(db, config.env),
});

try {
  const address = await runtime.start();
  installShutdownSignals(() => runtime.stop());
  console.log(
    `[node] listening on ${address.host}:${String(address.port)}; scheduler ${config.schedulerEnabled ? "enabled" : "disabled"}`,
  );
} catch (error) {
  console.error("[node] startup failed", error);
  process.exitCode = 1;
}
