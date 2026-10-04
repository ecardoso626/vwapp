import { requireBuzzKey } from "@/buzzkey-native";
import { useQuery } from "@tanstack/react-query";
import type { PassiveVehicle, VehicleState } from "@vwapp/contract";

/** Server cache reads are intentionally independent of the VW polling cadence. */
const POLL_MS = 45_000;
export const passiveKeys = {
  owner: ["buzzkey", "owner"] as const,
  vehicles: ["buzzkey", "vehicles"] as const,
  messages: ["buzzkey", "messages"] as const,
  history: (id: string) => ["buzzkey", "history", id] as const,
};

export function usePassiveOwner() {
  return useQuery({
    queryKey: passiveKeys.owner,
    queryFn: () => requireBuzzKey().owner(),
    retry: 1,
    refetchInterval: POLL_MS,
  });
}

export function usePassiveVehicles() {
  return useQuery({
    queryKey: passiveKeys.vehicles,
    queryFn: () => requireBuzzKey().vehicles(),
    staleTime: 20_000,
    refetchInterval: POLL_MS,
  });
}

export function usePassiveMessages() {
  return useQuery({
    queryKey: passiveKeys.messages,
    queryFn: () => requireBuzzKey().messages(),
    staleTime: 20_000,
    refetchInterval: POLL_MS,
  });
}

export function usePassiveHistory(vehicleId: string | undefined) {
  return useQuery({
    queryKey: passiveKeys.history(vehicleId ?? ""),
    queryFn: () => requireBuzzKey().history(vehicleId ?? "", 100),
    enabled: vehicleId !== undefined,
    staleTime: 30_000,
  });
}

/** A screen-specific view of the normalized domain state, never a VW payload. */
export interface PassiveSnapshot {
  soc: number | null;
  rangeKm: number | null;
  odometerKm: number | null;
  chargeState: VehicleState["battery"]["charging"];
  chargePowerKw: number | null;
  minutesToFull: number | null;
  pluggedIn: boolean | null;
  plugLocked: boolean | null;
  targetSoc: number | null;
  locked: boolean | null;
  openDoors: string[] | null;
  openWindows: string[] | null;
  unlockedDoors: string[] | null;
  parkedLat: number | null;
  parkedLng: number | null;
  parkedAt: number | null;
  capturedAt: number | null;
  rvsUpdatedAt: number | null;
  doorsUpdatedAt: number | null;
  locksUpdatedAt: number | null;
  windowsUpdatedAt: number | null;
  chargeUpdatedAt: number | null;
  createdAt: number;
  fetchedAt: number;
}

export function stateToSnapshot(
  state: VehicleState,
  persistedAt: number,
): PassiveSnapshot {
  return {
    soc: state.battery.socPercent,
    rangeKm: state.battery.estimatedRangeKm,
    odometerKm: state.odometerKm,
    chargeState: state.battery.charging,
    chargePowerKw: state.battery.chargePowerKw,
    minutesToFull: state.battery.minutesToFull,
    pluggedIn: state.battery.pluggedIn,
    plugLocked: state.battery.plugLocked,
    targetSoc: state.battery.targetSocPercent,
    locked:
      state.security.lock === "unknown"
        ? null
        : state.security.lock === "locked",
    openDoors: state.security.openDoors,
    openWindows: state.security.openWindows,
    unlockedDoors: state.security.unlockedDoors,
    parkedLat: state.location?.latitude ?? null,
    parkedLng: state.location?.longitude ?? null,
    parkedAt: state.location?.parkedAt ?? null,
    capturedAt: state.freshness.sourceCapturedAt,
    rvsUpdatedAt: state.freshness.rvsUpdatedAt,
    doorsUpdatedAt: state.freshness.doorsUpdatedAt,
    locksUpdatedAt: state.freshness.locksUpdatedAt,
    windowsUpdatedAt: state.freshness.windowsUpdatedAt,
    chargeUpdatedAt: state.freshness.chargeUpdatedAt,
    createdAt: persistedAt,
    fetchedAt: state.freshness.fetchedAt,
  };
}

export function passiveVehicleIdentity(vehicle: PassiveVehicle) {
  return {
    id: vehicle.id,
    uuid: vehicle.identity.reference,
    vin: vehicle.identity.vin,
    nickname: vehicle.identity.name,
    model: vehicle.identity.model,
  };
}

export function useFirstPassiveVehicle() {
  const vehiclesQuery = usePassiveVehicles();
  const passiveVehicle = vehiclesQuery.data?.vehicles[0];
  return {
    vehiclesQuery,
    passiveVehicle,
    vehicle:
      passiveVehicle === undefined
        ? undefined
        : passiveVehicleIdentity(passiveVehicle),
    snapshot:
      passiveVehicle?.current === null || passiveVehicle === undefined
        ? undefined
        : stateToSnapshot(
            passiveVehicle.current.state,
            passiveVehicle.current.persistedAt,
          ),
  };
}
