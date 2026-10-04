/** SQLite application persistence seam used by the Node composition root. */
import type { StatusDTO, VehicleDTO } from "@vwapp/contract";
import type { Sealed } from "./crypto";
import type { InboxMessage, VwTokens } from "./vw/client";

export interface StoredVehicle extends VehicleDTO {
  id: string;
}
export interface CarnetToken {
  token: string;
  expiresAt: number;
}
export interface StoredAccount {
  id: string;
  sealed: Sealed;
  tokens: VwTokens;
  carnetTokens: Record<string, CarnetToken>;
}
export interface StoredUser {
  id: string;
  account: StoredAccount | null;
  vehicles: StoredVehicle[];
}
export interface ClimateSession {
  id: string;
  tempF: number;
  expiresAt: number;
  startedAt: number;
  state: string;
  lastStartAt: number | null;
  remainingMin: number | null;
  pausedAt: number | null;
}

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

export type Db = SqliteApplicationStore;

export const getUser = (db: Db, userId: string) => db.getUser(userId);
export const getAccountByUserKey = (db: Db, userKey: string) =>
  db.getAccountByUserKey(userKey);
export const listAccounts = (db: Db) => db.listAccounts();
export const saveAccountSession = (
  db: Db,
  userKey: string,
  sealed: Sealed,
  tokens: VwTokens,
  vehicles: VehicleDTO[],
) => db.saveAccountSession(userKey, sealed, tokens, vehicles);
export const saveLogin = (
  db: Db,
  userId: string,
  userKey: string,
  sealed: Sealed,
  tokens: VwTokens,
  vehicles: VehicleDTO[],
) => db.saveLogin(userId, userKey, sealed, tokens, vehicles);
export const updateTokens = (db: Db, accountId: string, tokens: VwTokens) =>
  db.updateTokens(accountId, tokens);
export const saveCarnetToken = (
  db: Db,
  account: StoredAccount,
  uuid: string,
  entry: CarnetToken,
) => db.saveCarnetToken(account, uuid, entry);
export const clearUserData = (db: Db, user: StoredUser) =>
  db.clearUserData(user);
export const saveSnapshot = (
  db: Db,
  vehicleId: string,
  status: StatusDTO,
  opts: { force?: boolean } = {},
) => db.saveSnapshot(vehicleId, status, opts);
export const latestParkedAt = (db: Db, vehicleId: string) =>
  db.latestParkedAt(vehicleId);
export const pruneSnapshots = (db: Db, cutoffEpochMs: number) =>
  db.pruneSnapshots(cutoffEpochMs);
export const getActiveClimateSession = (db: Db, vehicleId: string) =>
  db.getActiveClimateSession(vehicleId);
export const listActiveClimateSessions = (db: Db) =>
  db.listActiveClimateSessions();
export const startClimateSession = (
  db: Db,
  vehicleId: string,
  fields: { tempF: number; expiresAt: number },
) => db.startClimateSession(vehicleId, fields);
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
) => db.updateClimateSession(sessionId, fields);
export const endClimateSession = (db: Db, vehicleId: string, state: string) =>
  db.endClimateSession(vehicleId, state);
export const syncMessages = (
  db: Db,
  accountId: string,
  vw: InboxMessage[],
  complete: boolean,
) => db.syncMessages(accountId, vw, complete);
export const setMessageReadOverride = (
  db: Db,
  accountId: string,
  messageId: string,
  override: boolean | null,
) => db.setMessageReadOverride(accountId, messageId, override);
export const setMessageDeleted = (
  db: Db,
  accountId: string,
  messageId: string,
  deleted: boolean,
) => db.setMessageDeleted(accountId, messageId, deleted);
