/** Closed-vocabulary auth diagnostics: never emit URLs, headers, bodies or errors. */
export type AuthStage =
  | "authorize"
  | "identifier_form"
  | "identifier"
  | "password_form"
  | "password"
  | "callback"
  | "token_exchange"
  | "token_response"
  | "refresh_token"
  | "garage"
  | "spin_challenge"
  | "spin_session";
export type AuthFailureCode =
  | "auth_authorize_failed"
  | "auth_identifier_form_changed"
  | "auth_identifier_rejected"
  | "auth_password_form_changed"
  | "auth_credentials_rejected"
  | "auth_redirect_failed"
  | "auth_code_missing"
  | "auth_token_exchange_failed"
  | "auth_attestation_rejected"
  | "auth_protocol_changed"
  | "auth_network_failed"
  | "auth_account_action_required"
  | "auth_throttled"
  | "auth_login_budget_exhausted"
  | "auth_garage_failed"
  | "auth_spin_failed";
export class PasswordLoginBudgetError extends Error {
  constructor() {
    super("Password login budget exhausted or unavailable");
  }
}
let passwordLoginGuard: (() => void) | undefined;
export function setPasswordLoginGuard(guard: (() => void) | undefined): void {
  passwordLoginGuard = guard;
}
export function consumePasswordLogin(): void {
  passwordLoginGuard?.();
}

const diagnostics = new WeakMap<
  object,
  { stage: AuthStage; code: AuthFailureCode; status: number | null }
>();
export function authDiagnostic(
  error: unknown,
):
  | { stage: AuthStage; code: AuthFailureCode; status: number | null }
  | undefined {
  return error instanceof Error ? diagnostics.get(error) : undefined;
}
function endpoint(url: string): { host: string; path: string } {
  const u = new URL(url);
  const host = [
    "b-h-s.spr.us00.p.con-veh.net",
    "identity.na.vwgroup.io",
  ].includes(u.hostname)
    ? u.hostname
    : "other";
  let path = "<redacted>";
  if (host !== "other") {
    if (
      ["/oidc/v1/authorize", "/oidc/v1/token", "/account/v1/garage"].includes(
        u.pathname,
      )
    )
      path = u.pathname;
    else if (
      /^\/signin-service\/v1\/[^/]+\/login\/(identifier|authenticate)$/.test(
        u.pathname,
      )
    )
      path = u.pathname.endsWith("/identifier")
        ? "/signin-service/v1/:client/login/identifier"
        : "/signin-service/v1/:client/login/authenticate";
    else if (/^\/ss\/v1\/user\/[^/]+\/challenge$/.test(u.pathname))
      path = "/ss/v1/user/:user/challenge";
    else if (
      /^\/ss\/v1\/user\/[^/]+\/vehicle\/[^/]+\/session$/.test(u.pathname)
    )
      path = "/ss/v1/user/:user/vehicle/:vehicle/session";
  }
  return { host, path };
}

export class AuthTrace {
  stage: AuthStage;
  private status: number | null = null;
  private host = "none";
  private path = "none";
  private networkFailed = false;
  private attestationRejected = false;
  private readonly started = Date.now();
  constructor(stage: AuthStage) {
    this.stage = stage;
  }
  private emit(
    event: "response" | "elements" | "callback" | "success" | "failure",
    extra: Record<string, unknown> = {},
  ): void {
    console.info(
      "[vw-auth]",
      JSON.stringify({
        stage: this.stage,
        event,
        host: this.host,
        path: this.path,
        status: this.status,
        elapsedMs: Math.max(0, Date.now() - this.started),
        ...extra,
      }),
    );
  }
  elements(fields: {
    csrf: boolean;
    hmac: boolean;
    relayState?: boolean;
  }): void {
    this.emit("elements", { fields });
  }
  callback(): void {
    this.emit("callback");
  }
  success(): void {
    this.emit("success");
  }
  async fetch(
    url: string,
    init: RequestInit,
    redirectCount = 0,
  ): Promise<Response> {
    const ep = endpoint(url);
    this.host = ep.host;
    this.path = ep.path;
    this.status = null;
    this.networkFailed = false;
    let response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      this.networkFailed = true;
      throw error;
    }
    this.status = response.status;
    const type = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      ?.trim()
      .toLowerCase();
    const contentType =
      type === "application/json"
        ? "json"
        : type === "text/html" || type === "application/xhtml+xml"
          ? "html"
          : "other";
    this.emit("response", {
      redirectCount,
      contentType,
      ...(this.stage === "token_exchange" || this.stage === "refresh_token"
        ? { attestation: "placeholder" }
        : {}),
    });
    return response;
  }
  /** Inspect only a bounded error body; return no raw text or dynamic code. */
  async tokenFailure(response: Response): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const read = async (): Promise<void> => {
        let text = "";
        let size = 0;
        const decoder = new TextDecoder();
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.length;
          if (size > 16_384) return;
          text += decoder.decode(item.value, { stream: true });
        }
        text += decoder.decode();
        const body = JSON.parse(text) as {
          error?: unknown;
          errorCode?: unknown;
        };
        // Generic INVALID_REQUEST/401 is deliberately NOT evidence of attestation.
        this.attestationRejected = [body.error, body.errorCode].some(
          (v) =>
            v === "PLAY_INTEGRITY_TOKEN_INVALID" ||
            v === "INVALID_PLAY_INTEGRITY_TOKEN" ||
            v === "ATTESTATION_FAILED",
        );
      };
      await Promise.race([
        read(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1000);
        }),
      ]);
    } catch {
      /* Diagnostic parsing never changes the original HTTP failure. */
    } finally {
      clearTimeout(timer);
      void reader.cancel().catch(() => undefined);
    }
  }

  failure(error: unknown): void {
    const message = error instanceof Error ? error.message : "";
    let code: AuthFailureCode = "auth_protocol_changed";
    if (error instanceof PasswordLoginBudgetError)
      code = "auth_login_budget_exhausted";
    else if (this.networkFailed) code = "auth_network_failed";
    else if (this.attestationRejected) code = "auth_attestation_rejected";
    else if (message === "Wrong email or password.")
      code = "auth_credentials_rejected";
    else if (
      message === "VW login throttled — wait and retry." ||
      this.status === 429
    )
      code = "auth_throttled";
    else if (
      message ===
      "VW requires you to accept new Terms & Conditions in the myVW app first."
    )
      code = "auth_account_action_required";
    else if (
      /^redirect \d+ without Location$/.test(message) ||
      message === "too many redirects"
    )
      code = "auth_redirect_failed";
    else if (
      this.stage === "authorize" ||
      (this.stage === "identifier_form" &&
        this.status !== null &&
        this.status >= 400)
    )
      code = "auth_authorize_failed";
    else if (this.stage === "identifier_form")
      code = "auth_identifier_form_changed";
    else if (
      this.stage === "identifier" ||
      (this.stage === "password_form" &&
        this.status !== null &&
        this.status >= 400)
    )
      code = "auth_identifier_rejected";
    else if (this.stage === "password_form")
      code = "auth_password_form_changed";
    else if (this.stage === "password") code = "auth_redirect_failed";
    else if (this.stage === "callback") code = "auth_code_missing";
    else if (this.stage === "token_exchange" || this.stage === "refresh_token")
      code = "auth_token_exchange_failed";
    else if (this.stage === "garage") code = "auth_garage_failed";
    else if (this.stage === "spin_challenge" || this.stage === "spin_session")
      code = "auth_spin_failed";
    const value = { stage: this.stage, code, status: this.status };
    if (error instanceof Error) diagnostics.set(error, value);
    this.emit("failure", {
      code,
      errorClass:
        error instanceof PasswordLoginBudgetError
          ? "budget"
          : error instanceof TypeError
            ? "type_error"
            : error instanceof Error
              ? "error"
              : "non_error",
    });
  }
}
