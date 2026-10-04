import type {
  PassiveCurrent,
  PassiveHistory,
  PassiveMessage,
  PassiveMessages,
  PassiveOwner,
  PassiveVehicle,
  PassiveVehicles,
  VehicleState,
} from "@vwapp/contract";
import type { AuthorizedDevice } from "../auth/devices";
import type { SqliteStorage } from "../storage/database";
import { VehicleRepository } from "../storage/repositories";
import type { NodeSqliteStore } from "./sqlite-store";

export interface PassiveResponse {
  status: number;
  body: unknown;
}

interface VehicleRow {
  id: string;
  reference: string;
  vin: string;
  display_name: string | null;
  model: string | null;
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

const notFound = (): PassiveResponse => ({
  status: 404,
  body: { error: "not_found" },
});
const badRequest = (): PassiveResponse => ({
  status: 400,
  body: { error: "invalid_request" },
});

/** SQLite-only, cached passive API. Never calls Volkswagen or returns secrets. */
export class NodePassiveApi {
  private readonly vehicles: VehicleRepository;
  private readonly storage: SqliteStorage;
  private readonly app: NodeSqliteStore;

  constructor(storage: SqliteStorage, app: NodeSqliteStore) {
    this.storage = storage;
    this.app = app;
    this.vehicles = new VehicleRepository(storage);
  }

  private accountId(): string | null {
    const row = this.storage.db
      .prepare(
        "SELECT account_id FROM owner_account_link WHERE owner_id = 'owner'",
      )
      .get() as { account_id: string } | undefined;
    return row?.account_id ?? null;
  }

  private vehicleRows(accountId: string): VehicleRow[] {
    return this.storage.db
      .prepare(
        "SELECT id, reference, vin, display_name, model FROM vehicles WHERE account_id = ? ORDER BY created_at, id",
      )
      .all(accountId) as unknown as VehicleRow[];
  }

  private vehicleRow(accountId: string, id: string): VehicleRow | undefined {
    return this.storage.db
      .prepare(
        "SELECT id, reference, vin, display_name, model FROM vehicles WHERE account_id = ? AND id = ?",
      )
      .get(accountId, id) as VehicleRow | undefined;
  }

  private async vehicle(row: VehicleRow): Promise<PassiveVehicle> {
    return {
      id: row.id,
      identity: {
        localId: row.id,
        reference: row.reference,
        vin: row.vin,
        name: row.display_name,
        model: row.model,
      },
      current: this.vehicles.getCurrentState(row.id),
      climateSession: await this.app.getActiveClimateSession(row.id),
    };
  }

  async handle(
    method: string,
    rawTarget: string,
    body: Buffer,
    device: AuthorizedDevice,
  ): Promise<PassiveResponse | null> {
    const url = new URL(rawTarget, "https://local.invalid");
    const path = url.pathname;
    if (!path.startsWith("/api/v1/")) return null;
    const accountId = this.accountId();
    if (method === "GET" && path === "/api/v1/owner" && url.search === "") {
      const owner: PassiveOwner = {
        device: { id: device.id, name: device.name, pubkey: device.pubkey },
        accountLinked: accountId !== null,
        vehicleAvailable:
          accountId !== null && this.vehicleRows(accountId).length > 0,
      };
      return { status: 200, body: owner };
    }
    if (method === "GET" && path === "/api/v1/vehicles" && url.search === "") {
      const rows = accountId === null ? [] : this.vehicleRows(accountId);
      const result: PassiveVehicles = {
        vehicles: await Promise.all(rows.map((row) => this.vehicle(row))),
      };
      return { status: 200, body: result };
    }
    if (method === "GET" && path === "/api/v1/messages" && url.search === "") {
      const rows =
        accountId === null
          ? []
          : (this.storage.db
              .prepare(
                "SELECT * FROM messages WHERE account_id = ? ORDER BY created_at DESC, id DESC",
              )
              .all(accountId) as unknown as MessageRow[]);
      const result: PassiveMessages = {
        messages: rows.map((row): PassiveMessage => ({
          id: row.id,
          messageId: row.message_id,
          title: row.title,
          body: row.body,
          at: row.at,
          read: row.read === 1,
          readOverride:
            row.read_override === null ? null : row.read_override === 1,
          deletedAt: row.deleted_at,
          createdAt: row.created_at,
        })),
      };
      return { status: 200, body: result };
    }
    const vehicleMatch =
      /^\/api\/v1\/vehicles\/([0-9a-f-]{36})\/(current|history)$/.exec(path);
    if (method === "GET" && vehicleMatch !== null) {
      const id = vehicleMatch[1];
      if (
        id === undefined ||
        accountId === null ||
        this.vehicleRow(accountId, id) === undefined
      )
        return notFound();
      if (vehicleMatch[2] === "current" && url.search === "") {
        const result: PassiveCurrent = {
          current: this.vehicles.getCurrentState(id),
        };
        return { status: 200, body: result };
      }
      if (vehicleMatch[2] === "history") {
        const rawLimit = url.searchParams.get("limit");
        if (
          [...url.searchParams.keys()].some((key) => key !== "limit") ||
          url.searchParams.getAll("limit").length > 1 ||
          (rawLimit !== null &&
            (!/^[1-9]\d*$/.test(rawLimit) || Number(rawLimit) > 500))
        )
          return badRequest();
        const limit = rawLimit === null ? 100 : Number(rawLimit);
        const rows = this.storage.db
          .prepare(
            `SELECT id, payload, state_schema_version, recorded_at FROM vehicle_observations
           WHERE vehicle_id = ? ORDER BY fetched_at DESC, id DESC LIMIT ?`,
          )
          .all(id, limit) as unknown as {
          id: number;
          payload: string;
          state_schema_version: number;
          recorded_at: number;
        }[];
        const result: PassiveHistory = {
          observations: rows.map((row) => {
            if (row.state_schema_version !== 1)
              throw new Error("Unsupported vehicle state version");
            return {
              id: row.id,
              vehicleId: id,
              state: JSON.parse(row.payload) as VehicleState,
              recordedAt: row.recorded_at,
            };
          }),
        };
        return { status: 200, body: result };
      }
      return badRequest();
    }
    const messageMatch = /^\/api\/v1\/messages\/([^/]+)$/.exec(path);
    if (method === "PATCH" && messageMatch !== null && url.search === "") {
      if (accountId === null) return notFound();
      let input: unknown;
      try {
        input = JSON.parse(body.toString("utf8")) as unknown;
      } catch {
        return badRequest();
      }
      if (input === null || typeof input !== "object" || Array.isArray(input))
        return badRequest();
      const fields = input as Record<string, unknown>;
      const keys = Object.keys(fields);
      if (
        keys.length !== 1 ||
        !["readOverride", "deleted"].includes(keys[0] ?? "")
      )
        return badRequest();
      const id = decodeURIComponent(messageMatch[1] ?? "");
      if ("readOverride" in fields) {
        if (
          fields["readOverride"] !== null &&
          typeof fields["readOverride"] !== "boolean"
        )
          return badRequest();
        return (await this.app.setMessageReadOverride(
          accountId,
          id,
          fields["readOverride"],
        ))
          ? { status: 200, body: { ok: true } }
          : notFound();
      }
      if (typeof fields["deleted"] !== "boolean") return badRequest();
      return (await this.app.setMessageDeleted(
        accountId,
        id,
        fields["deleted"],
      ))
        ? { status: 200, body: { ok: true } }
        : notFound();
    }
    return notFound();
  }
}
