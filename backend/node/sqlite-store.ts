/* eslint-disable @typescript-eslint/require-await -- SQLite writes are synchronous behind the shared async persistence contract. */
import { randomUUID } from "node:crypto";
import type { StatusDTO, VehicleDTO } from "@vwapp/contract";
import type {
  CarnetToken,
  ClimateSession,
  SqliteApplicationStore,
  StoredAccount,
  StoredUser,
  StoredVehicle,
} from "../src/application-store";
import { seal, unseal, type Sealed } from "../src/crypto";
import { mapVehicleStatus } from "../src/vw/adapter";
import type { InboxMessage, VwTokens } from "../src/vw/client";
import type { SqliteStorage } from "../storage/database";
import { VehicleRepository } from "../storage/repositories";
import { SecretRepository, type SecretPurpose } from "../storage/secrets";

export const OWNER_ID = "owner";
interface AccountRow {
  id: string;
  token_expires_at: number;
}
interface VehicleRow {
  id: string;
  vin: string;
  reference: string;
  display_name: string | null;
  model: string | null;
}
interface ClimateRow {
  id: string;
  temp_f: number;
  expires_at: number;
  started_at: number;
  state: string;
  last_start_at: number | null;
  remaining_min: number | null;
  paused_at: number | null;
}
interface MessageRow {
  id: string;
  message_id: string;
  title: string;
  body: string | null;
  at: number | null;
  read: number;
  read_override: number | null;
  deleted_at: number | null;
  created_at: number;
}

const storedVehicle = (row: VehicleRow): StoredVehicle => ({
  id: row.id,
  vin: row.vin,
  uuid: row.reference,
  nickname: row.display_name,
  model: row.model,
});
const climateSession = (row: ClimateRow): ClimateSession => ({
  id: row.id,
  tempF: row.temp_f,
  expiresAt: row.expires_at,
  startedAt: row.started_at,
  state: row.state,
  lastStartAt: row.last_start_at,
  remainingMin: row.remaining_min,
  pausedAt: row.paused_at,
});

/** Exact legacy application semantics over encrypted SQLite records. */
export class NodeSqliteStore implements SqliteApplicationStore {
  readonly kind = "sqlite" as const;
  private readonly storage: SqliteStorage;
  private readonly secrets: SecretRepository;
  private readonly credentialKey: string;
  private readonly vehicles: VehicleRepository;

  constructor(
    storage: SqliteStorage,
    secrets: SecretRepository,
    credentialKey: string,
  ) {
    this.storage = storage;
    this.secrets = secrets;
    this.credentialKey = credentialKey;
    this.vehicles = new VehicleRepository(storage);
  }

  private secret(
    accountId: string,
    purpose: SecretPurpose,
    scope?: string,
  ): string | null {
    return (
      this.secrets.get({
        accountId,
        purpose,
        ...(scope === undefined ? {} : { scope }),
      })?.value ?? null
    );
  }

  private async account(row: AccountRow): Promise<StoredAccount> {
    const username = this.secret(row.id, "vw_username");
    const password = this.secret(row.id, "vw_password");
    const accessToken = this.secret(row.id, "access_token");
    if (username === null || password === null || accessToken === null)
      throw new Error("Stored VW account is incomplete");
    const spin = this.secret(row.id, "vw_spin");
    const sealed = await seal(
      this.credentialKey,
      JSON.stringify({
        username,
        password,
        ...(spin === null ? {} : { spin }),
      }),
    );
    const carnetRows = this.storage.db
      .prepare(
        "SELECT scope FROM account_secrets WHERE account_id = ? AND purpose = 'carnet_token'",
      )
      .all(row.id) as unknown as { scope: string }[];
    const carnetTokens: Record<string, CarnetToken> = {};
    for (const { scope } of carnetRows) {
      const entry = this.secrets.get({
        accountId: row.id,
        purpose: "carnet_token",
        scope,
      });
      if (entry !== null && entry.expiresAt !== null)
        carnetTokens[scope] = {
          token: entry.value,
          expiresAt: entry.expiresAt,
        };
    }
    return {
      id: row.id,
      sealed,
      carnetTokens,
      tokens: {
        accessToken,
        refreshToken: this.secret(row.id, "refresh_token"),
        idToken: this.secret(row.id, "id_token"),
        codeVerifier: this.secret(row.id, "code_verifier"),
        expiresAt: row.token_expires_at,
      },
    };
  }

  private accountRow(id: string): AccountRow | undefined {
    return this.storage.db
      .prepare(
        "SELECT account_id AS id, token_expires_at FROM vw_account_sessions WHERE account_id = ?",
      )
      .get(id) as AccountRow | undefined;
  }

  private vehicleRows(accountId: string): VehicleRow[] {
    return this.storage.db
      .prepare(
        "SELECT id, vin, reference, display_name, model FROM vehicles WHERE account_id = ? ORDER BY created_at, id",
      )
      .all(accountId) as unknown as VehicleRow[];
  }

  async getUser(userId: string): Promise<StoredUser> {
    if (userId !== OWNER_ID) throw new Error("Unknown owner identity");
    const link = this.storage.db
      .prepare("SELECT account_id FROM owner_account_link WHERE owner_id = ?")
      .get(OWNER_ID) as { account_id: string } | undefined;
    const row =
      link === undefined ? undefined : this.accountRow(link.account_id);
    return {
      id: userId,
      account: row === undefined ? null : await this.account(row),
      vehicles:
        row === undefined ? [] : this.vehicleRows(row.id).map(storedVehicle),
    };
  }

  async getAccountByUserKey(userKey: string): Promise<StoredAccount | null> {
    const row = this.storage.db
      .prepare(
        "SELECT account_id AS id, token_expires_at FROM vw_account_sessions WHERE user_key = ?",
      )
      .get(userKey) as AccountRow | undefined;
    return row === undefined ? null : this.account(row);
  }

  async listAccounts(): Promise<
    { account: StoredAccount; vehicles: StoredVehicle[] }[]
  > {
    const rows = this.storage.db
      .prepare(
        "SELECT account_id AS id, token_expires_at FROM vw_account_sessions ORDER BY account_id",
      )
      .all() as unknown as AccountRow[];
    return Promise.all(
      rows.map(async (row) => ({
        account: await this.account(row),
        vehicles: this.vehicleRows(row.id).map(storedVehicle),
      })),
    );
  }

  private writeTokens(accountId: string, tokens: VwTokens): void {
    this.storage.db
      .prepare(
        "UPDATE vw_account_sessions SET token_expires_at = ? WHERE account_id = ?",
      )
      .run(tokens.expiresAt, accountId);
    const values: [SecretPurpose, string | null][] = [
      ["access_token", tokens.accessToken],
      ["refresh_token", tokens.refreshToken],
      ["id_token", tokens.idToken],
      ["code_verifier", tokens.codeVerifier],
    ];
    for (const [purpose, value] of values) {
      const ref = { accountId, purpose };
      if (value === null) this.secrets.delete(ref);
      else
        this.secrets.put(
          ref,
          value,
          purpose === "access_token" ? tokens.expiresAt : null,
        );
    }
  }

  private async upsert(
    userKey: string,
    sealed: Sealed,
    tokens: VwTokens,
    vehicles: VehicleDTO[],
    linkOwner: boolean,
  ): Promise<StoredVehicle[]> {
    const credentials = JSON.parse(
      await unseal(this.credentialKey, sealed),
    ) as {
      username?: unknown;
      password?: unknown;
      spin?: unknown;
    };
    const { username, password, spin } = credentials;
    if (
      typeof username !== "string" ||
      typeof password !== "string" ||
      (spin !== undefined && typeof spin !== "string")
    )
      throw new Error("Invalid sealed VW credentials");
    return this.storage.transaction(() => {
      const existing = this.storage.db
        .prepare(
          "SELECT account_id AS id FROM vw_account_sessions WHERE user_key = ?",
        )
        .get(userKey) as { id: string } | undefined;
      const accountId = existing?.id ?? randomUUID();
      if (existing === undefined) {
        this.vehicles.createAccount(accountId, Date.now());
        this.storage.db
          .prepare(
            "INSERT INTO vw_account_sessions(account_id, user_key, token_expires_at) VALUES (?, ?, ?)",
          )
          .run(accountId, userKey, tokens.expiresAt);
      }
      this.secrets.put({ accountId, purpose: "vw_username" }, username);
      this.secrets.put({ accountId, purpose: "vw_password" }, password);
      if (spin === undefined)
        this.secrets.delete({ accountId, purpose: "vw_spin" });
      else this.secrets.put({ accountId, purpose: "vw_spin" }, spin);
      this.writeTokens(accountId, tokens);
      const previous = this.vehicleRows(accountId);
      const stored = vehicles.map((vehicle) => {
        const id =
          previous.find((entry) => entry.reference === vehicle.uuid)?.id ??
          randomUUID();
        this.vehicles.upsertVehicle({
          id,
          accountId,
          reference: vehicle.uuid,
          vin: vehicle.vin,
          displayName: vehicle.nickname,
          model: vehicle.model,
          createdAt: Date.now(),
        });
        return { ...vehicle, id };
      });
      if (linkOwner)
        this.storage.db
          .prepare(
            "INSERT INTO owner_account_link(owner_id, account_id) VALUES ('owner', ?) ON CONFLICT(owner_id) DO UPDATE SET account_id = excluded.account_id",
          )
          .run(accountId);
      return stored;
    });
  }

  saveAccountSession(
    userKey: string,
    sealed: Sealed,
    tokens: VwTokens,
    vehicles: VehicleDTO[],
  ) {
    return this.upsert(userKey, sealed, tokens, vehicles, false);
  }
  saveLogin(
    userId: string,
    userKey: string,
    sealed: Sealed,
    tokens: VwTokens,
    vehicles: VehicleDTO[],
  ) {
    if (userId !== OWNER_ID) throw new Error("Unknown owner identity");
    return this.upsert(userKey, sealed, tokens, vehicles, true);
  }
  async updateTokens(accountId: string, tokens: VwTokens): Promise<void> {
    this.storage.transaction(() => {
      this.writeTokens(accountId, tokens);
    });
  }
  async saveCarnetToken(
    account: StoredAccount,
    uuid: string,
    entry: CarnetToken,
  ): Promise<void> {
    const now = Date.now();
    const next: Record<string, CarnetToken> = { [uuid]: entry };
    for (const [key, prior] of Object.entries(account.carnetTokens))
      if (key !== uuid && prior.expiresAt > now) next[key] = prior;
    this.storage.transaction(() => {
      this.storage.db
        .prepare(
          "DELETE FROM account_secrets WHERE account_id = ? AND purpose = 'carnet_token' AND expires_at <= ?",
        )
        .run(account.id, now);
      this.secrets.put(
        { accountId: account.id, purpose: "carnet_token", scope: uuid },
        entry.token,
        entry.expiresAt,
      );
    });
    account.carnetTokens = next;
  }
  async clearUserData(user: StoredUser): Promise<void> {
    if (user.id !== OWNER_ID || user.account === null) return;
    this.storage.db
      .prepare("DELETE FROM owner_account_link WHERE owner_id = ?")
      .run(OWNER_ID);
  }

  async saveSnapshot(
    vehicleId: string,
    status: StatusDTO,
    opts: { force?: boolean } = {},
  ): Promise<boolean> {
    const previous = this.storage.db
      .prepare(
        "SELECT payload FROM legacy_snapshots WHERE vehicle_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .get(vehicleId) as { payload: string } | undefined;
    const latest =
      previous === undefined
        ? undefined
        : (JSON.parse(previous.payload) as StatusDTO);
    if (
      opts.force !== true &&
      latest !== undefined &&
      status.capturedAt !== null &&
      latest.capturedAt === status.capturedAt &&
      latest.rvsUpdatedAt === status.rvsUpdatedAt &&
      latest.doorsUpdatedAt === status.doorsUpdatedAt &&
      latest.locksUpdatedAt === status.locksUpdatedAt &&
      latest.windowsUpdatedAt === status.windowsUpdatedAt
    )
      return false;
    const row = this.storage.db
      .prepare(
        "SELECT id, reference, vin, display_name, model FROM vehicles WHERE id = ?",
      )
      .get(vehicleId) as VehicleRow | undefined;
    if (row === undefined) throw new Error("Vehicle not found");
    const now = Date.now();
    const domain = mapVehicleStatus(
      {
        localId: vehicleId,
        reference: row.reference,
        vin: row.vin,
        name: row.display_name,
        model: row.model,
      },
      status,
      now,
    );
    this.storage.transaction(() => {
      this.storage.db
        .prepare(
          "INSERT INTO legacy_snapshots(vehicle_id, created_at, payload) VALUES (?, ?, ?)",
        )
        .run(vehicleId, now, JSON.stringify(status));
      this.vehicles.saveState(vehicleId, domain, now, 15 * 60_000, true);
    });
    return true;
  }
  async latestParkedAt(vehicleId: string): Promise<number | null> {
    const row = this.storage.db
      .prepare(
        "SELECT payload FROM legacy_snapshots WHERE vehicle_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .get(vehicleId) as { payload: string } | undefined;
    return row === undefined
      ? null
      : (JSON.parse(row.payload) as StatusDTO).parkedAt;
  }
  async pruneSnapshots(cutoffEpochMs: number): Promise<number> {
    return this.storage.db
      .prepare(
        "DELETE FROM legacy_snapshots WHERE id IN (SELECT id FROM legacy_snapshots WHERE created_at < ? ORDER BY created_at, id LIMIT 200)",
      )
      .run(cutoffEpochMs).changes as number;
  }

  async getActiveClimateSession(
    vehicleId: string,
  ): Promise<ClimateSession | null> {
    const row = this.storage.db
      .prepare(
        "SELECT * FROM climate_sessions WHERE vehicle_id = ? AND state = 'active' ORDER BY started_at DESC, rowid DESC LIMIT 1",
      )
      .get(vehicleId) as ClimateRow | undefined;
    return row === undefined ? null : climateSession(row);
  }
  async listActiveClimateSessions(): Promise<
    {
      session: ClimateSession;
      vehicle: StoredVehicle;
      account: StoredAccount;
    }[]
  > {
    const rows = this.storage.db
      .prepare(
        "SELECT c.*, v.account_id, v.id AS vehicle_id FROM climate_sessions c JOIN vehicles v ON v.id = c.vehicle_id WHERE c.state = 'active'",
      )
      .all() as unknown as (ClimateRow & {
      account_id: string;
      vehicle_id: string;
    })[];
    return Promise.all(
      rows.map(async (row) => {
        const accountRow = this.accountRow(row.account_id);
        const vehicleRow = this.storage.db
          .prepare(
            "SELECT id, vin, reference, display_name, model FROM vehicles WHERE id = ?",
          )
          .get(row.vehicle_id) as VehicleRow | undefined;
        if (accountRow === undefined || vehicleRow === undefined)
          throw new Error("Orphaned climate session");
        return {
          session: climateSession(row),
          vehicle: storedVehicle(vehicleRow),
          account: await this.account(accountRow),
        };
      }),
    );
  }
  async startClimateSession(
    vehicleId: string,
    fields: { tempF: number; expiresAt: number },
  ): Promise<void> {
    const now = Date.now();
    this.storage.transaction(() => {
      this.storage.db
        .prepare(
          "UPDATE climate_sessions SET state = 'stopped' WHERE vehicle_id = ? AND state = 'active'",
        )
        .run(vehicleId);
      this.storage.db
        .prepare(
          "INSERT INTO climate_sessions(id, vehicle_id, temp_f, expires_at, started_at, state, last_start_at) VALUES (?, ?, ?, ?, ?, 'active', ?)",
        )
        .run(randomUUID(), vehicleId, fields.tempF, fields.expiresAt, now, now);
    });
  }
  async updateClimateSession(
    sessionId: string,
    fields: Partial<{
      state: string;
      expiresAt: number;
      lastStartAt: number;
      remainingMin: number;
      error: string;
      pausedAt: number | null;
    }>,
  ): Promise<void> {
    const map = {
      state: "state",
      expiresAt: "expires_at",
      lastStartAt: "last_start_at",
      remainingMin: "remaining_min",
      error: "error",
      pausedAt: "paused_at",
    } as const;
    const entries = Object.entries(fields) as [
      keyof typeof map,
      string | number | null,
    ][];
    if (entries.length === 0) return;
    this.storage.db
      .prepare(
        `UPDATE climate_sessions SET ${entries.map(([key]) => `${map[key]} = ?`).join(", ")} WHERE id = ?`,
      )
      .run(...entries.map(([, value]) => value), sessionId);
  }
  async endClimateSession(vehicleId: string, state: string): Promise<void> {
    const active = await this.getActiveClimateSession(vehicleId);
    if (active !== null) await this.updateClimateSession(active.id, { state });
  }

  async syncMessages(
    accountId: string,
    vw: InboxMessage[],
    complete: boolean,
  ): Promise<void> {
    const existing = this.storage.db
      .prepare("SELECT * FROM messages WHERE account_id = ?")
      .all(accountId) as unknown as MessageRow[];
    const byId = new Map(existing.map((row) => [row.message_id, row]));
    const now = Date.now();
    const fetchedIds = new Set(vw.map((message) => message.id));
    const fetchedAts = vw
      .map((message) => message.at)
      .filter((at): at is number => at !== null);
    const oldestFetchedAt =
      fetchedAts.length === 0 ? null : Math.min(...fetchedAts);
    this.storage.transaction(() => {
      const upsert = this.storage.db.prepare(`INSERT INTO messages
        (id, account_id, message_id, title, body, at, read, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, message_id) DO UPDATE SET
          title=excluded.title, body=excluded.body, at=excluded.at, read=excluded.read`);
      for (const message of vw) {
        const prior = byId.get(message.id);
        upsert.run(
          prior?.id ?? randomUUID(),
          accountId,
          message.id,
          message.title,
          message.body,
          message.at,
          Number(message.read),
          prior?.created_at ?? message.at ?? now,
        );
      }
      for (const row of existing) {
        if (fetchedIds.has(row.message_id)) continue;
        if (
          complete ||
          (oldestFetchedAt !== null && (row.at ?? 0) >= oldestFetchedAt)
        )
          this.storage.db
            .prepare("DELETE FROM messages WHERE id = ?")
            .run(row.id);
      }
    });
  }
  async setMessageReadOverride(
    accountId: string,
    messageId: string,
    override: boolean | null,
  ): Promise<boolean> {
    return (
      this.storage.db
        .prepare(
          "UPDATE messages SET read_override = ? WHERE account_id = ? AND message_id = ?",
        )
        .run(override === null ? null : Number(override), accountId, messageId)
        .changes === 1
    );
  }
  async setMessageDeleted(
    accountId: string,
    messageId: string,
    deleted: boolean,
  ): Promise<boolean> {
    return (
      this.storage.db
        .prepare(
          "UPDATE messages SET deleted_at = ? WHERE account_id = ? AND message_id = ?",
        )
        .run(deleted ? Date.now() : null, accountId, messageId).changes === 1
    );
  }
}
