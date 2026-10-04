// Bump the app version: `pnpm run version patch|minor|major` (default patch).
// app.json `expo.version` is what ships;
// package.json `version` is kept in sync for consistency.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const part = process.argv[2] ?? "patch";
const index = ["major", "minor", "patch"].indexOf(part);
if (index === -1) {
  console.error(`Usage: pnpm run version [major|minor|patch] (got "${part}")`);
  process.exit(1);
}

const appJsonPath = join(appDir, "app.json");
const appJson = JSON.parse(readFileSync(appJsonPath, "utf8")) as {
  expo: { version: string };
};
const current = appJson.expo.version;

const parts = current.split(".").map(Number);
if (parts.length !== 3 || parts.some(Number.isNaN)) {
  console.error(`app.json expo.version "${current}" is not semver`);
  process.exit(1);
}
// Bump the chosen part, zero the lower ones — no index mutation so this stays
// clean under noUncheckedIndexedAccess.
const next = parts
  .map((n, i) => (i < index ? n : i === index ? n + 1 : 0))
  .join(".");

appJson.expo.version = next;
writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2) + "\n");

const pkgJsonPath = join(appDir, "package.json");
const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
  version: string;
};
pkgJson.version = next;
writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");

console.log(`${current} -> ${next}`);
