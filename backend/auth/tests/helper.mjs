import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

export const nowMs = 1_700_000_000_000;
export const origin = "https://buzzkey.test";
export const keyA = new Uint8Array(32).fill(1);
export const keyB = new Uint8Array(32).fill(2);
export const pubkeyA = getPublicKey(keyA);
export const pubkeyB = getPublicKey(keyB);

let nonceCounter = 0;
export function signedRequest({
  key = keyA,
  method = "GET",
  target = "/api/v1/owner",
  body = Buffer.alloc(0),
  createdAt = Math.floor(nowMs / 1_000),
  tags = [],
} = {}) {
  const nonce = Buffer.alloc(16);
  nonce.writeUInt32BE(++nonceCounter, 12);
  const standard = [
    ["u", origin + target],
    ["method", method],
    ["nonce", nonce.toString("base64url")],
    ...(!["GET", "HEAD"].includes(method)
      ? [["payload", createHash("sha256").update(body).digest("hex")]]
      : []),
  ];
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: createdAt,
      content: "",
      tags: [...standard, ...tags],
    },
    key,
  );
  return {
    event,
    request: {
      authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`,
      method,
      rawTarget: target,
      pathname: target.split("?")[0],
      body,
      source: "127.0.0.1",
    },
  };
}

export function pairingRequest(token, name = "Synthetic iPhone", key = keyA) {
  const body = Buffer.from(
    JSON.stringify({ token, pubkey: getPublicKey(key), name }),
  );
  return signedRequest({
    key,
    method: "POST",
    target: "/auth/pair",
    body,
  }).request;
}
