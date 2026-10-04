import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { finalizeEvent } from "nostr-tools/pure";
import {
  MAX_FUTURE_SECONDS,
  MAX_PAST_SECONDS,
  signedRequestUrl,
  validatePublicOrigin,
  verifyNip98,
} from "../nip98.ts";
import { keyA, nowMs, origin, signedRequest } from "./helper.mjs";

function verify(request, time = nowMs) {
  return verifyNip98({ ...request, publicOrigin: origin, nowMs: time });
}

test("valid signed GET and POST bind exact URL, method and raw body", () => {
  const get = signedRequest({ target: "/api/v1/owner?x=%2F&x=2" });
  assert.equal(verify(get.request).id, get.event.id);
  const body = Buffer.from('{"message":"café"}');
  const post = signedRequest({
    method: "POST",
    target: "/api/v1/vehicles/synthetic/commands?unit=F",
    body,
  });
  assert.equal(verify(post.request).pubkey, post.event.pubkey);
  assert.deepEqual(
    post.event.tags.find((tag) => tag[0] === "payload"),
    ["payload", createHash("sha256").update(body).digest("hex")],
  );
});

test("missing or malformed authorization and event fields fail", () => {
  const { request, event } = signedRequest();
  assert.throws(() => verify({ ...request, authorization: undefined }));
  assert.throws(() => verify({ ...request, authorization: "Bearer anything" }));
  assert.throws(() => verify({ ...request, authorization: "Nostr abc" }));
  for (const replacement of [
    { ...event, kind: 1 },
    { ...event, content: "not empty" },
    { ...event, tags: event.tags.filter((tag) => tag[0] !== "u") },
    { ...event, tags: [...event.tags, ["u", origin + "/api/v1/owner"]] },
    { ...event, tags: [...event.tags, ["method", "GET", "extra"]] },
  ]) {
    assert.throws(() =>
      verify({
        ...request,
        authorization: `Nostr ${Buffer.from(JSON.stringify(replacement)).toString("base64")}`,
      }),
    );
  }
});

test("invalid signature or event ID fails", () => {
  const { request, event } = signedRequest();
  const altered = { ...event, sig: "0".repeat(128) };
  assert.throws(
    () =>
      verify({
        ...request,
        authorization: `Nostr ${Buffer.from(JSON.stringify(altered)).toString("base64")}`,
      }),
    (error) => error.code === "invalid_signature",
  );
});

test("changed URL, query encoding, method or body fails", () => {
  const body = Buffer.from("synthetic-body");
  const { request } = signedRequest({
    method: "POST",
    target: "/api/v1/vehicles/synthetic/commands?x=%2F",
    body,
  });
  for (const changed of [
    { rawTarget: "/api/v1/vehicles/synthetic/commands?x=/" },
    { rawTarget: "/api/v1/vehicles/synthetic/commands?x=%2f" },
    { method: "PUT" },
    { body: Buffer.from("synthetic-bodY") },
  ]) {
    assert.throws(() => verify({ ...request, ...changed }));
  }
});

test("missing, duplicated or mismatched body digest fails", () => {
  const body = Buffer.from("synthetic-body");
  const base = signedRequest({ method: "POST", body });
  const variants = [
    base.event.tags.filter((tag) => tag[0] !== "payload"),
    [...base.event.tags, ["payload", "0".repeat(64)]],
    base.event.tags.map((tag) =>
      tag[0] === "payload" ? ["payload", "0".repeat(64)] : tag,
    ),
  ];
  for (const tags of variants) {
    const signed = finalizeEvent(
      { kind: 27235, content: "", created_at: Math.floor(nowMs / 1_000), tags },
      keyA,
    );
    assert.throws(() =>
      verify({
        ...base.request,
        authorization: `Nostr ${Buffer.from(JSON.stringify(signed)).toString("base64")}`,
      }),
    );
  }
});

test("timestamp policy accepts exact bounds and rejects one second outside", () => {
  for (const offset of [-MAX_PAST_SECONDS, 0, MAX_FUTURE_SECONDS]) {
    assert.doesNotThrow(() =>
      verify(
        signedRequest({
          createdAt: Math.floor(nowMs / 1_000) + offset,
        }).request,
      ),
    );
  }
  for (const offset of [-MAX_PAST_SECONDS - 1, MAX_FUTURE_SECONDS + 1]) {
    assert.throws(
      () =>
        verify(
          signedRequest({
            createdAt: Math.floor(nowMs / 1_000) + offset,
          }).request,
        ),
      (error) => error.code === "stale",
    );
  }
});

test("origin and raw target reject proxy or normalization ambiguity", () => {
  assert.equal(validatePublicOrigin(origin), origin);
  assert.throws(() => validatePublicOrigin("http://buzzkey.test"));
  assert.throws(() => validatePublicOrigin("https://buzzkey.test/path"));
  assert.throws(() => validatePublicOrigin("https://buzzkey.test:443"));
  assert.equal(
    signedRequestUrl(origin, "/api/v1/owner?a=%2F&b=2"),
    `${origin}/api/v1/owner?a=%2F&b=2`,
  );
  for (const target of [
    "https://evil.test/api/v1/owner",
    "//evil.test/api/v1/owner",
    "/rpc/../auth/me",
    "/api/v1/owner#fragment",
    "/api/v1/owner?bad=%ZZ",
    "/rpc\\auth/me",
  ]) {
    assert.throws(() => signedRequestUrl(origin, target));
  }
});
