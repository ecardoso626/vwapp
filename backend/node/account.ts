import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import {
  accountConnectSchema,
  accountCredentialsSchema,
  accountEmptySchema,
  type AccountAction,
  type AccountAttempt,
  type AccountConnection,
} from "@vwapp/contract/account";
import type { AuthorizedDevice } from "../auth/devices";
import { establishSession } from "../src/account-session";
import { seal } from "../src/crypto";
import type { AppEnv } from "../src/env";
import { readStatus } from "../src/status";
import { VwAuthError, VwCommandError } from "../src/vw/client";
import type { SqliteStorage } from "../storage/database";
import type { SecretRepository } from "../storage/secrets";
import type { PassiveResponse } from "./passive";
import { type NodeSqliteStore } from "./sqlite-store";

interface ConnectionRow {
  account_id: string | null;
  state: AccountConnection["state"];
  verified_at: number | null;
  failure_code: AccountConnection["lastFailure"];
  pending_attempt_id: string | null;
  pending_account_id: string | null;
  pending_device_id: string | null;
  pending_expires_at: number | null;
}
const failure = (status: number, error: string): PassiveResponse => ({
  status,
  body: { error },
});
const PENDING_MS = 10 * 60_000;

/** One-owner account boundary: exact NIP-98 bytes are authenticated before entry. */
export class NodeAccountApi {
  private busy = false;
  private readonly storage: SqliteStorage;
  private readonly db: NodeSqliteStore;
  private readonly secrets: SecretRepository;
  private readonly env: AppEnv;
  constructor(
    storage: SqliteStorage,
    db: NodeSqliteStore,
    secrets: SecretRepository,
    env: AppEnv,
  ) {
    this.storage = storage;
    this.db = db;
    this.secrets = secrets;
    this.env = env;
  }

  private record(): ConnectionRow | undefined {
    return this.storage.db
      .prepare("SELECT * FROM owner_vw_connection WHERE owner_id = 'owner'")
      .get() as ConnectionRow | undefined;
  }
  private linkedId(): string | null {
    return (
      (
        this.storage.db
          .prepare(
            "SELECT account_id FROM owner_account_link WHERE owner_id = 'owner'",
          )
          .get() as { account_id: string } | undefined
      )?.account_id ?? null
    );
  }
  private userKey(accountId: string): string | null {
    return (
      (
        this.storage.db
          .prepare(
            "SELECT user_key FROM vw_account_sessions WHERE account_id = ?",
          )
          .get(accountId) as { user_key: string } | undefined
      )?.user_key ?? null
    );
  }
  private accountId(userKey: string): string {
    const row = this.storage.db
      .prepare("SELECT account_id FROM vw_account_sessions WHERE user_key = ?")
      .get(userKey) as { account_id: string } | undefined;
    if (row === undefined) throw new Error("Missing local account");
    return row.account_id;
  }
  private credentials(accountId: string) {
    const username = this.secrets.get({
      accountId,
      purpose: "vw_username",
    })?.value;
    const password = this.secrets.get({
      accountId,
      purpose: "vw_password",
    })?.value;
    if (username === undefined || password === undefined) return null;
    const spin = this.secrets.get({ accountId, purpose: "vw_spin" })?.value;
    return { username, password, ...(spin === undefined ? {} : { spin }) };
  }
  private ensureRecord() {
    this.storage.db
      .prepare(
        "INSERT OR IGNORE INTO owner_vw_connection(owner_id, account_id, state) VALUES ('owner', ?, 'disconnected')",
      )
      .run(this.linkedId());
  }

  /** Cache-only status. 'usable' means last verified and not locally expired. */
  connection(): AccountConnection {
    const record = this.record();
    const linkedId = this.linkedId();
    const pendingPin =
      record?.pending_expires_at != null &&
      record.pending_expires_at >= Date.now();
    const accountId =
      linkedId ??
      (pendingPin ? record.pending_account_id : record?.account_id) ??
      null;
    const purposes =
      accountId === null
        ? []
        : (
            this.storage.db
              .prepare(
                "SELECT purpose FROM account_secrets WHERE account_id = ? AND scope = ''",
              )
              .all(accountId) as unknown as { purpose: string }[]
          ).map((row) => row.purpose);
    const credentialsPresent =
      purposes.includes("vw_username") && purposes.includes("vw_password");
    const spinPresent = purposes.includes("vw_spin");
    const expiresAt =
      accountId === null
        ? undefined
        : (
            this.storage.db
              .prepare(
                "SELECT token_expires_at FROM vw_account_sessions WHERE account_id = ?",
              )
              .get(accountId) as { token_expires_at: number } | undefined
          )?.token_expires_at;
    const verifiedAt =
      record?.account_id === accountId ||
      record?.pending_account_id === accountId
        ? (record.verified_at ?? null)
        : null;
    const session: AccountConnection["session"] =
      !purposes.includes("access_token") || expiresAt === undefined
        ? "missing"
        : record?.state === "reauthentication_required" ||
            record?.state === "session_unusable"
          ? "unusable"
          : expiresAt <= Date.now() + 60_000
            ? "expired"
            : verifiedAt == null
              ? "unverified"
              : "usable";
    let state: AccountConnection["state"] =
      linkedId !== null
        ? record?.account_id === linkedId
          ? record.state
          : "connected"
        : pendingPin
          ? "pin_required"
          : (record?.state ?? "unlinked");
    if (accountId !== null && state !== "disconnected") {
      if (!credentialsPresent) state = "credentials_missing";
      else if (!spinPresent || (pendingPin && linkedId === null))
        state = "pin_required";
      else if (state === "connected" && session !== "usable")
        state = "session_unusable";
    }
    const vehicleAvailable =
      linkedId !== null &&
      this.storage.db
        .prepare("SELECT 1 FROM vehicles WHERE account_id = ? LIMIT 1")
        .get(linkedId) !== undefined;
    return {
      state,
      accountId,
      linked: linkedId !== null,
      credentialsPresent,
      spinPresent,
      session,
      verifiedAt: verifiedAt ?? null,
      vehicleAvailable,
      reconnectAvailable: credentialsPresent && accountId !== null,
      pendingPin,
      lastFailure: record?.failure_code ?? null,
    };
  }

  private pending(accountId: string, device: AuthorizedDevice): AccountAttempt {
    const attempt = {
      attemptId: randomUUID(),
      expiresAt: Date.now() + PENDING_MS,
    };
    this.ensureRecord();
    if (this.linkedId() === null)
      this.storage.db
        .prepare(
          "UPDATE owner_vw_connection SET account_id = ?, state = 'pin_required', verified_at = NULL, failure_code = NULL WHERE owner_id = 'owner'",
        )
        .run(accountId);
    this.storage.db
      .prepare(
        "UPDATE owner_vw_connection SET pending_attempt_id = ?, pending_account_id = ?, pending_device_id = ?, pending_expires_at = ? WHERE owner_id = 'owner'",
      )
      .run(attempt.attemptId, accountId, device.id, attempt.expiresAt);
    return attempt;
  }
  private link(accountId: string) {
    this.storage.transaction(() => {
      this.ensureRecord();
      this.storage.db
        .prepare(
          "INSERT INTO owner_account_link(owner_id, account_id) VALUES ('owner', ?) ON CONFLICT(owner_id) DO UPDATE SET account_id = excluded.account_id",
        )
        .run(accountId);
      this.storage.db
        .prepare(
          "UPDATE owner_vw_connection SET account_id = ?, state = 'connected', verified_at = ?, failure_code = NULL, pending_attempt_id = NULL, pending_account_id = NULL, pending_device_id = NULL, pending_expires_at = NULL WHERE owner_id = 'owner'",
        )
        .run(accountId, Date.now());
    });
  }
  private markFailure(
    state: "reauthentication_required" | "session_unusable",
    reconnect: boolean,
  ) {
    this.ensureRecord();
    this.storage.db
      .prepare(
        "UPDATE owner_vw_connection SET state = CASE WHEN ? THEN ? ELSE state END, failure_code = ? WHERE owner_id = 'owner'",
      )
      .run(
        reconnect || this.linkedId() === null ? 1 : 0,
        state,
        state === "reauthentication_required"
          ? "authentication_failed"
          : "service_unavailable",
      );
  }

  private async complete(
    accountId: string,
    spin: string,
    device: AuthorizedDevice,
  ): Promise<AccountAction> {
    const creds = this.credentials(accountId);
    if (creds === null) throw new Error("Missing stored credentials");
    const session = await establishSession(
      { db: this.db, env: this.env },
      creds.username,
      creds.password,
      true,
    );
    const vehicles = await this.db.saveAccountSession(
      session.userKey,
      await seal(this.env.CREDS_ENC_KEY, JSON.stringify({ ...creds, spin })),
      session.tokens,
      session.vehicles,
    );
    const savedId = this.accountId(session.userKey);
    this.link(savedId);
    let pending: AccountAttempt | null = null;
    try {
      const account = await this.db.getAccountByUserKey(session.userKey);
      if (account !== null)
        for (const vehicle of vehicles)
          await this.db.saveSnapshot(
            vehicle.id,
            await readStatus(this.db, this.env, account, vehicle, spin, {
              safeErrors: true,
            }),
          );
    } catch (error) {
      // Initial telemetry remains best effort, as upstream. Never log a raw VW
      // response/error that might reflect credentials or token material.
      console.error("[node] initial account status unavailable");
      this.storage.db
        .prepare(
          "UPDATE owner_vw_connection SET failure_code = 'status_read_failed' WHERE owner_id = 'owner'",
        )
        .run();
      if (error instanceof VwCommandError) {
        this.storage.db
          .prepare(
            "UPDATE owner_vw_connection SET state = 'pin_required' WHERE owner_id = 'owner'",
          )
          .run();
        pending = this.pending(savedId, device);
      }
    }
    return { connection: this.connection(), pending };
  }

  async handle(
    method: string,
    target: string,
    body: Buffer,
    device: AuthorizedDevice,
  ): Promise<PassiveResponse | null> {
    const url = new URL(target, "https://local.invalid");
    const path = url.pathname;
    if (path !== "/api/v1/account" && !path.startsWith("/api/v1/account/"))
      return null;
    if (url.search !== "") return failure(400, "invalid_request");
    if (method === "GET" && path === "/api/v1/account")
      return { status: 200, body: this.connection() };
    if (
      method !== "POST" ||
      !["credentials", "connect", "reconnect", "disconnect"].some(
        (name) => path === `/api/v1/account/${name}`,
      )
    )
      return failure(404, "not_found");
    let input: unknown;
    try {
      input = JSON.parse(body.toString("utf8")) as unknown;
    } catch {
      return failure(400, "invalid_request");
    }
    const schema = path.endsWith("/credentials")
      ? accountCredentialsSchema
      : path.endsWith("/connect")
        ? accountConnectSchema
        : accountEmptySchema;
    if (!schema.safeParse(input).success)
      return failure(400, "invalid_request");
    if (this.busy) return failure(409, "account_busy");
    this.busy = true;
    try {
      if (path.endsWith("/disconnect")) {
        this.storage.transaction(() => {
          const remembered =
            this.linkedId() ?? this.record()?.account_id ?? null;
          this.ensureRecord();
          this.storage.db
            .prepare("DELETE FROM owner_account_link WHERE owner_id = 'owner'")
            .run();
          this.storage.db
            .prepare(
              "UPDATE owner_vw_connection SET account_id = ?, state = 'disconnected', failure_code = NULL, pending_attempt_id = NULL, pending_account_id = NULL, pending_device_id = NULL, pending_expires_at = NULL WHERE owner_id = 'owner'",
            )
            .run(remembered);
        });
        return {
          status: 200,
          body: { connection: this.connection(), pending: null },
        };
      }
      if (path.endsWith("/credentials")) {
        const creds = accountCredentialsSchema.parse(input);
        const session = await establishSession(
          { db: this.db, env: this.env },
          creds.username,
          creds.password,
          true,
        );
        const existing = this.storage.db
          .prepare(
            "SELECT account_id FROM vw_account_sessions WHERE user_key = ?",
          )
          .get(session.userKey) as { account_id: string } | undefined;
        const priorSpin =
          existing === undefined
            ? undefined
            : this.credentials(existing.account_id)?.spin;
        await this.db.saveAccountSession(
          session.userKey,
          await seal(
            this.env.CREDS_ENC_KEY,
            JSON.stringify({
              ...creds,
              ...(priorSpin === undefined ? {} : { spin: priorSpin }),
            }),
          ),
          session.tokens,
          session.vehicles,
        );
        const pending = this.pending(this.accountId(session.userKey), device);
        return {
          status: 200,
          body: { connection: this.connection(), pending },
        };
      }
      if (path.endsWith("/connect")) {
        const data = accountConnectSchema.parse(input);
        const record = this.record();
        if (
          record?.pending_attempt_id !== data.attemptId ||
          record.pending_account_id === null ||
          record.pending_device_id !== device.id ||
          record.pending_expires_at === null ||
          record.pending_expires_at < Date.now()
        )
          return failure(409, "account_attempt_expired");
        return {
          status: 200,
          body: await this.complete(
            record.pending_account_id,
            data.spin,
            device,
          ),
        };
      }
      const connection = this.connection();
      const accountId = this.linkedId() ?? this.record()?.account_id ?? null;
      if (accountId === null)
        return failure(409, "account_credentials_missing");
      const creds = this.credentials(accountId);
      if (creds === null || this.userKey(accountId) === null)
        return failure(409, "account_credentials_missing");
      if (creds.spin === undefined || connection.state === "pin_required") {
        const pending = this.pending(accountId, device);
        return {
          status: 200,
          body: { connection: this.connection(), pending },
        };
      }
      return {
        status: 200,
        body: await this.complete(accountId, creds.spin, device),
      };
    } catch (error) {
      const rejected =
        error instanceof VwAuthError ||
        (error instanceof ORPCError && error.code === "UNAUTHORIZED");
      this.markFailure(
        rejected ? "reauthentication_required" : "session_unusable",
        path.endsWith("/reconnect") ||
          (path.endsWith("/connect") &&
            this.record()?.pending_account_id === this.linkedId()),
      );
      console.error(
        rejected
          ? "[node] account authentication failed"
          : "[node] account connection unavailable",
      );
      return failure(
        rejected ? 422 : 503,
        rejected
          ? "account_authentication_failed"
          : "account_service_unavailable",
      );
    } finally {
      this.busy = false;
    }
  }
}
