import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SqliteStorage } from "../storage/database";
import { AuthFailure } from "./errors";

export interface AuthorizedDevice {
  id: string;
  pubkey: string;
  name: string;
  pairedAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

const hashToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

function toDevice(row: {
  id: string;
  pubkey: string;
  name: string;
  paired_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}): AuthorizedDevice {
  return {
    id: row.id,
    pubkey: row.pubkey,
    name: row.name,
    pairedAt: row.paired_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

export class DeviceRepository {
  private readonly storage: SqliteStorage;

  constructor(storage: SqliteStorage) {
    this.storage = storage;
  }

  /** Local operator action. Only a SHA-256 digest of the 256-bit token is stored. */
  issuePairing(nowMs: number, lifetimeMs = 5 * 60_000): string {
    if (
      !Number.isSafeInteger(nowMs) ||
      lifetimeMs < 1 ||
      lifetimeMs > 5 * 60_000
    )
      throw new Error("Invalid pairing lifetime");
    const token = randomBytes(32).toString("base64url");
    this.storage.transaction(() => {
      this.storage.db
        .prepare("DELETE FROM pairing_sessions WHERE expires_at < ?")
        .run(nowMs);
      const active = this.storage.db
        .prepare(
          "SELECT count(*) AS count FROM pairing_sessions WHERE consumed_at IS NULL",
        )
        .get() as { count: number };
      if (active.count >= 3)
        throw new Error("Too many active pairing sessions");
      this.storage.db
        .prepare(
          "INSERT INTO pairing_sessions(token_hash, created_at, expires_at) VALUES (?, ?, ?)",
        )
        .run(hashToken(token), nowMs, nowMs + lifetimeMs);
    });
    return token;
  }

  pair(
    token: string,
    pubkey: string,
    name: string,
    nowMs: number,
  ): AuthorizedDevice {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      !/^[0-9a-f]{64}$/.test(pubkey) ||
      name.trim() !== name ||
      name.length < 1 ||
      name.length > 64 ||
      Array.from(name).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
    )
      throw new AuthFailure("pairing_invalid");
    return this.storage.transaction(() => {
      const session = this.storage.db
        .prepare(
          "SELECT expires_at, consumed_at FROM pairing_sessions WHERE token_hash = ?",
        )
        .get(hashToken(token)) as
        { expires_at: number; consumed_at: number | null } | undefined;
      if (session === undefined) throw new AuthFailure("pairing_invalid");
      if (session.consumed_at !== null || session.expires_at < nowMs)
        throw new AuthFailure("pairing_invalid");
      // A revoked key can never be silently revived. Recovery uses a new key.
      if (this.getByPubkey(pubkey) !== null)
        throw new AuthFailure("pairing_invalid");
      const device: AuthorizedDevice = {
        id: randomUUID(),
        pubkey,
        name,
        pairedAt: nowMs,
        lastUsedAt: null,
        revokedAt: null,
      };
      this.storage.db
        .prepare(
          "INSERT INTO authorized_devices(id, pubkey, name, paired_at) VALUES (?, ?, ?, ?)",
        )
        .run(device.id, device.pubkey, device.name, device.pairedAt);
      this.storage.db
        .prepare(
          "UPDATE pairing_sessions SET consumed_at = ? WHERE token_hash = ?",
        )
        .run(nowMs, hashToken(token));
      return device;
    });
  }

  getByPubkey(pubkey: string): AuthorizedDevice | null {
    const row = this.storage.db
      .prepare("SELECT * FROM authorized_devices WHERE pubkey = ?")
      .get(pubkey) as
      | {
          id: string;
          pubkey: string;
          name: string;
          paired_at: number;
          last_used_at: number | null;
          revoked_at: number | null;
        }
      | undefined;
    return row === undefined ? null : toDevice(row);
  }

  listDevices(): AuthorizedDevice[] {
    const rows = this.storage.db
      .prepare("SELECT * FROM authorized_devices ORDER BY paired_at, id")
      .all() as unknown as Parameters<typeof toDevice>[0][];
    return rows.map(toDevice);
  }

  revoke(id: string, nowMs: number): boolean {
    return (
      this.storage.db
        .prepare(
          "UPDATE authorized_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        )
        .run(nowMs, id).changes === 1
    );
  }

  /** Durable uniqueness and revocation check share a write transaction. */
  consumeReplay(
    eventId: string,
    pubkey: string,
    nowMs: number,
    expiresAt: number,
    maxRows = 10_000,
  ): AuthorizedDevice {
    return this.storage.transaction(() => {
      const device = this.getByPubkey(pubkey);
      if (device === null) throw new AuthFailure("unknown_device");
      if (device.revokedAt !== null) throw new AuthFailure("revoked_device");
      this.storage.db
        .prepare("DELETE FROM auth_replay_events WHERE expires_at < ?")
        .run(nowMs);
      const total = this.storage.db
        .prepare("SELECT count(*) AS count FROM auth_replay_events")
        .get() as { count: number };
      if (total.count >= maxRows) throw new AuthFailure("rate_limited");
      try {
        this.storage.db
          .prepare(
            "INSERT INTO auth_replay_events(event_id, device_id, consumed_at, expires_at) VALUES (?, ?, ?, ?)",
          )
          .run(eventId, device.id, nowMs, expiresAt);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("UNIQUE constraint failed")
        )
          throw new AuthFailure("replay");
        throw error;
      }
      this.storage.db
        .prepare("UPDATE authorized_devices SET last_used_at = ? WHERE id = ?")
        .run(nowMs, device.id);
      return { ...device, lastUsedAt: nowMs };
    });
  }

  replayCount(): number {
    return (
      this.storage.db
        .prepare("SELECT count(*) AS count FROM auth_replay_events")
        .get() as { count: number }
    ).count;
  }
}
