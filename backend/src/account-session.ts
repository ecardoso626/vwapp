/** Shared compare-first account-session orchestration. VW protocol operations are unchanged. */
import type { VehicleDTO } from "@vwapp/contract";
import {
  getAccountByUserKey,
  type Db,
  type StoredAccount,
} from "./application-store";
import { sha256Hex, timingSafeEqual, unseal } from "./crypto";
import type { AppEnv } from "./env";
import {
  VwAuthError,
  vwGetVehicles,
  vwLogin,
  vwRefresh,
  type VwTokens,
} from "./vw/client";

export class AccountAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountAuthenticationError";
  }
}

/**
 * One VW account = one vwAccounts row, shared by every client (app installs,
 * scripts) that logs in with it. The convergence key is a hash of the
 * normalized username, so a fresh guest identity attaches to the existing
 * session instead of creating a parallel one.
 */
function vwUserKey(username: string): Promise<string> {
  return sha256Hex(username.trim().toLowerCase());
}

/** Compare digests, never the raw secrets (and never log either). */
async function storedPasswordMatches(
  env: AppEnv,
  account: StoredAccount,
  password: string,
): Promise<boolean> {
  let stored;
  try {
    stored = JSON.parse(await unseal(env.CREDS_ENC_KEY, account.sealed)) as {
      password?: string;
    };
  } catch {
    return false; // unreadable (e.g. sealed under an old key) — re-login and re-seal
  }
  if (stored.password === undefined) return false;
  // Compare fixed-length digests in constant time: never `===` on the raw
  // secret (length leak) nor on the digests (the positional-timing leak this
  // avoids), even though both are already in memory here.
  return timingSafeEqual(
    await sha256Hex(stored.password),
    await sha256Hex(password),
  );
}

/**
 * Prove the saved VW session still works: a real garage call with the stored
 * access token, refreshing first when it's expired or rejected. Returns null
 * when VW accepts neither token — the caller then does a full password login.
 * (Any verification failure falls back the same way; vwLogin is the
 * authoritative judge of the submitted credentials.)
 */
async function verifySavedSession(
  account: StoredAccount,
): Promise<{ tokens: VwTokens; vehicles: VehicleDTO[] } | null> {
  const { tokens } = account;
  if (tokens.expiresAt > Date.now() + 60_000) {
    try {
      return { tokens, vehicles: await vwGetVehicles(tokens.accessToken) };
    } catch {
      // fall through to a refresh attempt
    }
  }
  // Refresh now also requires the original login code_verifier; without one
  // (older stored session) a refresh can't succeed — force a full login.
  if (tokens.refreshToken === null || tokens.codeVerifier === null) return null;
  try {
    const fresh = await vwRefresh(tokens.refreshToken, tokens.codeVerifier);
    return { tokens: fresh, vehicles: await vwGetVehicles(fresh.accessToken) };
  } catch {
    return null;
  }
}

/**
 * Resolve a working VW session for these credentials WITHOUT persisting or
 * attaching anything. Compare-first: when a stored account's password matches
 * AND its saved tokens still work against VW, reuse them with no (throttled) VW
 * password login; otherwise authenticate for real. Throws UNAUTHORIZED on bad
 * credentials. Each branch logs its decision — the difference between "reuse, no
 * VW traffic" and "full password login" is invisible to the client but is
 * exactly what a login-failure postmortem needs. Shared by `checkCredentials`
 * (validate + cache the session) and `login` (which also seals the S-PIN and
 * attaches the client).
 */
export async function establishSession(
  context: { env: AppEnv; db: Db },
  username: string,
  password: string,
  safeErrors = false,
): Promise<{ userKey: string; tokens: VwTokens; vehicles: VehicleDTO[] }> {
  const userKey = await vwUserKey(username);
  let existing: StoredAccount | null;
  try {
    existing = await getAccountByUserKey(context.db, userKey);
  } catch (error) {
    // Node can repair an incomplete session using explicitly submitted/stored
    // credentials. An authenticated-envelope failure still fails closed.
    if (
      !safeErrors ||
      !(error instanceof Error) ||
      error.message !== "Stored VW account is incomplete"
    )
      throw error;
    existing = null;
  }
  let session: { tokens: VwTokens; vehicles: VehicleDTO[] } | null = null;
  if (
    existing !== null &&
    (await storedPasswordMatches(context.env, existing, password))
  ) {
    session = await verifySavedSession(existing);
    console.log(
      `[auth] account=${existing.id}: digest match, saved session ${
        session !== null
          ? "verified — reusing with no VW login"
          : "dead — full login required"
      }`,
    );
  } else {
    console.log(
      `[auth] ${existing === null ? "no stored account for this user key" : `account=${existing.id} digest mismatch`} — full VW login`,
    );
  }

  // No session, changed/wrong password, or dead tokens: authenticate with VW
  // for real.
  if (session === null) {
    let tokens;
    try {
      tokens = await vwLogin(username, password);
      console.log(`[auth] VW password login ok`);
    } catch (err) {
      console.error(
        `[auth] VW password login FAILED: ${safeErrors ? "authentication failed" : err instanceof Error ? err.message : "unknown"}`,
      );
      if (err instanceof VwAuthError)
        throw new AccountAuthenticationError(
          safeErrors ? "Volkswagen authentication failed" : err.message,
        );
      throw err;
    }
    session = { tokens, vehicles: await vwGetVehicles(tokens.accessToken) };
  }
  return { userKey, tokens: session.tokens, vehicles: session.vehicles };
}

/** The S-PIN currently sealed for this account, if any (and still unsealable). */
export async function storedSpin(
  env: AppEnv,
  account: StoredAccount | null,
): Promise<string | undefined> {
  if (account === null) return undefined;
  try {
    const creds = JSON.parse(
      await unseal(env.CREDS_ENC_KEY, account.sealed),
    ) as {
      spin?: string;
    };
    return creds.spin;
  } catch {
    return undefined;
  }
}
