import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

const Response = globalThis.Response;

export const API = "https://b-h-s.spr.us00.p.con-veh.net";
export const IDP = "https://identity.na.vwgroup.io";
export const UUID = "synthetic-vehicle-uuid";
export const VIN = "TESTVIN0000000000";
export const ACCESS = "synthetic-access-token";
export const CARNET = "synthetic-carnet-token";
export const REFRESH = "synthetic-refresh-token";
export const SPIN = "0000";
export const ID_TOKEN = `synthetic.${Buffer.from(JSON.stringify({ sub: "synthetic-user-id" })).toString("base64url")}.signature`;

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function html(body, status = 200, headers = {}) {
  return new Response(body, { status, headers });
}

export function redirect(location, headers = {}) {
  return new Response(null, {
    status: 302,
    headers: { location, ...headers },
  });
}

export function route(method, url, response, inspect = () => undefined) {
  return { method, url, response, inspect };
}

/** Fail closed for both an extra request and a missing expected request. */
export async function withFetchQueue(steps, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const step = steps.shift();
    if (step === undefined)
      throw new Error(`Unexpected network request: ${method} ${url}`);
    assert.equal(method, step.method);
    if (typeof step.url === "function") step.url(url);
    else assert.equal(url, step.url);
    await step.inspect(init);
    calls.push({ method, url, init });
    return typeof step.response === "function"
      ? step.response(init)
      : step.response;
  };
  try {
    const result = await run(calls);
    assert.equal(
      steps.length,
      0,
      `Unconsumed mocked requests: ${steps.map((s) => s.url).join(", ")}`,
    );
    return result;
  } finally {
    globalThis.fetch = original;
  }
}

export function bearer(expected) {
  return (init) => {
    assert.equal(init.headers.authorization, `Bearer ${expected}`);
    assert.equal(init.headers["user-agent"], "MyVW/1.0 Android");
  };
}

export function bodyJson(expected) {
  return (init) => assert.deepEqual(JSON.parse(init.body), expected);
}

export function assertNoSyntheticSecrets(text) {
  for (const value of [ACCESS, CARNET, REFRESH, SPIN, ID_TOKEN]) {
    assert.equal(
      text.includes(value),
      false,
      `Log included fixture secret ${value}`,
    );
  }
}
