/**
 * Cron: fetch live status from VW for every stored account and write
 * SQLite snapshots. Mobile reads the current state through the Node API.
 */
import {
  listAccounts,
  pruneSnapshots,
  saveSnapshot,
  type Db,
} from "./application-store";
import { unseal } from "./crypto";
import type { AppEnv } from "./env";
import { readStatus } from "./status";

const SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function pollAllVehicles(db: Db, env: AppEnv): Promise<void> {
  const accounts = await listAccounts(db);
  let polled = 0;
  let written = 0;
  for (const { account, vehicles } of accounts) {
    try {
      // Status reads are S-PIN gated now, so an account with no stored S-PIN
      // simply can't be polled (it can still be used for anything that only
      // needs the access token). Log once per tick rather than throwing.
      const creds = JSON.parse(
        await unseal(env.CREDS_ENC_KEY, account.sealed),
      ) as { spin?: string };
      if (creds.spin === undefined || creds.spin === "") {
        console.log(
          `[cron] account=${account.id} skipped: no stored S-PIN (status reads are S-PIN gated)`,
        );
        continue;
      }
      for (const vehicle of vehicles) {
        const status = await readStatus(db, env, account, vehicle, creds.spin);
        if (await saveSnapshot(db, vehicle.id, status)) written++;
        polled++;
      }
    } catch (err) {
      // One bad account (e.g. changed VW password) must not block the rest.
      console.error(`[cron] poll failed for account ${account.id}`, err);
    }
  }
  const pruned = await pruneSnapshots(db, Date.now() - SNAPSHOT_RETENTION_MS);
  // Heartbeat: a gap in these lines means the cron itself stopped firing —
  // otherwise indistinguishable from "nothing changed" until data goes stale.
  console.log(
    `[poll] poll tick: ${String(polled)} vehicles / ${String(accounts.length)} accounts, ${String(written)} snapshots written${pruned > 0 ? `, ${String(pruned)} pruned` : ""}`,
  );
}
