import { readStatus } from "../src/status";
import { ensureTokens, reauth } from "../src/tokens";
import { mapVehicleStatus } from "../src/vw/adapter";
import { VwAuthError, vwForceRefresh } from "../src/vw/client";
import type { Execution } from "./control-executor";

export async function executeWake(x: Execution) {
  let command = x.command;
  const update = (patch: Parameters<typeof x.repository.update>[1]) => {
    command = x.repository.update(command.id, patch);
    return command;
  };
  const { bounded, check, db, env, account, vehicle, spin, options } = x;
  if (x.submit) {
    const tokens = await bounded(ensureTokens(db, env, account, true));
    check();
    if (!x.authorized()) throw Error("Device unavailable");
    update({
      status: "submitting",
      submittedAt: options.now(),
      baselineSourceAt:
        x.vehicles.getCurrentState(vehicle.id)?.state.freshness.rvsUpdatedAt ??
        null,
      stage: "wake",
    });
    try {
      try {
        await bounded(vwForceRefresh(tokens, vehicle.uuid, spin));
      } catch (error) {
        check();
        if (!(error instanceof VwAuthError)) throw error;
        const fresh = await bounded(reauth(db, env, account, true, true));
        check();
        if (!x.authorized()) throw Error("Device unavailable");
        await bounded(vwForceRefresh(fresh, vehicle.uuid, spin));
      }
      check();
      update({ status: "accepted", acceptedAt: options.now() });
    } catch {
      check();
      update({ failureCode: "confirmation_unavailable" });
    } // Preserve cloud-read fallback, never claim a wake acknowledgement.
  }
  update({
    status: "waiting_for_vehicle",
    completedAt: null,
    confirmationRounds: command.confirmationRounds + 1,
  });
  let unavailable = false;
  for (let i = 0; i < options.observationAttempts; i++) {
    if (i > 0)
      await bounded(
        new Promise((resolve) => setTimeout(resolve, options.intervalMs)),
      );
    check();
    try {
      const status = await bounded(
        readStatus(db, env, account, vehicle, spin, { safeErrors: true }),
      );
      check();
      const fetchedAt = options.now();
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
      const prior = x.vehicles.getCurrentState(vehicle.id);
      if (prior !== null) state.climate = prior.state.climate;
      const fresh =
        status.rvsUpdatedAt !== null &&
        command.submittedAt !== null &&
        status.rvsUpdatedAt >= command.submittedAt &&
        (command.baselineSourceAt === null ||
          status.rvsUpdatedAt > command.baselineSourceAt);
      x.vehicles.saveState(vehicle.id, state, fetchedAt);
      update({
        observation: {
          lock: state.security.lock,
          fetchedAt,
          sourceUpdatedAt: status.rvsUpdatedAt,
          vehicleDataFresh: fresh,
        },
        statusReads: command.statusReads + 1,
      });
      if (fresh)
        return update({
          status: "confirmed",
          completedAt: options.now(),
          failureCode: null,
          evidenceBasis: "wake_freshness",
        });
    } catch {
      check();
      unavailable = true;
    }
  }
  return update({
    status:
      unavailable || command.acceptedAt === null ? "unknown" : "timed_out",
    completedAt: options.now(),
    failureCode:
      unavailable || command.acceptedAt === null
        ? "confirmation_unavailable"
        : "confirmation_timeout",
  });
}
