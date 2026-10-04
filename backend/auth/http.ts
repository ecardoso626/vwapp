import { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";
import type { AuthorizedDevice } from "./devices";
import { AuthFailure } from "./errors";
import { MAX_REQUEST_BODY_BYTES, signedRequestUrl } from "./nip98";
import { classifyEndpoint, type DeviceAuthService } from "./service";

export class RequestBodyTooLarge extends Error {}

export type HttpAuthDecision =
  | { kind: "public" }
  | { kind: "paired"; device: AuthorizedDevice }
  | {
      kind: "authorized";
      device: AuthorizedDevice;
      body: Buffer;
      signedUrl: string;
    };

async function boundedBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > MAX_REQUEST_BODY_BYTES) throw new RequestBodyTooLarge();
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

/** Node ingress boundary: authenticate exact bytes before invoking application logic. */
export async function authenticateHttpRequest(
  request: IncomingMessage,
  auth: DeviceAuthService,
  publicOrigin: string,
): Promise<HttpAuthDecision> {
  const method = request.method;
  const rawTarget = request.url;
  if (method === undefined || rawTarget === undefined)
    throw new AuthFailure("malformed");
  const signedUrl = signedRequestUrl(publicOrigin, rawTarget);
  const endpoint = classifyEndpoint(method, new URL(signedUrl).pathname);
  if (endpoint === "public") return { kind: "public" };
  const source = request.socket.remoteAddress ?? "unknown";
  auth.begin(source, endpoint);
  const authHeaders = request.rawHeaders.filter(
    (value, index) =>
      index % 2 === 0 && value.toLowerCase() === "authorization",
  );
  if (authHeaders.length !== 1) throw new AuthFailure("malformed");
  const body = await boundedBody(request);
  const signed = {
    authorization: request.headers.authorization,
    method,
    rawTarget,
    pathname: new URL(signedUrl).pathname,
    body,
    source,
  };
  if (endpoint === "pairing") {
    return { kind: "paired", device: auth.pair(signed) };
  }
  return {
    kind: "authorized",
    device: auth.authorize(signed, endpoint),
    body,
    signedUrl,
  };
}

/** Deliberately small external error vocabulary. Internal AuthFailure.code remains available. */
export function authHttpError(error: unknown): {
  status: number;
  body: string;
} {
  if (error instanceof RequestBodyTooLarge)
    return { status: 413, body: '{"error":"request_too_large"}' };
  if (error instanceof AuthFailure && error.code === "rate_limited")
    return { status: 429, body: '{"error":"rate_limited"}' };
  if (error instanceof AuthFailure)
    return { status: 401, body: '{"error":"unauthorized"}' };
  return { status: 500, body: '{"error":"internal_error"}' };
}
