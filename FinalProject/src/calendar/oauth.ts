import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { GoogleCalendarConfig } from "./config.js";
import { CalendarError } from "./errors.js";
import { calendarFetch, calendarJson, type CalendarHttpDependencies } from "./http.js";

export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/calendar.freebusy",
] as const;
export const OAuthTokensSchema = z.object({
  refreshToken: z.string().min(1).max(8192),
  accessToken: z.string().min(1).max(8192).optional(),
  expiresAt: z.number().finite().optional(),
}).strict();
export type OAuthTokens = z.infer<typeof OAuthTokensSchema>;
export interface OAuthTokenStore {
  load(): Promise<OAuthTokens | undefined>;
  save(tokens: OAuthTokens): Promise<void>;
  clear(): Promise<void>;
}
export interface CalendarAccessTokenSource { getAccessToken(forceRefresh?: boolean): Promise<string> }
export interface GoogleOAuthDependencies extends CalendarHttpDependencies {
  tokens: OAuthTokenStore;
  clock?: () => Date;
}
const tokenResponse = z.object({
  access_token: z.string().min(1).max(8192), token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive().max(86_400),
  refresh_token: z.string().min(1).max(8192).optional(),
  scope: z.string().optional(),
});
interface AuthorizationAttempt { binding: string; verifier: string; expiresAt: number }

export class GoogleOAuthClient implements CalendarAccessTokenSource {
  private readonly attempts = new Map<string, AuthorizationAttempt>();
  private refreshInFlight?: Promise<string>;
  private revoked = false;
  private readonly clock: () => Date;
  constructor(private readonly config: GoogleCalendarConfig, private readonly dependencies: GoogleOAuthDependencies) {
    this.clock = dependencies.clock ?? (() => new Date());
  }

  beginAuthorization(operatorSessionBinding: string): { authorizationUrl: string; expiresAt: string } {
    if (!operatorSessionBinding || operatorSessionBinding.length > 1024) {
      throw new CalendarError("CALENDAR_OAUTH_STATE_INVALID", "An authenticated operator session is required.", 400);
    }
    const now = this.clock().getTime();
    for (const [state, attempt] of this.attempts) if (attempt.expiresAt <= now) this.attempts.delete(state);
    if (this.attempts.size >= 16) throw new CalendarError("CALENDAR_OAUTH_BUSY", "Too many pending calendar setup requests.", 429);
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const expiresAt = now + 10 * 60_000;
    this.attempts.set(state, {
      binding: createHash("sha256").update(operatorSessionBinding).digest("hex"), verifier, expiresAt,
    });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: this.config.clientId, redirect_uri: this.config.redirectUri,
      response_type: "code", scope: GOOGLE_CALENDAR_SCOPES.join(" "),
      state, code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256", access_type: "offline", prompt: "consent",
      include_granted_scopes: "false",
    }).toString();
    return { authorizationUrl: url.href, expiresAt: new Date(expiresAt).toISOString() };
  }

  async exchangeCallback(callbackUrl: string | URL, operatorSessionBinding: string): Promise<{ connected: true }> {
    let url: URL;
    try { url = new URL(callbackUrl); } catch { throw this.invalidState(); }
    const redirect = new URL(this.config.redirectUri);
    if (url.origin !== redirect.origin || url.pathname !== redirect.pathname || url.username || url.password || url.hash ||
        url.searchParams.getAll("state").length !== 1 || url.searchParams.getAll("code").length > 1) throw this.invalidState();
    const state = url.searchParams.get("state") ?? "";
    const attempt = this.attempts.get(state);
    this.attempts.delete(state);
    const binding = createHash("sha256").update(operatorSessionBinding).digest("hex");
    if (!attempt || attempt.expiresAt <= this.clock().getTime() ||
        !timingSafeEqual(Buffer.from(attempt.binding), Buffer.from(binding))) throw this.invalidState();
    if (url.searchParams.has("error")) {
      throw new CalendarError("CALENDAR_OAUTH_DENIED", "Calendar authorization was declined; reconnect from operator setup.", 400);
    }
    const code = url.searchParams.get("code");
    if (!code || code.length > 8192) throw this.invalidState();
    const tokens = await this.exchange({
      grant_type: "authorization_code", code, code_verifier: attempt.verifier, redirect_uri: this.config.redirectUri,
    });
    if (!tokens.refresh_token) {
      throw new CalendarError("CALENDAR_OAUTH_OFFLINE_REQUIRED", "Google did not grant offline access. Revoke the prior app grant and authorize again.", 503);
    }
    await this.saveTokens(tokens, tokens.refresh_token);
    this.revoked = false;
    return { connected: true };
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    if (this.revoked) throw this.reauthorizationRequired();
    if (this.refreshInFlight) return this.refreshInFlight;
    const operation = this.loadOrRefresh(forceRefresh);
    this.refreshInFlight = operation;
    try { return await operation; } finally { this.refreshInFlight = undefined; }
  }

  private async loadOrRefresh(force: boolean): Promise<string> {
    const stored = await this.dependencies.tokens.load();
    if (stored && !OAuthTokensSchema.safeParse(stored).success) {
      throw new CalendarError("CALENDAR_TOKEN_STORE_INVALID", "The private calendar credential store is invalid.", 503);
    }
    if (!force && stored?.accessToken && (stored.expiresAt ?? 0) > this.clock().getTime() + 60_000) return stored.accessToken;
    const refreshToken = stored?.refreshToken ?? this.config.refreshToken;
    if (!refreshToken) throw this.reauthorizationRequired();
    const result = await this.exchange({ grant_type: "refresh_token", refresh_token: refreshToken });
    await this.saveTokens(result, result.refresh_token ?? refreshToken);
    return result.access_token;
  }

  private async exchange(fields: Record<string, string>): Promise<z.infer<typeof tokenResponse>> {
    const response = await calendarFetch(this.dependencies, "https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, ...fields }).toString(),
    });
    const body = await calendarJson(response);
    if (!response.ok) {
      const error = z.object({ error: z.string() }).safeParse(body);
      if (error.success && error.data.error === "invalid_grant") {
        if (fields.grant_type === "refresh_token") {
          this.revoked = true;
          await this.dependencies.tokens.clear();
        }
        throw this.reauthorizationRequired();
      }
      throw new CalendarError("CALENDAR_OAUTH_FAILED", "Google authorization failed. Check operator credentials and granted scopes.", 503, response.status === 429 || response.status >= 500);
    }
    const parsed = tokenResponse.safeParse(body);
    if (!parsed.success) throw new CalendarError("CALENDAR_OAUTH_INVALID_RESPONSE", "Google returned an invalid authorization response.", 502);
    if (parsed.data.scope && GOOGLE_CALENDAR_SCOPES.some((scope) => !parsed.data.scope?.split(" ").includes(scope))) {
      throw new CalendarError("CALENDAR_OAUTH_SCOPE_REQUIRED", "Both owned-events and free/busy calendar permissions are required.", 503);
    }
    return parsed.data;
  }

  private async saveTokens(tokens: z.infer<typeof tokenResponse>, refreshToken: string): Promise<void> {
    await this.dependencies.tokens.save({
      refreshToken, accessToken: tokens.access_token, expiresAt: this.clock().getTime() + tokens.expires_in * 1000,
    });
  }
  private invalidState(): CalendarError {
    return new CalendarError("CALENDAR_OAUTH_STATE_INVALID", "Calendar setup expired or could not be verified; start again.", 400);
  }
  private reauthorizationRequired(): CalendarError {
    return new CalendarError("CALENDAR_REAUTHORIZATION_REQUIRED", "Connect or reauthorize the operator Google Calendar account.", 503);
  }
}
