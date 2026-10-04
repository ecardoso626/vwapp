import { z } from "zod";
import { validatePublicOrigin } from "../auth/nip98";
import type { AppEnv } from "../src/env";
import { loadStorageConfig } from "../storage/config";

export interface NodeConfig {
  host: string;
  port: number;
  /** Off by default while the Worker may still be polling the same account. */
  schedulerEnabled: boolean;
  publicOrigin: string;
  sqlitePath: string;
  masterKeyId: string;
  masterKey: Buffer;
  env: AppEnv;
}

const schema = z.object({
  NODE_HOST: z.string().min(1).default("127.0.0.1"),
  NODE_PORT: z.coerce.number().int().min(0).max(65535).default(8788),
  NODE_SCHEDULER_ENABLED: z.enum(["true", "false"]).default("false"),
  NODE_PUBLIC_ORIGIN: z.string().min(1),
  APPLE_MAPS_TEAM_ID: z.string().min(1).optional(),
  APPLE_MAPS_KEY_ID: z.string().min(1).optional(),
  APPLE_MAPS_PRIVATE_KEY: z.string().min(1).optional(),
});

/** The test mode permits an ephemeral port; production requires a fixed port. */
export function loadNodeConfig(
  source: NodeJS.ProcessEnv,
  mode: "production" | "test" = "production",
): NodeConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(`Invalid Node configuration: ${issues.join("; ")}`);
  }
  const values = parsed.data;
  const storage = loadStorageConfig(source);
  if (mode === "production" && values.NODE_PORT === 0)
    throw new Error("Invalid Node configuration: NODE_PORT must be nonzero");
  if (mode === "production" && storage.path === ":memory:")
    throw new Error(
      "Invalid Node configuration: persistent BUZZKEY_SQLITE_PATH required",
    );
  return {
    host: values.NODE_HOST,
    port: values.NODE_PORT,
    schedulerEnabled: values.NODE_SCHEDULER_ENABLED === "true",
    publicOrigin: validatePublicOrigin(
      values.NODE_PUBLIC_ORIGIN,
      mode === "test",
    ),
    sqlitePath: storage.path,
    masterKeyId: storage.keyId,
    masterKey: storage.masterKey,
    env: {
      CREDS_ENC_KEY: storage.masterKey.toString("base64"),
      ...(values.APPLE_MAPS_TEAM_ID === undefined
        ? {}
        : { APPLE_MAPS_TEAM_ID: values.APPLE_MAPS_TEAM_ID }),
      ...(values.APPLE_MAPS_KEY_ID === undefined
        ? {}
        : { APPLE_MAPS_KEY_ID: values.APPLE_MAPS_KEY_ID }),
      ...(values.APPLE_MAPS_PRIVATE_KEY === undefined
        ? {}
        : { APPLE_MAPS_PRIVATE_KEY: values.APPLE_MAPS_PRIVATE_KEY }),
    },
  };
}
