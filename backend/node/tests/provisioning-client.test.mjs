import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { verifyEvent } from "nostr-tools/pure";
import { provision } from "../../../scripts/vw-provision-client.mjs";
import { json, route, withFetchQueue } from "../../tests/harness.mjs";

const origin = "https://provision.example.invalid:8443";
const key = new Uint8Array(32).fill(21);
const credentials = {
  username: "synthetic@example.invalid",
  password: "SYNTHETIC-NOT-A-REAL-PASSWORD",
  spin: "654321",
};
const attemptId = "11111111-2222-4333-8444-555555555555";
const options = { origin, key, credentials };
const health = () => route("GET", origin + "/health", json({ status: "ok" }));
const empty = () =>
  route(
    "GET",
    origin + "/api/v1/account",
    json({ state: "unlinked", credentialsPresent: false }),
  );
const accepted = () =>
  route(
    "POST",
    origin + "/api/v1/account/credentials",
    json({ pending: { attemptId } }),
  );
const complete = {
  pending: null,
  connection: {
    state: "connected",
    lastFailure: null,
    vehicleAvailable: true,
    session: "usable",
  },
};

test("provisioning uses only health, account preflight and two signed exact-body account submissions", async () => {
  const signed = (path, payload) => (init) => {
    assert.equal(init.redirect, "error");
    const event = JSON.parse(
      Buffer.from(init.headers.authorization.slice(6), "base64").toString(),
    );
    assert.equal(verifyEvent(event), true);
    assert.deepEqual(JSON.parse(init.body), payload);
    assert.deepEqual(
      event.tags.find((t) => t[0] === "u"),
      ["u", origin + path],
    );
    assert.deepEqual(
      event.tags.find((t) => t[0] === "payload"),
      ["payload", createHash("sha256").update(init.body).digest("hex")],
    );
  };
  await withFetchQueue(
    [
      health(),
      empty(),
      route(
        "POST",
        origin + "/api/v1/account/credentials",
        json({ pending: { attemptId } }),
        signed("/api/v1/account/credentials", {
          username: credentials.username,
          password: credentials.password,
        }),
      ),
      route(
        "POST",
        origin + "/api/v1/account/connect",
        json(complete),
        signed("/api/v1/account/connect", {
          attemptId,
          spin: credentials.spin,
        }),
      ),
    ],
    async () => {
      assert.deepEqual(await provision(options), {
        connected: true,
        vehicleAvailable: true,
        sessionUsable: true,
      });
    },
  );
});

test("failed credentials stop without a connect or retry and do not expose response secrets", async () => {
  await withFetchQueue(
    [
      health(),
      empty(),
      route(
        "POST",
        origin + "/api/v1/account/credentials",
        json({ error: credentials.password }, 422),
      ),
    ],
    async () => {
      await assert.rejects(provision(options), (e) => {
        assert.match(e.message, /HTTP 422/);
        assert.ok(!e.message.includes(credentials.password));
        return true;
      });
    },
  );
});

test("failed connect has no reconnect or retry", async () => {
  await withFetchQueue(
    [
      health(),
      empty(),
      accepted(),
      route(
        "POST",
        origin + "/api/v1/account/connect",
        json({ error: credentials.spin }, 503),
      ),
    ],
    async () => {
      await assert.rejects(provision(options), /HTTP 503/);
    },
  );
});

test("existing account stops before credential submission", async () => {
  await withFetchQueue(
    [
      health(),
      route(
        "GET",
        origin + "/api/v1/account",
        json({ state: "pin_required", credentialsPresent: true }),
      ),
    ],
    async () => {
      await assert.rejects(provision(options), /Stored account state exists/);
    },
  );
});

test("missing pending attempt stops before PIN submission", async () => {
  await withFetchQueue(
    [
      health(),
      empty(),
      route(
        "POST",
        origin + "/api/v1/account/credentials",
        json({ pending: null }),
      ),
    ],
    async () => {
      await assert.rejects(provision(options), /pending attempt/);
    },
  );
});

test("best-effort initial status failure is reported as incomplete without retry", async () => {
  await withFetchQueue(
    [
      health(),
      empty(),
      accepted(),
      route(
        "POST",
        origin + "/api/v1/account/connect",
        json({
          ...complete,
          connection: {
            ...complete.connection,
            lastFailure: "status_read_failed",
          },
        }),
      ),
    ],
    async () => {
      await assert.rejects(provision(options), /passive status unavailable/);
    },
  );
});

test("invalid origin or credentials fail before any network request", async () => {
  await withFetchQueue([], async () => {
    for (const value of ["http://example.invalid", origin + "/", "not-a-url"])
      await assert.rejects(
        provision({ ...options, origin: value }),
        /Invalid HTTPS origin/,
      );
    await assert.rejects(
      provision({
        ...options,
        credentials: { ...credentials, spin: "invalid" },
      }),
      /Invalid credential input/,
    );
  });
});

test("transport failure is sanitized and is not retried", async () => {
  let calls = 0;
  await assert.rejects(
    provision({
      ...options,
      transport: () => {
        calls++;
        throw new Error(credentials.password);
      },
    }),
    (e) => {
      assert.ok(!e.message.includes(credentials.password));
      assert.match(e.message, /Transport failed/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("interactive launcher refuses piped credentials instead of falling back to echo", () => {
  const p = spawnSync(
    "python3",
    [
      fileURLToPath(
        new URL("../../../scripts/provision-vw.py", import.meta.url),
      ),
      "--origin",
      origin,
      "--device-key",
      "/not-used",
    ],
    { input: JSON.stringify(credentials), encoding: "utf8" },
  );
  assert.equal(p.status, 1);
  assert.match(p.stderr, /hidden interactive input is required/);
  assert.ok(!(p.stdout + p.stderr).includes(credentials.password));
});
