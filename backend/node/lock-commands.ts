import {
  lockCommandSchema,
  lockRequestSchema,
  type LockCommand,
} from "@vwapp/contract/lock-command";
import type { AuthorizedDevice } from "../auth/devices";
import { unseal } from "../src/crypto";
import type { AppEnv } from "../src/env";
import { readStatus } from "../src/status";
import { ensureCarnetToken, ensureTokens } from "../src/tokens";
import { mapVehicleStatus } from "../src/vw/adapter";
import {
  vwAwaitCommandResult,
  VwCommandError,
  vwLockUnlock,
} from "../src/vw/client";
import type { SqliteStorage } from "../storage/database";
import {
  CommandConflict,
  LockCommandRepository,
  type DurableLockCommand,
} from "../storage/lock-commands";
import { VehicleRepository } from "../storage/repositories";
import type { PassiveResponse } from "./passive";
import { OWNER_ID, type NodeSqliteStore } from "./sqlite-store";

export interface LockCommandOptions {
  intervalMs?: number;
  historyAttempts?: number;
  observationAttempts?: number;
  deadlineMs?: number;
  now?: () => number;
}
class CommandDeadline extends Error {}
class AccountChanged extends Error {}
const failure = (status: number, error: string): PassiveResponse => ({
  status,
  body: { error },
});

/** Node-only application semantics; never calls the legacy optimistic router. */
export class NodeLockCommands {
  readonly repository: LockCommandRepository;
  private readonly storage: SqliteStorage;
  private readonly db: NodeSqliteStore;
  private readonly env: AppEnv;
  private readonly vehicles: VehicleRepository;
  private readonly options: Required<LockCommandOptions>;
  private readonly jobs = new Map<string, Promise<void>>();
  private stopping = false;
  constructor(
    storage: SqliteStorage,
    db: NodeSqliteStore,
    env: AppEnv,
    options: LockCommandOptions = {},
  ) {
    this.storage = storage;
    this.db = db;
    this.env = env;
    this.vehicles = new VehicleRepository(storage);
    this.repository = new LockCommandRepository(storage);
    this.options = {
      intervalMs: 2500,
      historyAttempts: 8,
      observationAttempts: 3,
      deadlineMs: 60_000,
      now: Date.now,
      ...options,
    };
    this.repository.recover(this.options.now());
  }
  private linkedAccount(): string | null {
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
  private owned(command: DurableLockCommand): boolean {
    return (
      this.linkedAccount() === command.accountId &&
      this.vehicles.getVehicle(command.vehicleId)?.accountId ===
        command.accountId
    );
  }
  private receipt(command: DurableLockCommand): LockCommand {
    return lockCommandSchema.parse(command);
  }
  private schedule(command: DurableLockCommand, submit: boolean) {
    if (this.jobs.has(command.id)) return;
    const job = Promise.resolve()
      .then(() => this.run(command, submit))
      .finally(() => {
        this.jobs.delete(command.id);
      });
    this.jobs.set(command.id, job);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all(this.jobs.values());
  }

  private async run(
    initial: DurableLockCommand,
    submit: boolean,
  ): Promise<void> {
    let command = initial;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new CommandDeadline());
      }, this.options.deadlineMs);
    });
    const bounded = <T>(work: Promise<T>): Promise<T> =>
      Promise.race([work, deadline]);
    const check = () => {
      if (expired) throw new CommandDeadline();
      if (!this.owned(command)) throw new AccountChanged();
    };
    try {
      check();
      const user = await bounded(this.db.getUser(OWNER_ID));
      if (user.account?.id !== command.accountId) throw new AccountChanged();
      const account = user.account;
      const vehicle = user.vehicles.find(
        (item) => item.id === command.vehicleId,
      );
      if (vehicle === undefined) throw new AccountChanged();
      const credentials = JSON.parse(
        await bounded(unseal(this.env.CREDS_ENC_KEY, account.sealed)),
      ) as { spin?: unknown };
      if (
        typeof credentials.spin !== "string" ||
        !/^\d{4,6}$/.test(credentials.spin)
      )
        throw new Error("PIN unavailable");
      const spin = credentials.spin;
      if (submit) {
        // Token preparation is still pre-submission. Never retry a PUT after
        // an ambiguous transport/protocol response, even with a fresh token.
        const tokens = await bounded(
          ensureTokens(this.db, this.env, account, true),
        );
        check();
        const device = this.storage.db
          .prepare("SELECT revoked_at FROM authorized_devices WHERE id = ?")
          .get(command.deviceId) as { revoked_at: number | null } | undefined;
        if (device?.revoked_at !== null) throw new Error("Device unavailable");
        command = this.repository.update(command.id, {
          status: "submitting",
          submittedAt: this.options.now(),
        });
        const correlationId = await bounded(
          vwLockUnlock(tokens, vehicle.uuid, spin, command.action),
        );
        check();
        // Correlation IDs are private opaque path components, never API fields.
        if (!/^[A-Za-z0-9._:-]{1,200}$/.test(correlationId))
          throw new Error("Invalid correlation");
        command = this.repository.update(command.id, {
          status: "accepted",
          acceptedAt: this.options.now(),
          correlationId,
        });
      }
      if (command.correlationId === null) return;
      const correlationId = command.correlationId;
      command = this.repository.update(command.id, {
        status: "waiting_for_vehicle",
        failureCode: null,
        completedAt: null,
        confirmationRounds: command.confirmationRounds + 1,
      });
      let historyFailed = false;
      let unavailable = false;
      try {
        const carnet = await bounded(
          ensureCarnetToken(this.db, this.env, account, vehicle.uuid, spin, {
            safeErrors: true,
          }),
        );
        check();
        const history = await bounded(
          vwAwaitCommandResult(carnet, vehicle.uuid, correlationId, {
            attempts: this.options.historyAttempts,
            intervalMs: this.options.intervalMs,
          }),
        );
        check();
        command = this.repository.update(command.id, {
          historyConfirmed: history.confirmed,
        });
      } catch (error) {
        if (error instanceof CommandDeadline || error instanceof AccountChanged)
          throw error;
        historyFailed = error instanceof VwCommandError;
        unavailable = !historyFailed;
        command = this.repository.update(command.id, {
          historyConfirmed: false,
        });
      }
      const target = command.action === "lock" ? "locked" : "unlocked";
      for (let index = 0; index < this.options.observationAttempts; index++) {
        if (index > 0)
          await bounded(
            new Promise((resolve) =>
              setTimeout(resolve, this.options.intervalMs),
            ),
          );
        check();
        try {
          const status = await bounded(
            readStatus(this.db, this.env, account, vehicle, spin, {
              safeErrors: true,
            }),
          );
          check();
          const fetchedAt = this.options.now();
          const state = mapVehicleStatus(
            {
              localId: vehicle.id,
              reference: vehicle.uuid,
              vin: vehicle.vin,
              name: vehicle.nickname,
              model: vehicle.model,
            },
            status,
            fetchedAt,
          );
          // Explicit per-door UNLOCKED evidence survives the legacy DTO. A
          // bare false secure flag remains unknown (e.g. an open locked door).
          if (status.unlockedDoors.length > 0)
            state.security.lock =
              status.locked === true ? "unknown" : "unlocked";
          const sourceUpdatedAt = status.locksUpdatedAt ?? status.rvsUpdatedAt;
          this.vehicles.saveState(vehicle.id, state, fetchedAt);
          command = this.repository.update(command.id, {
            observation: {
              lock: state.security.lock,
              fetchedAt,
              sourceUpdatedAt,
            },
            statusReads: command.statusReads + 1,
          });
          if (
            !historyFailed &&
            command.historyConfirmed === true &&
            state.security.lock === target &&
            sourceUpdatedAt !== null &&
            command.submittedAt !== null &&
            sourceUpdatedAt >= command.submittedAt
          ) {
            command = this.repository.update(command.id, {
              status: "confirmed",
              completedAt: this.options.now(),
              failureCode: null,
            });
            return;
          }
          if (historyFailed) break;
        } catch (error) {
          if (
            error instanceof CommandDeadline ||
            error instanceof AccountChanged
          )
            throw error;
          unavailable = true;
        }
      }
      const conflicting =
        command.observation !== null &&
        command.observation.lock !== "unknown" &&
        command.observation.lock !== target;
      command = this.repository.update(command.id, {
        status: historyFailed
          ? "failed"
          : unavailable
            ? "unknown"
            : "timed_out",
        completedAt: this.options.now(),
        failureCode: historyFailed
          ? "vehicle_rejected"
          : unavailable
            ? "confirmation_unavailable"
            : conflicting
              ? "conflicting_observation"
              : "confirmation_timeout",
      });
    } catch (error) {
      // Never reflect upstream bodies/errors, credentials or correlations.
      const submitted = command.submittedAt !== null;
      const accepted = command.acceptedAt !== null;
      const explicitRejection =
        error instanceof VwCommandError &&
        !/no correlationId|failed \(5\d\d\)/.test(error.message);
      command = this.repository.update(command.id, {
        status:
          error instanceof CommandDeadline && accepted
            ? "timed_out"
            : submitted && !explicitRejection
              ? "unknown"
              : "failed",
        completedAt: this.options.now(),
        failureCode:
          error instanceof AccountChanged
            ? "account_changed"
            : error instanceof CommandDeadline
              ? accepted
                ? "confirmation_timeout"
                : submitted
                  ? "submission_uncertain"
                  : "preparation_failed"
              : !submitted
                ? "preparation_failed"
                : explicitRejection
                  ? "vw_rejected"
                  : "submission_uncertain",
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      console.log(
        JSON.stringify({
          event: "lock_command",
          commandId: command.id,
          action: command.action,
          status: command.status,
        }),
      );
    }
  }

  handle(
    method: string,
    target: string,
    body: Buffer,
    device: AuthorizedDevice,
  ): PassiveResponse | null {
    const url = new URL(target, "https://local.invalid");
    if (
      url.pathname !== "/api/v1/commands" &&
      !url.pathname.startsWith("/api/v1/commands/")
    )
      return null;
    if (url.search !== "") return failure(400, "invalid_request");
    if (this.stopping) return failure(503, "server_stopping");
    if (method === "POST" && url.pathname === "/api/v1/commands") {
      let input: unknown;
      try {
        input = JSON.parse(body.toString("utf8")) as unknown;
      } catch {
        return failure(400, "invalid_request");
      }
      const parsed = lockRequestSchema.safeParse(input);
      if (!parsed.success) return failure(400, "invalid_request");
      const accountId = this.linkedAccount();
      const vehicle = this.vehicles.getVehicle(parsed.data.vehicleId);
      if (accountId === null || vehicle?.accountId !== accountId)
        return failure(404, "not_found");
      try {
        const result = this.repository.intent(
          parsed.data,
          accountId,
          device.id,
          device.pubkey,
          this.options.now(),
        );
        if (result.created) this.schedule(result.command, true);
        return {
          status: result.created ? 202 : 200,
          body: this.receipt(result.command),
        };
      } catch (error) {
        if (error instanceof CommandConflict)
          return failure(409, "command_conflict");
        throw error;
      }
    }
    const keyMatch = /^\/api\/v1\/commands\/key\/([0-9a-f-]{36})$/.exec(
      url.pathname,
    );
    const idMatch = /^\/api\/v1\/commands\/([0-9a-f-]{36})(\/reconcile)?$/.exec(
      url.pathname,
    );
    const command =
      keyMatch?.[1] !== undefined
        ? this.repository.byKey(device.id, keyMatch[1])
        : idMatch?.[1] !== undefined
          ? this.repository.get(idMatch[1])
          : null;
    if (command === null || !this.owned(command))
      return failure(404, "not_found");
    if (method === "GET" && (keyMatch !== null || idMatch?.[2] === undefined))
      return { status: 200, body: this.receipt(command) };
    if (method === "POST" && idMatch?.[2] === "/reconcile") {
      if (body.toString("utf8") !== "{}")
        return failure(400, "invalid_request");
      if (
        command.status === "confirmed" ||
        command.status === "failed" ||
        command.correlationId === null
      )
        return { status: 200, body: this.receipt(command) };
      const active = this.storage.db
        .prepare(
          "SELECT id FROM commands WHERE vehicle_id = ? AND idempotency_key IS NOT NULL AND status IN ('requested','submitting','accepted','waiting_for_vehicle') AND id <> ?",
        )
        .get(command.vehicleId, command.id);
      if (active !== undefined) return failure(409, "command_conflict");
      const waiting = this.repository.update(command.id, {
        status: "waiting_for_vehicle",
        failureCode: null,
        completedAt: null,
      });
      this.schedule(waiting, false);
      return { status: 202, body: this.receipt(waiting) };
    }
    return failure(404, "not_found");
  }
}
