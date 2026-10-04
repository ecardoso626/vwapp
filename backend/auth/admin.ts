import { SqliteStorage } from "../storage/database";
import { DeviceRepository } from "./devices";

/** Local operator CLI only. Never expose these actions over anonymous HTTP. */
function main(args: string[], databasePath: string | undefined): void {
  if (!databasePath) throw new Error("BUZZKEY_SQLITE_PATH is required");
  const store = SqliteStorage.open(databasePath);
  try {
    const devices = new DeviceRepository(store);
    const [operation, id] = args;
    if (operation === "issue" && args.length === 1) {
      process.stdout.write(`${devices.issuePairing(Date.now())}\n`);
    } else if (operation === "list" && args.length === 1) {
      process.stdout.write(`${JSON.stringify(devices.listDevices())}\n`);
    } else if (operation === "revoke" && id && args.length === 2) {
      if (!devices.revoke(id, Date.now()))
        throw new Error("Device not found or already revoked");
      process.stdout.write("revoked\n");
    } else {
      throw new Error("Usage: auth-admin <issue|list|revoke DEVICE_ID>");
    }
  } finally {
    store.close();
  }
}

try {
  main(process.argv.slice(2), process.env["BUZZKEY_SQLITE_PATH"]);
} catch (error) {
  console.error(
    "[auth-admin]",
    error instanceof Error ? error.message : "Operation failed",
  );
  process.exitCode = 1;
}
