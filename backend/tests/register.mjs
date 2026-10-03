// Loaded before test modules. Protocol code only uses fetch, and every fetch
// must be claimed by the deterministic test queue below. No fallback exists.
import { register } from "node:module";

globalThis.fetch = async (url) => {
  throw new Error(`Unexpected network request: ${String(url)}`);
};

// Node strips TypeScript types, but this repository uses bundler-style
// extensionless local imports. This small resolver lets tests import the exact
// production modules without bundling or editing them.
register("./resolve-ts.mjs", import.meta.url);
