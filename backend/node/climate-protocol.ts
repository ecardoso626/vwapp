import {
  VwBusyError,
  vwClimateStart,
  vwClimateStop,
  vwGetClimate,
  vwGetClimateTargetTempF,
  vwSetClimateTemp,
} from "../src/vw/client";
import type { VwTokens } from "../src/vw/client";
import type { Execution } from "./control-executor";

export interface ClimateSupply {
  x: Execution;
  tokens(): VwTokens;
  mint(): Promise<string>;
  stage(value: string, correlation?: string): void;
}
/** Application sequence around the unchanged VW functions, including its busy budgets. */
export async function submitClimate(s: ClimateSupply): Promise<string | null> {
  const { x } = s;
  const action = x.command.action;
  const desired = x.command.parameters.tempF;
  const busy = async (
    stage: string,
    run: (authorization: string) => Promise<string>,
    attempts = 3,
  ) => {
    s.stage(stage);
    for (let i = 0; ; i++)
      try {
        const auth = await s.mint();
        x.check();
        if (!x.authorized()) throw Error("Device unavailable");
        const id = await x.bounded(run(auth));
        x.check();
        s.stage(stage, id);
        return id;
      } catch (error) {
        if (!(error instanceof VwBusyError) || i >= attempts - 1) throw error;
        await x.bounded(
          new Promise((resolve) =>
            setTimeout(resolve, x.options.intervalMs === 0 ? 0 : 5000),
          ),
        );
      }
  };
  if (action === "climate_stop")
    return busy("climate_stop", (auth) => vwClimateStop(auth, x.vehicle.uuid));
  if (desired === undefined) throw Error("Temperature missing");
  const current = await x.bounded(
    vwGetClimate(await s.mint(), s.tokens(), x.vehicle.uuid),
  );
  x.check();
  if (current.targetTempF !== desired) {
    if (current.on) {
      await busy("climate_stop", (auth) => vwClimateStop(auth, x.vehicle.uuid));
      const auth = await s.mint();
      let off = false;
      for (let i = 0; i < 5; i++) {
        const read = await x.bounded(
          vwGetClimate(auth, s.tokens(), x.vehicle.uuid),
        );
        x.check();
        if (!read.on && read.remainingMin === 0) {
          off = true;
          break;
        }
        await x.bounded(
          new Promise((resolve) => setTimeout(resolve, x.options.intervalMs)),
        );
      }
      if (!off) throw new Error("Climate off could not be established");
    }
    const id = await busy(
      "climate_temperature",
      (auth) => vwSetClimateTemp(auth, x.vehicle.uuid, desired),
      5,
    );
    if (action === "climate_temperature") return id;
    const auth = await s.mint();
    let applied = false;
    for (let i = 0; i < 8; i++) {
      const target = await x.bounded(
        vwGetClimateTargetTempF(auth, x.vehicle.uuid),
      );
      x.check();
      if (target === desired) {
        applied = true;
        break;
      }
      await x.bounded(
        new Promise((resolve) => setTimeout(resolve, x.options.intervalMs)),
      );
    }
    if (!applied) throw new Error("Temperature could not be established");
  }
  if (action === "climate_temperature") return null; // already observed requested setting
  if (current.on && current.targetTempF === desired) {
    s.stage("climate_already_running");
    return null; // redundant start cannot extend VW's timer
  }
  return busy("climate_start", (auth) => vwClimateStart(auth, x.vehicle.uuid));
}
