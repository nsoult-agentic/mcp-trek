/**
 * Pure, deterministic bridge logic — extracted from http.ts so it can be unit
 * tested without booting the HTTP server or opening a network connection.
 *
 * Every function here is a pure function of its arguments: no module-global
 * mutation beyond the array the caller passes in, no I/O, no reliance on the
 * ambient clock (the caller injects `now`). http.ts wires these to its real
 * state and `Date.now()`, so runtime behavior is unchanged.
 */

// ── Rate limiter (sliding window) ──────────────────────────

/** Default request budget per window, mirrored by http.ts. */
export const RATE_LIMIT = 30;
/** Default window length in milliseconds, mirrored by http.ts. */
export const RATE_WINDOW_MS = 60_000;

/**
 * Sliding-window rate-limit check. Mutates `timestamps` in place exactly as the
 * original inline loop did: drops entries older than the window, then either
 * rejects (at/over the limit) or records `now` and accepts.
 *
 * @returns true if the request should be rejected (limited), false if accepted.
 */
export function pruneAndCheckRateLimit(
  timestamps: number[],
  now: number,
  limit: number = RATE_LIMIT,
  windowMs: number = RATE_WINDOW_MS,
): boolean {
  while (timestamps.length > 0 && (timestamps[0] as number) < now - windowMs) {
    timestamps.shift();
  }
  if (timestamps.length >= limit) return true;
  timestamps.push(now);
  return false;
}

// ── OAuth token cache ──────────────────────────────────────

export interface CachedToken {
  value: string;
  expiresAt: number;
}

/** How long before nominal expiry a cached token is treated as stale (ms). */
export const TOKEN_REFRESH_SKEW_MS = 60_000;

/** Fallback token lifetime (seconds) when the server omits `expires_in`. */
export const DEFAULT_TOKEN_TTL_S = 3600;

/**
 * True when the cached token may still be reused: it exists and its expiry is
 * more than the refresh skew into the future relative to `now`.
 */
export function isTokenFresh(
  cached: CachedToken | null,
  now: number,
  skewMs: number = TOKEN_REFRESH_SKEW_MS,
): cached is CachedToken {
  return cached !== null && cached.expiresAt > now + skewMs;
}

/**
 * Absolute expiry timestamp for a freshly issued token, given when it was
 * issued (`now`) and the server-reported lifetime in seconds (defaulting when
 * absent).
 */
export function computeExpiresAt(
  now: number,
  expiresInSeconds: number | undefined,
  defaultTtlSeconds: number = DEFAULT_TOKEN_TTL_S,
): number {
  return now + (expiresInSeconds ?? defaultTtlSeconds) * 1000;
}

// ── OAuth request body ─────────────────────────────────────

/**
 * Build the form body for an OAuth 2.1 `client_credentials` token request.
 * `scope` is included only when a non-empty override is supplied, matching the
 * "omit by default so TREK issues the full registered scope set" behavior.
 */
export function buildClientCredentialsBody(
  clientId: string,
  clientSecret: string,
  scope?: string,
): URLSearchParams {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  if (scope) body.set("scope", scope);
  return body;
}
