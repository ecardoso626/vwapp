import { closeSync, openSync } from "node:fs";
import { PasswordLoginBudgetError } from "../src/vw/auth-diagnostics";

/** An exclusive persistent marker caps this diagnostic milestone across restarts. */
export function onePasswordLogin(marker: string): () => void {
  return () => {
    try {
      const fd = openSync(marker, "wx", 0o600);
      closeSync(fd);
    } catch {
      // Existing marker, bad permissions or I/O failure all fail closed.
      throw new PasswordLoginBudgetError();
    }
  };
}
