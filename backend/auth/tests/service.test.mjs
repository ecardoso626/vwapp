import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { temporaryStore } from "../../storage/tests/helper.mjs";
import { DeviceRepository } from "../devices.ts";
import { RequestLimiter } from "../limits.ts";
import { classifyEndpoint, DeviceAuthService } from "../service.ts";
import {
  keyB,
  nowMs,
  origin,
  pairingRequest,
  pubkeyA,
  signedRequest,
} from "./helper.mjs";

function service(t) {
  const { store } = temporaryStore(t);
  const devices = new DeviceRepository(store);
  let time = nowMs;
  const auth = new DeviceAuthService(devices, origin, () => time);
  return { devices, auth, setTime: (value) => (time = value) };
}

test("endpoint classes reserve public health and pairing; unknown is control", () => {
  assert.equal(classifyEndpoint("GET", "/health"), "public");
  assert.equal(classifyEndpoint("POST", "/auth/pair"), "pairing");
  assert.equal(classifyEndpoint("POST", "/rpc/vehicle/activity"), "read");
  assert.equal(classifyEndpoint("POST", "/rpc/vehicle/command"), "control");
  assert.equal(classifyEndpoint("POST", "/rpc/vehicle/refresh"), "control");
  assert.equal(classifyEndpoint("POST", "/rpc/unknown"), "control");
});

test("candidate key is unauthorized until signed single-use pairing succeeds", (t) => {
  const { auth, devices } = service(t);
  const read = signedRequest().request;
  assert.throws(
    () => auth.authorize(read, "read"),
    (error) => error.code === "unknown_device",
  );
  const token = devices.issuePairing(nowMs);
  const paired = auth.pair(pairingRequest(token));
  assert.equal(paired.pubkey, pubkeyA);
  assert.equal(auth.authorize(read, "read").pubkey, pubkeyA);
  assert.throws(() => auth.pair(pairingRequest(token)));
});

test("pairing requires proof of the presented public key and intact body", (t) => {
  const { auth, devices } = service(t);
  const token = devices.issuePairing(nowMs);
  const request = pairingRequest(token);
  const changed = Buffer.from(
    request.body.toString().replace(pubkeyA, "0".repeat(64)),
  );
  assert.throws(() => auth.pair({ ...request, body: changed }));
  const wrongKey = pairingRequest(token, "Phone", keyB);
  assert.throws(() => auth.pair({ ...wrongKey, body: request.body }));
  assert.equal(devices.getByPubkey(pubkeyA), null);
});

test("authorized requests replay once and revoked keys fail even with fresh signatures", (t) => {
  const { auth, devices } = service(t);
  const device = auth.pair(pairingRequest(devices.issuePairing(nowMs)));
  const first = signedRequest().request;
  assert.equal(auth.authorize(first, "read").id, device.id);
  assert.throws(
    () => auth.authorize(first, "read"),
    (error) => error.code === "replay",
  );
  devices.revoke(device.id, nowMs + 1);
  assert.throws(
    () => auth.authorize(signedRequest().request, "read"),
    (error) => error.code === "revoked_device",
  );
});

test("read and control limits have distinct budgets and reset with fake time", (t) => {
  const { auth, devices, setTime } = service(t);
  auth.pair(pairingRequest(devices.issuePairing(nowMs)));
  for (let i = 0; i < 10; i++)
    auth.authorize(signedRequest().request, "control");
  assert.throws(
    () => auth.authorize(signedRequest().request, "control"),
    (error) => error.code === "rate_limited",
  );
  assert.doesNotThrow(() => auth.authorize(signedRequest().request, "read"));
  setTime(nowMs + 60_000);
  assert.doesNotThrow(() =>
    auth.authorize(
      signedRequest({ createdAt: Math.floor((nowMs + 60_000) / 1_000) })
        .request,
      "control",
    ),
  );
});

test("pairing and ingress limits use source context, not an unverified pubkey", (t) => {
  const { auth } = service(t);
  for (let i = 0; i < 5; i++) auth.begin("127.0.0.1", "pairing");
  assert.throws(
    () => auth.begin("127.0.0.1", "pairing"),
    (error) => error.code === "rate_limited",
  );
  assert.doesNotThrow(() => auth.begin("127.0.0.2", "pairing"));
});

test("fixed-window limiter fails at capacity and resumes after expiry", () => {
  const limits = new RequestLimiter(1);
  limits.take("read", "one", 1, 1_000, nowMs);
  assert.throws(
    () => limits.take("read", "one", 1, 1_000, nowMs),
    (error) => error.code === "rate_limited",
  );
  assert.throws(() => limits.take("read", "two", 1, 1_000, nowMs));
  assert.doesNotThrow(() =>
    limits.take("read", "two", 1, 1_000, nowMs + 1_000),
  );
});
