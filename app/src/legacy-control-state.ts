import type { AccountConnection } from "@vwapp/contract/account";

/** Both exact protocol reference and VIN must match the authorized legacy view. */
export function matchingLegacyVehicle(
  connection: AccountConnection | undefined,
  nodeVehicle: { uuid: string; vin: string } | undefined,
  loggedIn: boolean,
  legacyVehicles: readonly { id: string; uuid: string; vin: string }[],
) {
  if (
    connection?.linked !== true ||
    connection.state !== "connected" ||
    connection.session !== "usable" ||
    nodeVehicle === undefined ||
    !loggedIn
  )
    return undefined;
  return legacyVehicles.find(
    (vehicle) =>
      vehicle.uuid === nodeVehicle.uuid && vehicle.vin === nodeVehicle.vin,
  );
}
