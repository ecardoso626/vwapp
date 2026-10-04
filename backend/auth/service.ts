import type { AuthorizedDevice, DeviceRepository } from "./devices";
import { AuthFailure } from "./errors";
import { RequestLimiter } from "./limits";
import { verifyNip98 } from "./nip98";

const READ_PATHS = new Set([
  "/rpc/auth/me",
  "/rpc/vehicle/climateInfo",
  "/rpc/vehicle/activity",
  "/rpc/vehicle/messages",
  "/rpc/vehicle/refreshMessages",
  "/rpc/vehicle/parkedMapUrl",
]);
const PASSIVE_READ_PATHS = new Set([
  "/api/v1/owner",
  "/api/v1/vehicles",
  "/api/v1/messages",
  "/api/v1/account",
]);

export type EndpointClass = "public" | "pairing" | "read" | "control";

export function classifyEndpoint(method: string, path: string): EndpointClass {
  if (method === "GET" && path === "/health") return "public";
  if (method === "POST" && path === "/auth/pair") return "pairing";
  if (
    method === "GET" &&
    (PASSIVE_READ_PATHS.has(path) ||
      /^\/api\/v1\/commands\/(key\/)?[0-9a-f-]{36}$/.test(path) ||
      /^\/api\/v1\/vehicles\/[0-9a-f-]{36}\/(current|history|climate-session)$/.test(
        path,
      ))
  )
    return "read";
  if (method === "PATCH" && /^\/api\/v1\/messages\/[^/]+$/.test(path))
    return "read";
  return READ_PATHS.has(path) ? "read" : "control";
}

export interface AuthRequest {
  authorization: string | undefined;
  method: string;
  rawTarget: string;
  pathname: string;
  body: Buffer;
  source: string;
}

export class DeviceAuthService {
  private readonly devices: DeviceRepository;
  private readonly publicOrigin: string;
  private readonly now: () => number;
  private readonly limiter: RequestLimiter;

  constructor(
    devices: DeviceRepository,
    publicOrigin: string,
    now: () => number = Date.now,
    limiter = new RequestLimiter(),
  ) {
    this.devices = devices;
    this.publicOrigin = publicOrigin;
    this.now = now;
    this.limiter = limiter;
  }

  /** Charge unauthenticated work to the actual socket peer, never a claimed key. */
  begin(source: string, endpoint: EndpointClass): void {
    const nowMs = this.now();
    this.limiter.take("ingress", source, 120, 60_000, nowMs);
    if (endpoint === "pairing") {
      this.limiter.take("pair-source", source, 5, 5 * 60_000, nowMs);
      this.limiter.take("pair-global", "all", 20, 5 * 60_000, nowMs);
    }
  }

  authorize(
    request: AuthRequest,
    endpoint: "read" | "control",
  ): AuthorizedDevice {
    const nowMs = this.now();
    const event = verifyNip98({
      ...request,
      publicOrigin: this.publicOrigin,
      nowMs,
    });
    const device = this.devices.getByPubkey(event.pubkey);
    if (device === null) throw new AuthFailure("unknown_device");
    if (device.revokedAt !== null) throw new AuthFailure("revoked_device");
    this.limiter.take(
      endpoint,
      device.id,
      endpoint === "control" ? 10 : 60,
      60_000,
      nowMs,
    );
    return this.devices.consumeReplay(
      event.id,
      event.pubkey,
      nowMs,
      event.expiresAtMs,
    );
  }

  pair(request: AuthRequest): AuthorizedDevice {
    const nowMs = this.now();
    const event = verifyNip98({
      ...request,
      publicOrigin: this.publicOrigin,
      nowMs,
    });
    let candidate: unknown;
    try {
      candidate = JSON.parse(request.body.toString("utf8")) as unknown;
    } catch {
      throw new AuthFailure("pairing_invalid");
    }
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    )
      throw new AuthFailure("pairing_invalid");
    const value = candidate as Record<string, unknown>;
    if (
      typeof value["token"] !== "string" ||
      typeof value["pubkey"] !== "string" ||
      typeof value["name"] !== "string" ||
      value["pubkey"] !== event.pubkey ||
      Object.keys(value).length !== 3
    )
      throw new AuthFailure("pairing_invalid");
    return this.devices.pair(
      value["token"],
      event.pubkey,
      value["name"],
      nowMs,
    );
  }
}
