/** Application persistence seam. Worker keeps the InstantDB implementation;
 * Node supplies the SQLite implementation at its composition root. */
import type { StatusDTO, VehicleDTO } from "@vwapp/contract";
import type { Sealed } from "./crypto";
import type * as instantTypes from "./store";
import type {
  CarnetToken,
  ClimateSession,
  StoredAccount,
  StoredUser,
  StoredVehicle,
} from "./store";
import type { InboxMessage, VwTokens } from "./vw/client";

export type {
  CarnetToken,
  ClimateSession,
  StoredAccount,
  StoredUser,
  StoredVehicle,
} from "./store";

export interface SqliteApplicationStore {
  readonly kind: "sqlite";
  getUser(userId: string): Promise<StoredUser>;
  getAccountByUserKey(userKey: string): Promise<StoredAccount | null>;
  listAccounts(): Promise<
    { account: StoredAccount; vehicles: StoredVehicle[] }[]
  >;
  saveAccountSession(
    userKey: string,
    sealed: Sealed,
    tokens: VwTokens,
    vehicles: VehicleDTO[],
  ): Promise<StoredVehicle[]>;
  saveLogin(
    userId: string,
    userKey: string,
    sealed: Sealed,
    tokens: VwTokens,
    vehicles: VehicleDTO[],
  ): Promise<StoredVehicle[]>;
  updateTokens(accountId: string, tokens: VwTokens): Promise<void>;
  saveCarnetToken(
    account: StoredAccount,
    uuid: string,
    entry: CarnetToken,
  ): Promise<void>;
  clearUserData(user: StoredUser): Promise<void>;
  saveSnapshot(
    vehicleId: string,
    status: StatusDTO,
    opts?: { force?: boolean },
  ): Promise<boolean>;
  latestParkedAt(vehicleId: string): Promise<number | null>;
  pruneSnapshots(cutoffEpochMs: number): Promise<number>;
  getActiveClimateSession(vehicleId: string): Promise<ClimateSession | null>;
  listActiveClimateSessions(): Promise<
    {
      session: ClimateSession;
      vehicle: StoredVehicle;
      account: StoredAccount;
    }[]
  >;
  startClimateSession(
    vehicleId: string,
    fields: { tempF: number; expiresAt: number },
  ): Promise<void>;
  updateClimateSession(
    sessionId: string,
    fields: Partial<{
      state: string;
      expiresAt: number;
      lastStartAt: number;
      remainingMin: number;
      error: string;
      pausedAt: number | null;
    }>,
  ): Promise<void>;
  endClimateSession(vehicleId: string, state: string): Promise<void>;
  syncMessages(
    accountId: string,
    vw: InboxMessage[],
    complete: boolean,
  ): Promise<void>;
  setMessageReadOverride(
    accountId: string,
    messageId: string,
    override: boolean | null,
  ): Promise<boolean>;
  setMessageDeleted(
    accountId: string,
    messageId: string,
    deleted: boolean,
  ): Promise<boolean>;
}

export type Db = instantTypes.Db | SqliteApplicationStore;
/** The Worker installs its existing InstantDB implementation at startup.
 * Keeping that import at the Worker entrypoint leaves it out of the Node bundle. */
let instant: typeof import("./store") | null = null;
export function registerInstantAdapter(
  adapter: typeof import("./store"),
): void {
  instant = adapter;
}
function instantAdapter(): typeof import("./store") {
  if (instant === null) throw new Error("InstantDB adapter not registered");
  return instant;
}
const sqlite = (db: Db): db is SqliteApplicationStore =>
  (db as unknown as { kind?: unknown }).kind === "sqlite";

export const getUser = (db: Db, userId: string) =>
  sqlite(db) ? db.getUser(userId) : instantAdapter().getUser(db, userId);
export const getAccountByUserKey = (db: Db, userKey: string) =>
  sqlite(db)
    ? db.getAccountByUserKey(userKey)
    : instantAdapter().getAccountByUserKey(db, userKey);
export const listAccounts = (db: Db) =>
  sqlite(db) ? db.listAccounts() : instantAdapter().listAccounts(db);
export const saveAccountSession = (
  db: Db,
  userKey: string,
  sealed: Sealed,
  tokens: VwTokens,
  vehicles: VehicleDTO[],
) =>
  sqlite(db)
    ? db.saveAccountSession(userKey, sealed, tokens, vehicles)
    : instantAdapter().saveAccountSession(
        db,
        userKey,
        sealed,
        tokens,
        vehicles,
      );
export const saveLogin = (
  db: Db,
  userId: string,
  userKey: string,
  sealed: Sealed,
  tokens: VwTokens,
  vehicles: VehicleDTO[],
) =>
  sqlite(db)
    ? db.saveLogin(userId, userKey, sealed, tokens, vehicles)
    : instantAdapter().saveLogin(db, userId, userKey, sealed, tokens, vehicles);
export const updateTokens = (db: Db, accountId: string, tokens: VwTokens) =>
  sqlite(db)
    ? db.updateTokens(accountId, tokens)
    : instantAdapter().updateTokens(db, accountId, tokens);
export const saveCarnetToken = (
  db: Db,
  account: StoredAccount,
  uuid: string,
  entry: CarnetToken,
) =>
  sqlite(db)
    ? db.saveCarnetToken(account, uuid, entry)
    : instantAdapter().saveCarnetToken(db, account, uuid, entry);
export const clearUserData = (db: Db, user: StoredUser) =>
  sqlite(db)
    ? db.clearUserData(user)
    : instantAdapter().clearUserData(db, user);
export const saveSnapshot = (
  db: Db,
  vehicleId: string,
  status: StatusDTO,
  opts: { force?: boolean } = {},
) =>
  sqlite(db)
    ? db.saveSnapshot(vehicleId, status, opts)
    : instantAdapter().saveSnapshot(db, vehicleId, status, opts);
export const latestParkedAt = (db: Db, vehicleId: string) =>
  sqlite(db)
    ? db.latestParkedAt(vehicleId)
    : instantAdapter().latestParkedAt(db, vehicleId);
export const pruneSnapshots = (db: Db, cutoffEpochMs: number) =>
  sqlite(db)
    ? db.pruneSnapshots(cutoffEpochMs)
    : instantAdapter().pruneSnapshots(db, cutoffEpochMs);
export const getActiveClimateSession = (db: Db, vehicleId: string) =>
  sqlite(db)
    ? db.getActiveClimateSession(vehicleId)
    : instantAdapter().getActiveClimateSession(db, vehicleId);
export const listActiveClimateSessions = (db: Db) =>
  sqlite(db)
    ? db.listActiveClimateSessions()
    : instantAdapter().listActiveClimateSessions(db);
export const startClimateSession = (
  db: Db,
  vehicleId: string,
  fields: { tempF: number; expiresAt: number },
) =>
  sqlite(db)
    ? db.startClimateSession(vehicleId, fields)
    : instantAdapter().startClimateSession(db, vehicleId, fields);
export const updateClimateSession = (
  db: Db,
  sessionId: string,
  fields: Partial<{
    state: string;
    expiresAt: number;
    lastStartAt: number;
    remainingMin: number;
    error: string;
    pausedAt: number | null;
  }>,
) =>
  sqlite(db)
    ? db.updateClimateSession(sessionId, fields)
    : instantAdapter().updateClimateSession(db, sessionId, fields);
export const endClimateSession = (db: Db, vehicleId: string, state: string) =>
  sqlite(db)
    ? db.endClimateSession(vehicleId, state)
    : instantAdapter().endClimateSession(db, vehicleId, state);
export const syncMessages = (
  db: Db,
  accountId: string,
  vw: InboxMessage[],
  complete: boolean,
) =>
  sqlite(db)
    ? db.syncMessages(accountId, vw, complete)
    : instantAdapter().syncMessages(db, accountId, vw, complete);
export const setMessageReadOverride = (
  db: Db,
  accountId: string,
  messageId: string,
  override: boolean | null,
) =>
  sqlite(db)
    ? db.setMessageReadOverride(accountId, messageId, override)
    : instantAdapter().setMessageReadOverride(
        db,
        accountId,
        messageId,
        override,
      );
export const setMessageDeleted = (
  db: Db,
  accountId: string,
  messageId: string,
  deleted: boolean,
) =>
  sqlite(db)
    ? db.setMessageDeleted(accountId, messageId, deleted)
    : instantAdapter().setMessageDeleted(db, accountId, messageId, deleted);
