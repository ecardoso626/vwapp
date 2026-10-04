import { finalizeEvent, type Event } from "nostr-tools/pure";

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");

function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    out += ALPHABET[a >> 2] ?? "";
    out += ALPHABET[((a & 3) << 4) | (b >> 4)] ?? "";
    out +=
      i + 1 < bytes.length ? (ALPHABET[((b & 15) << 2) | (c >> 6)] ?? "") : "=";
    out += i + 2 < bytes.length ? (ALPHABET[c & 63] ?? "") : "=";
  }
  return out;
}

export interface SigningMaterial {
  secretKey: Uint8Array;
  randomBytes(count: number): Promise<Uint8Array>;
  sha256(bytes: Uint8Array): Promise<Uint8Array>;
  nowMs(): number;
}

/** Signs the exact URL and serialized body that fetch will send. */
export async function signNip98(input: {
  url: string;
  method: string;
  body?: string;
  material: SigningMaterial;
}): Promise<{ authorization: string; event: Event }> {
  const { url, method, body, material } = input;
  const parsed = new URL(url);
  if (parsed.href !== url || parsed.protocol !== "https:" || parsed.hash !== "")
    throw new Error("NIP-98 requires an exact external HTTPS URL");
  const bodyCapable = method !== "GET" && method !== "HEAD";
  if (!bodyCapable && body !== undefined)
    throw new Error("GET and HEAD requests cannot carry a body");
  const nonceBytes = await material.randomBytes(16);
  if (nonceBytes.length !== 16) throw new Error("Device entropy unavailable");
  const nonce = base64(nonceBytes)
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const tags = [
    ["u", url],
    ["method", method],
    ["nonce", nonce],
  ];
  if (bodyCapable) {
    const digest = await material.sha256(new TextEncoder().encode(body ?? ""));
    if (digest.length !== 32) throw new Error("SHA-256 unavailable");
    tags.push(["payload", toHex(digest)]);
  }
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(material.nowMs() / 1000),
      content: "",
      tags,
    },
    material.secretKey,
  );
  const authorization = `Nostr ${base64(new TextEncoder().encode(JSON.stringify(event)))}`;
  return { authorization, event };
}
