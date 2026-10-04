import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { contract } from "@vwapp/contract";
import Constants from "expo-constants";
import { db } from "./db";

/** Optional Worker URL for existing transitional controls and signed map URLs.
 * Node account setup and passive reads never require this configuration. */
function resolveApiUrl(): string | null {
  const override = process.env.EXPO_PUBLIC_API_URL;
  if (override !== undefined && override !== "") return override;
  const hostUri = Constants.expoConfig?.hostUri;
  if (__DEV__ && hostUri !== undefined) {
    const host = hostUri.split(":")[0];
    if (host !== undefined && host !== "") return `http://${host}:8787/rpc`;
  }
  return null; // Optional transitional controls configuration.
}

/** Exported for display in Settings — "which backend am I talking to?". */
export const API_URL = resolveApiUrl();

const link = new RPCLink({
  url: () => {
    if (API_URL === null || db === null)
      throw new Error("Legacy controls are not configured.");
    return API_URL;
  },
  // The Worker verifies this Instant guest token to identify the user.
  headers: async () => {
    const user = await db?.getAuth();
    return user == null
      ? {}
      : { authorization: `Bearer ${user.refresh_token}` };
  },
});

export const client =
  createORPCClient<ContractRouterClient<typeof contract>>(link);
export const orpc = createTanstackQueryUtils(client);
