import {
  passiveCurrentSchema,
  passiveHistorySchema,
  passiveMessagesSchema,
  passiveOwnerSchema,
  passivePairedSchema,
  passiveVehiclesSchema,
  type PassiveCurrent,
  type PassiveHistory,
  type PassiveMessages,
  type PassiveOwner,
  type PassiveVehicles,
} from "@vwapp/contract/passive";
import type { DeviceIdentity } from "./device-identity";
import { signNip98 } from "./nip98";

export type BuzzKeyErrorCode =
  | "backend_unreachable"
  | "authorization_rejected"
  | "rate_limited"
  | "server_error"
  | "invalid_response";

export class BuzzKeyApiError extends Error {
  readonly code: BuzzKeyErrorCode;
  constructor(code: BuzzKeyErrorCode) {
    super(
      {
        backend_unreachable: "BuzzKey server is unavailable.",
        authorization_rejected:
          "Device authorization was rejected. Pair or re-pair this device.",
        rate_limited: "Too many requests. Try again shortly.",
        server_error: "BuzzKey server could not complete the request.",
        invalid_response: "BuzzKey server returned invalid data.",
      }[code],
    );
    this.code = code;
  }
}

export interface BuzzKeyClientOptions {
  origin: string;
  getIdentity(): Promise<DeviceIdentity>;
  randomBytes(count: number): Promise<Uint8Array>;
  sha256(bytes: Uint8Array): Promise<Uint8Array>;
  nowMs(): number;
  fetcher: typeof fetch;
}

export function createBuzzKeyClient(options: BuzzKeyClientOptions) {
  const parsed = new URL(options.origin);
  if (parsed.protocol !== "https:" || parsed.origin !== options.origin)
    throw new Error("Configure an external HTTPS BuzzKey origin");

  async function request(
    path: string,
    method = "GET",
    input?: unknown,
  ): Promise<unknown> {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("#"))
      throw new Error("Invalid BuzzKey API path");
    const url = options.origin + path;
    const body = input === undefined ? undefined : JSON.stringify(input);
    const identity = await options.getIdentity();
    const { authorization } = await signNip98({
      url,
      method,
      ...(body === undefined ? {} : { body }),
      material: {
        secretKey: identity.secretKey,
        randomBytes: (count) => options.randomBytes(count),
        sha256: (bytes) => options.sha256(bytes),
        nowMs: () => options.nowMs(),
      },
    });
    let response: Response;
    try {
      response = await options.fetcher(url, {
        method,
        headers: {
          authorization,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      throw new BuzzKeyApiError("backend_unreachable");
    }
    if (response.status === 401)
      throw new BuzzKeyApiError("authorization_rejected");
    if (response.status === 429) throw new BuzzKeyApiError("rate_limited");
    if (response.status >= 500) throw new BuzzKeyApiError("server_error");
    if (!response.ok) throw new BuzzKeyApiError("invalid_response");
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new BuzzKeyApiError("invalid_response");
    }
  }

  function parse<T>(schema: { parse(value: unknown): T }, value: unknown): T {
    try {
      return schema.parse(value);
    } catch {
      throw new BuzzKeyApiError("invalid_response");
    }
  }

  return {
    async pair(
      token: string,
      name: string,
    ): Promise<{ device: PassiveOwner["device"] }> {
      const identity = await options.getIdentity();
      const result = await request("/auth/pair", "POST", {
        token,
        pubkey: identity.pubkey,
        name,
      });
      return parse(passivePairedSchema, result);
    },
    async owner(): Promise<PassiveOwner> {
      return parse(passiveOwnerSchema, await request("/api/v1/owner"));
    },
    async vehicles(): Promise<PassiveVehicles> {
      return parse(passiveVehiclesSchema, await request("/api/v1/vehicles"));
    },
    async current(id: string): Promise<PassiveCurrent> {
      return parse(
        passiveCurrentSchema,
        await request(`/api/v1/vehicles/${encodeURIComponent(id)}/current`),
      );
    },
    async history(id: string, limit = 100): Promise<PassiveHistory> {
      return parse(
        passiveHistorySchema,
        await request(
          `/api/v1/vehicles/${encodeURIComponent(id)}/history?limit=${String(limit)}`,
        ),
      );
    },
    async messages(): Promise<PassiveMessages> {
      return parse(passiveMessagesSchema, await request("/api/v1/messages"));
    },
    async setMessageRead(
      id: string,
      readOverride: boolean | null,
    ): Promise<void> {
      await request(`/api/v1/messages/${encodeURIComponent(id)}`, "PATCH", {
        readOverride,
      });
    },
    async setMessageDeleted(id: string, deleted: boolean): Promise<void> {
      await request(`/api/v1/messages/${encodeURIComponent(id)}`, "PATCH", {
        deleted,
      });
    },
  };
}
