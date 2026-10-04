import assert from "node:assert/strict";
import { test } from "node:test";
import {
  controlLabel,
  ControlSubmissions,
  prepareControlIntent,
  readControlIntent,
} from "../../../app/src/control-intent.ts";

const input = {
  vehicleId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  action: "charge_target",
  targetSoc: 80,
};
const key = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
test("mobile control persists nonsecret intent before send and restores same key after network loss", async () => {
  let value = null;
  const storage = {
    get: async () => value,
    set: async (next) => {
      value = next;
    },
    clear: async () => {
      value = null;
    },
  };
  const first = await prepareControlIntent(storage, input, () => key);
  assert.deepEqual(await readControlIntent(storage), first);
  assert.deepEqual(
    await prepareControlIntent(storage, input, () => {
      throw Error("new key");
    }),
    first,
  );
  await assert.rejects(
    prepareControlIntent(storage, { ...input, targetSoc: 90 }, () => key),
    /previous/,
  );
  assert.equal(value.includes("token"), false);
});
test("concurrent mobile control taps coalesce and conflicting tap is rejected", async () => {
  const coordinator = new ControlSubmissions();
  let count = 0;
  const run = async () => {
    count++;
    return { status: "requested" };
  };
  const first = coordinator.run("synthetic", input, run);
  assert.equal(first, coordinator.run("synthetic", input, run));
  await assert.rejects(
    coordinator.run("synthetic", { ...input, targetSoc: 90 }, run),
  );
  await first;
  assert.equal(count, 1);
});
test("all uncertain command presentations avoid success labels", () => {
  assert.equal(
    controlLabel(
      { status: "confirmed", evidenceBasis: "local_schedule" },
      false,
    ),
    "Schedule updated",
  );
  assert.equal(
    controlLabel(
      { status: "confirmed", evidenceBasis: "wake_freshness" },
      false,
    ),
    "Fresh vehicle data received",
  );
  for (const status of [
    "accepted",
    "waiting_for_vehicle",
    "unknown",
    "timed_out",
    "failed",
  ])
    assert.doesNotMatch(controlLabel({ status }, false), /^Confirmed/);
});

test("mobile entry/import graph uses only the Node client for control, account, passive read and map", async () => {
  const { readFileSync, existsSync, readdirSync } = await import("node:fs");
  const { resolve, dirname } = await import("node:path");
  const root = resolve(import.meta.dirname, "../../../app/src");
  const seen = new Set();
  const visit = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(
      source,
      /from\s+["'](?:@\/rpc|@\/db|@instantdb\/|@\/providers\/legacy-control-provider)/,
      path,
    );
    for (const match of source.matchAll(
      /(?:from\s+|import\s*)["']([^"']+)["']/g,
    )) {
      const ref = match[1];
      let base = ref.startsWith("@/")
        ? resolve(root, ref.slice(2))
        : ref.startsWith(".")
          ? resolve(dirname(path), ref)
          : null;
      if (base === null) continue;
      for (const candidate of [
        base,
        base + ".ts",
        base + ".tsx",
        base + "/index.ts",
      ]) {
        if (existsSync(candidate) && /\.(ts|tsx)$/.test(candidate)) {
          visit(candidate);
          break;
        }
      }
    }
  };
  for (const file of readdirSync(resolve(root, "app"), { recursive: true })) {
    if (typeof file === "string" && /\.(ts|tsx)$/.test(file))
      visit(resolve(root, "app", file));
  }
  assert.ok(seen.size > 20);
  const controls =
    readFileSync(resolve(root, "components/charge-control.tsx"), "utf8") +
    readFileSync(resolve(root, "components/climate-control.tsx"), "utf8") +
    readFileSync(resolve(root, "app/(app)/updates.tsx"), "utf8");
  for (const action of [
    "charge_start",
    "charge_stop",
    "charge_target",
    "climate_stop",
    "wake",
  ])
    assert.ok(controls.includes(action));
});
