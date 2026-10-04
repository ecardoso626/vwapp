export type AuthFailureCode =
  | "malformed"
  | "invalid_signature"
  | "unknown_device"
  | "revoked_device"
  | "stale"
  | "url_mismatch"
  | "method_mismatch"
  | "payload_mismatch"
  | "replay"
  | "rate_limited"
  | "pairing_invalid";

/** Internal reason only; HTTP responses expose a small, stable status surface. */
export class AuthFailure extends Error {
  readonly code: AuthFailureCode;

  constructor(code: AuthFailureCode) {
    super(code);
    this.code = code;
  }
}
