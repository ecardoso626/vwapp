import { createHash, timingSafeEqual } from "node:crypto";
import { verifyEvent, type Event } from "nostr-tools/pure";
import { AuthFailure } from "./errors";

export const MAX_AUTH_HEADER_BYTES = 12_000;
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
export const MAX_PAST_SECONDS = 60;
export const MAX_FUTURE_SECONDS = 10;

export interface VerifiedHttpEvent {
  id: string;
  pubkey: string;
  createdAtMs: number;
  expiresAtMs: number;
}

const hex64 = /^[0-9a-f]{64}$/;
const hex128 = /^[0-9a-f]{128}$/;
const nonceFormat = /^[A-Za-z0-9_-]{22,64}$/;

/** A fixed external origin; never derive authority from Host or proxy headers. */
export function validatePublicOrigin(value: string, allowHttp = false): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("NODE_PUBLIC_ORIGIN must be an absolute origin");
  }
  if (
    value !== parsed.origin ||
    (parsed.protocol !== "https:" &&
      !(allowHttp && parsed.protocol === "http:")) ||
    parsed.username !== "" ||
    parsed.password !== ""
  )
    throw new Error("NODE_PUBLIC_ORIGIN must be a canonical HTTPS origin");
  return value;
}

/** Keep the raw request target's exact path, percent encoding, and query. */
export function signedRequestUrl(origin: string, rawTarget: string): string {
  if (
    !rawTarget.startsWith("/") ||
    rawTarget.startsWith("//") ||
    rawTarget.includes("#") ||
    rawTarget.includes("\\") ||
    Array.from(rawTarget).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) ||
    /%(?![0-9A-Fa-f]{2})/.test(rawTarget)
  )
    throw new AuthFailure("malformed");
  const exact = origin + rawTarget;
  try {
    if (new URL(exact).href !== exact) throw new AuthFailure("malformed");
  } catch {
    throw new AuthFailure("malformed");
  }
  return exact;
}

function parseEvent(header: string | undefined): Event {
  if (
    header === undefined ||
    Buffer.byteLength(header) > MAX_AUTH_HEADER_BYTES ||
    !header.startsWith("Nostr ")
  )
    throw new AuthFailure("malformed");
  const encoded = header.slice("Nostr ".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0)
    throw new AuthFailure("malformed");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded || bytes.length > 8_000)
    throw new AuthFailure("malformed");
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new AuthFailure("malformed");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new AuthFailure("malformed");
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate["id"] !== "string" ||
    !hex64.test(candidate["id"]) ||
    typeof candidate["pubkey"] !== "string" ||
    !hex64.test(candidate["pubkey"]) ||
    typeof candidate["sig"] !== "string" ||
    !hex128.test(candidate["sig"]) ||
    !Number.isSafeInteger(candidate["kind"]) ||
    !Number.isSafeInteger(candidate["created_at"]) ||
    typeof candidate["content"] !== "string" ||
    !Array.isArray(candidate["tags"]) ||
    candidate["tags"].length > 24 ||
    !candidate["tags"].every(
      (tag: unknown) =>
        Array.isArray(tag) &&
        tag.length > 0 &&
        tag.length <= 4 &&
        tag.every(
          (item: unknown) => typeof item === "string" && item.length <= 4_096,
        ),
    )
  )
    throw new AuthFailure("malformed");
  return candidate as unknown as Event;
}

function singleTag(event: Event, name: string): string | undefined {
  const matches = event.tags.filter((tag) => tag[0] === name);
  if (matches.length > 1 || (matches.length === 1 && matches[0]?.length !== 2))
    throw new AuthFailure("malformed");
  return matches[0]?.[1];
}

export function verifyNip98(input: {
  authorization: string | undefined;
  method: string;
  rawTarget: string;
  body: Buffer;
  publicOrigin: string;
  nowMs: number;
}): VerifiedHttpEvent {
  const event = parseEvent(input.authorization);
  if (event.kind !== 27235 || event.content !== "")
    throw new AuthFailure("malformed");
  const nowSeconds = Math.floor(input.nowMs / 1_000);
  if (
    event.created_at < nowSeconds - MAX_PAST_SECONDS ||
    event.created_at > nowSeconds + MAX_FUTURE_SECONDS
  )
    throw new AuthFailure("stale");
  const url = singleTag(event, "u");
  const method = singleTag(event, "method");
  const payload = singleTag(event, "payload");
  const nonce = singleTag(event, "nonce");
  if (!url || !method || !nonce || !nonceFormat.test(nonce))
    throw new AuthFailure("malformed");
  if (url !== signedRequestUrl(input.publicOrigin, input.rawTarget))
    throw new AuthFailure("url_mismatch");
  if (method !== input.method) throw new AuthFailure("method_mismatch");
  const bodyCapable = !["GET", "HEAD"].includes(input.method);
  if (!bodyCapable && input.body.length !== 0)
    throw new AuthFailure("payload_mismatch");
  if (bodyCapable) {
    if (payload === undefined || !hex64.test(payload))
      throw new AuthFailure("malformed");
    const actual = createHash("sha256").update(input.body).digest();
    if (!timingSafeEqual(Buffer.from(payload, "hex"), actual))
      throw new AuthFailure("payload_mismatch");
  } else if (payload !== undefined) {
    throw new AuthFailure("malformed");
  }
  if (!verifyEvent(event)) throw new AuthFailure("invalid_signature");
  return {
    id: event.id,
    pubkey: event.pubkey,
    createdAtMs: event.created_at * 1_000,
    expiresAtMs: (event.created_at + MAX_PAST_SECONDS) * 1_000,
  };
}
