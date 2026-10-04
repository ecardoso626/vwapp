/** Keeping a stored VW account's tokens usable (refresh or re-login). */
import {
  saveCarnetToken,
  updateTokens,
  type Db,
  type StoredAccount,
} from "./application-store";
import { unseal } from "./crypto";
import type { AppEnv } from "./env";
import {
  jwtExpiryMs,
  VwAuthError,
  vwLogin,
  vwMintSpinSession,
  vwRefresh,
  type VwTokens,
} from "./vw/client";

/**
 * Get fresh VW tokens, refreshing / re-logging-in as needed, and persist them.
 *
 * Every transition logs an `[auth]` line: full password logins are VW's
 * throttled resource (~8-10 in quick succession locks the account out for a
 * while), so the log must show exactly when one happened and what triggered
 * it. Never log credentials or tokens — account ids only.
 */
export async function reauth(
  db: Db,
  env: AppEnv,
  account: StoredAccount,
  forceRelogin: boolean,
  safeErrors = false,
): Promise<VwTokens> {
  let tokens: VwTokens | null = null;
  // VW's refresh grant now also requires the original login code_verifier, so a
  // session stored without one can't refresh — go straight to a full login
  // (which re-stores a verifier).
  if (
    !forceRelogin &&
    account.tokens.refreshToken !== null &&
    account.tokens.codeVerifier !== null
  ) {
    try {
      tokens = await vwRefresh(
        account.tokens.refreshToken,
        account.tokens.codeVerifier,
      );
      console.log(`[auth] account=${account.id} token refresh ok`);
    } catch (err) {
      console.log(
        `[auth] account=${account.id} token refresh failed (${safeErrors ? "authentication failed" : err instanceof Error ? err.message : "unknown"})`,
      );
    }
  }
  if (tokens === null) {
    const trigger = forceRelogin
      ? "forced"
      : account.tokens.refreshToken === null
        ? "no refresh token"
        : account.tokens.codeVerifier === null
          ? "no code_verifier"
          : "refresh failed";
    console.log(
      `[auth] account=${account.id} VW password login (trigger=${trigger})`,
    );
    const credsJson = await unseal(env.CREDS_ENC_KEY, account.sealed);
    const creds = JSON.parse(credsJson) as {
      username: string;
      password: string;
    };
    try {
      tokens = await vwLogin(creds.username, creds.password);
      console.log(`[auth] account=${account.id} VW password login ok`);
    } catch (err) {
      console.error(
        `[auth] account=${account.id} VW password login FAILED: ${safeErrors ? "authentication failed" : err instanceof Error ? err.message : "unknown"}`,
      );
      throw err;
    }
  }
  await updateTokens(db, account.id, tokens);
  return tokens;
}

/** The stored tokens if the access token is still valid, else a fresh set. */
export async function ensureTokens(
  db: Db,
  env: AppEnv,
  account: StoredAccount,
  safeErrors = false,
): Promise<VwTokens> {
  if (account.tokens.expiresAt > Date.now() + 60_000) return account.tokens;
  return reauth(db, env, account, false, safeErrors);
}

/** Re-mint this long before a cached carnet token actually expires. */
const CARNET_MARGIN_MS = 3 * 60_000;
/** Fallback lifetime if the minted token carries no `exp` (VW's is 30 min). */
const CARNET_FALLBACK_TTL_MS = 25 * 60_000;

/**
 * A usable per-vehicle carnet (S-PIN session) token, minted only when the
 * cached one is missing or near expiry.
 *
 * VW now gates the *status reads* behind this token (see vwGetStatus), so the
 * every-minute cron would otherwise mint one per tick — 60 S-PIN challenges an
 * hour against an endpoint whose `remainingTries` counter guards a lockout that
 * needs a dealer reset. VW's tokens live 30 minutes, so caching them on the
 * account cuts that to ~2/hour/vehicle. Pass `force` after a 401 to bypass the
 * cache and re-mint.
 */
export async function ensureCarnetToken(
  db: Db,
  env: AppEnv,
  account: StoredAccount,
  uuid: string,
  spin: string,
  opts: { force?: boolean; safeErrors?: boolean } = {},
): Promise<string> {
  const cached = account.carnetTokens[uuid];
  if (
    opts.force !== true &&
    cached !== undefined &&
    cached.expiresAt > Date.now() + CARNET_MARGIN_MS
  )
    return cached.token;

  const tokens = await ensureTokens(db, env, account, opts.safeErrors);
  let token: string;
  try {
    token = await vwMintSpinSession(tokens, uuid, spin);
  } catch (err) {
    // Access token died between the expiry check and the mint — re-login once.
    if (!(err instanceof VwAuthError)) throw err;
    token = await vwMintSpinSession(
      await reauth(db, env, account, true, opts.safeErrors),
      uuid,
      spin,
    );
  }
  const expiresAt = jwtExpiryMs(token) ?? Date.now() + CARNET_FALLBACK_TTL_MS;
  await saveCarnetToken(db, account, uuid, { token, expiresAt });
  console.log(
    `[auth] account=${account.id} vehicle=${uuid} minted carnet token (expires ${new Date(expiresAt).toISOString()})`,
  );
  return token;
}
