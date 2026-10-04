import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";

const require = createRequire(
  new URL("../backend/package.json", import.meta.url),
);
const { finalizeEvent } = require("nostr-tools/pure");
class ProvisionFailure extends Error {}

/** Single operator-requested flow. No reconnect, refresh, controls or retry loop. */
export async function provision({
  origin,
  key,
  credentials,
  transport = globalThis.fetch,
}) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new ProvisionFailure("Invalid HTTPS origin.");
  }
  if (parsed.protocol !== "https:" || parsed.origin !== origin)
    throw new ProvisionFailure("Invalid HTTPS origin.");
  if (
    key.length !== 32 ||
    typeof credentials.username !== "string" ||
    !credentials.username.length ||
    credentials.username.length > 320 ||
    typeof credentials.password !== "string" ||
    !credentials.password.length ||
    credentials.password.length > 4096 ||
    !/^\d{4,6}$/.test(credentials.spin)
  )
    throw new ProvisionFailure("Invalid credential input; no request sent.");
  async function send(path, method = "GET", value) {
    const body = value === undefined ? undefined : JSON.stringify(value);
    const tags = [
      ["u", origin + path],
      ["method", method],
      ["nonce", randomBytes(18).toString("base64url")],
    ];
    if (body !== undefined)
      tags.push(["payload", createHash("sha256").update(body).digest("hex")]);
    const event = finalizeEvent(
      {
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: "",
      },
      key,
    );
    let response;
    try {
      response = await transport(origin + path, {
        method,
        headers: {
          authorization:
            "Nostr " + Buffer.from(JSON.stringify(event)).toString("base64"),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body }),
        redirect: "error",
        signal: globalThis.AbortSignal.timeout(120_000),
      });
    } catch {
      throw new ProvisionFailure(
        "Transport failed or timed out. Stop; inspect server state before retrying.",
      );
    }
    if (!response.ok)
      throw new ProvisionFailure(
        `Account step failed (HTTP ${String(response.status)}). Stop; do not repeat authentication.`,
      );
    try {
      return await response.json();
    } catch {
      throw new ProvisionFailure(
        "Invalid server response. Stop; do not repeat authentication.",
      );
    }
  }
  await send("/health");
  const before = await send("/api/v1/account");
  if (before.credentialsPresent !== false || before.state !== "unlinked")
    throw new ProvisionFailure(
      "Stored account state exists. Stop for review instead of reauthenticating.",
    );
  const first = await send("/api/v1/account/credentials", "POST", {
    username: credentials.username,
    password: credentials.password,
  });
  if (!first.pending || !/^[0-9a-f-]{36}$/.test(first.pending.attemptId))
    throw new ProvisionFailure(
      "Credentials step did not return a valid pending attempt. Stop for review.",
    );
  const second = await send("/api/v1/account/connect", "POST", {
    attemptId: first.pending.attemptId,
    spin: credentials.spin,
  });
  if (
    second.connection?.state !== "connected" ||
    second.connection?.lastFailure !== null ||
    second.pending !== null
  )
    throw new ProvisionFailure(
      "Account flow incomplete or initial passive status unavailable. Stop for sanitized diagnostics; credentials may already be stored.",
    );
  return {
    connected: true,
    vehicleAvailable: second.connection.vehicleAvailable === true,
    sessionUsable: second.connection.session === "usable",
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let key;
  try {
    const [origin, keyPath] = process.argv.slice(2);
    if (!origin || !keyPath || process.argv.length !== 4)
      throw new ProvisionFailure("Use the interactive Python launcher.");
    const info = statSync(keyPath);
    if (
      !info.isFile() ||
      (info.mode & 0o077) !== 0 ||
      info.uid !== process.getuid()
    )
      throw new ProvisionFailure(
        "Client key must be an owned private file (0600).",
      );
    key = new Uint8Array(readFileSync(keyPath));
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (input.length > 32_768)
        throw new ProvisionFailure("Input exceeds provisioning limit.");
    }
    const result = await provision({
      origin,
      key,
      credentials: JSON.parse(input),
    });
    input = "";
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write(
      (error instanceof ProvisionFailure
        ? error.message
        : "Provisioning failed. Stop for sanitized diagnostics; do not retry automatically.") +
        "\n",
    );
    process.exitCode = 1;
  } finally {
    key?.fill(0);
  }
}
