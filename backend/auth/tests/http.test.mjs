import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { test } from "node:test";
import { temporaryStore } from "../../storage/tests/helper.mjs";
import { DeviceRepository } from "../devices.ts";
import { AuthFailure } from "../errors.ts";
import { authenticateHttpRequest, authHttpError } from "../http.ts";
import { DeviceAuthService } from "../service.ts";
import { nowMs, origin, pairingRequest, signedRequest } from "./helper.mjs";

function fixture(t) {
  const { store } = temporaryStore(t);
  const devices = new DeviceRepository(store);
  const auth = new DeviceAuthService(devices, origin, () => nowMs);
  return { devices, auth };
}

function incoming(signed, { duplicateAuth = false, body = signed.body } = {}) {
  const request = Readable.from(body.length === 0 ? [] : [body]);
  request.method = signed.method;
  request.url = signed.rawTarget;
  request.headers =
    signed.authorization === undefined
      ? {}
      : { authorization: signed.authorization };
  request.rawHeaders =
    signed.authorization === undefined
      ? []
      : [
          "Authorization",
          signed.authorization,
          ...(duplicateAuth ? ["authorization", signed.authorization] : []),
        ];
  request.socket = { remoteAddress: "127.0.0.1" };
  return request;
}

test("health is public; other Node ingress requires NIP authorization", async (t) => {
  const { auth } = fixture(t);
  const health = await authenticateHttpRequest(
    incoming({ method: "GET", rawTarget: "/health", body: Buffer.alloc(0) }),
    auth,
    origin,
  );
  assert.deepEqual(health, { kind: "public" });
  await assert.rejects(
    authenticateHttpRequest(
      incoming({
        method: "GET",
        rawTarget: "/api/v1/owner",
        body: Buffer.alloc(0),
      }),
      auth,
      origin,
    ),
  );
});

test("signed pairing and protected Node API pass; replay and duplicate headers fail", async (t) => {
  const { auth, devices } = fixture(t);
  const token = devices.issuePairing(nowMs);
  const paired = await authenticateHttpRequest(
    incoming(pairingRequest(token)),
    auth,
    origin,
  );
  assert.equal(paired.kind, "paired");
  const request = signedRequest({
    method: "POST",
    target: "/api/v1/messages",
    body: Buffer.from('{"json":{"lat":41}}'),
  }).request;
  const accepted = await authenticateHttpRequest(
    incoming(request),
    auth,
    origin,
  );
  assert.equal(accepted.kind, "authorized");
  assert.equal(accepted.signedUrl, `${origin}/api/v1/messages`);
  assert.deepEqual(accepted.body, request.body);
  await assert.rejects(
    authenticateHttpRequest(incoming(request), auth, origin),
    (error) => error.code === "replay",
  );
  await assert.rejects(
    authenticateHttpRequest(
      incoming(signedRequest().request, { duplicateAuth: true }),
      auth,
      origin,
    ),
    (error) => error.code === "malformed",
  );
});

test("changed request bytes and oversized bodies never pass to application logic", async (t) => {
  const { auth, devices } = fixture(t);
  await authenticateHttpRequest(
    incoming(pairingRequest(devices.issuePairing(nowMs))),
    auth,
    origin,
  );
  const signed = signedRequest({
    method: "POST",
    target: "/api/v1/vehicles/synthetic/commands",
    body: Buffer.from("synthetic-body"),
  }).request;
  let called = false;
  const gate = async (incomingRequest) => {
    await authenticateHttpRequest(incomingRequest, auth, origin);
    called = true;
  };
  await assert.rejects(
    gate(incoming(signed, { body: Buffer.from("altered") })),
  );
  assert.equal(called, false);
  const tooLarge = Buffer.alloc(64 * 1024 + 1);
  await assert.rejects(
    gate(incoming(signed, { body: tooLarge })),
    (error) => authHttpError(error).status === 413,
  );
  assert.equal(called, false);
});

test("external auth errors do not reveal internal verification reason", () => {
  assert.deepEqual(authHttpError(new AuthFailure("invalid_signature")), {
    status: 401,
    body: '{"error":"unauthorized"}',
  });
  assert.deepEqual(authHttpError(new Error("synthetic database failure")), {
    status: 500,
    body: '{"error":"internal_error"}',
  });
});
