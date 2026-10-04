import { z } from "zod";
import { validatePublicOrigin } from "../auth/nip98";
import type { AppEnv } from "../src/env";

export interface NodeConfig {
  host: string;
  port: number;
  /** Off by default while the Worker may still be polling the same account. */
  schedulerEnabled: boolean;
  publicOrigin: string;
  sqlitePath: string;
  env: AppEnv;
}

const schema = z.object({
  NODE_HOST: z.string().min(1).default("127.0.0.1"),
  NODE_PORT: z.coerce.number().int().min(0).max(65535).default(8788),
  NODE_SCHEDULER_ENABLED: z.enum(["true", "false"]).default("false"),
  NODE_PUBLIC_ORIGIN: z.string().min(1),
  BUZZKEY_SQLITE_PATH: z.string().min(1),
  INSTANT_APP_ID: z.string().min(1),
  INSTANT_ADMIN_TOKEN: z.string().min(1),
  CREDS_ENC_KEY: z
    .string()
    .refine(
      (value) =>
        /^[A-Za-z0-9+/]{43}=$/.test(value) &&
        Buffer.from(value, "base64").length === 32,
      "must be base64 of exactly 32 bytes",
    ),
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
  if (mode === "production" && values.NODE_PORT === 0)
    throw new Error("Invalid Node configuration: NODE_PORT must be nonzero");
  if (mode === "production" && values.BUZZKEY_SQLITE_PATH === ":memory:")
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
    sqlitePath: values.BUZZKEY_SQLITE_PATH,
    env: {
      INSTANT_APP_ID: values.INSTANT_APP_ID,
      INSTANT_ADMIN_TOKEN: values.INSTANT_ADMIN_TOKEN,
      CREDS_ENC_KEY: values.CREDS_ENC_KEY,
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
