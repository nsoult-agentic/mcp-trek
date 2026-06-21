import { describe, test, expect } from "bun:test";

import {
  RATE_LIMIT,
  RATE_WINDOW_MS,
  pruneAndCheckRateLimit,
  isTokenFresh,
  computeExpiresAt,
  buildClientCredentialsBody,
  TOKEN_REFRESH_SKEW_MS,
  DEFAULT_TOKEN_TTL_S,
  type CachedToken,
} from "../src/bridge-logic.js";

// Expected values below are derived independently from the module's own
// constants (RATE_LIMIT, RATE_WINDOW_MS, TOKEN_REFRESH_SKEW_MS, …), never by
// echoing whatever the implementation happens to return, so a logic regression
// is actually caught.

describe("pruneAndCheckRateLimit — sliding window", () => {
  test("first request on an empty window is accepted and recorded", () => {
    const ts: number[] = [];
    expect(pruneAndCheckRateLimit(ts, 1_000, 3, 10_000)).toBe(false);
    expect(ts).toEqual([1_000]);
  });

  test("accepts exactly `limit` requests, rejects the next", () => {
    const ts: number[] = [];
    const limit = 3;
    // limit requests all within one window → all accepted
    for (let i = 0; i < limit; i++) {
      expect(pruneAndCheckRateLimit(ts, 1_000 + i, limit, 10_000)).toBe(false);
    }
    expect(ts.length).toBe(limit);
    // the (limit+1)-th within the window is rejected and NOT recorded
    expect(pruneAndCheckRateLimit(ts, 1_005, limit, 10_000)).toBe(true);
    expect(ts.length).toBe(limit);
  });

  test("entries strictly older than the window are pruned before counting", () => {
    const limit = 2;
    const windowMs = 10_000;
    // two timestamps that are exactly windowMs and more behind `now`
    const ts = [0, 1];
    const now = 10_001; // cutoff = now - windowMs = 1; entries < 1 are dropped → only [0] dropped
    // After prune: [1] remains (1 is not < 1). length 1 < limit → accepted, push now.
    expect(pruneAndCheckRateLimit(ts, now, limit, windowMs)).toBe(false);
    expect(ts).toEqual([1, 10_001]);
  });

  test("boundary: entry exactly at the cutoff (now - windowMs) is kept", () => {
    const limit = 1;
    const windowMs = 10_000;
    const ts = [5_000];
    const now = 15_000; // cutoff = 5_000; 5_000 is NOT < 5_000 → kept
    // length 1 >= limit 1 → rejected
    expect(pruneAndCheckRateLimit(ts, now, limit, windowMs)).toBe(true);
    expect(ts).toEqual([5_000]);
  });

  test("entry one ms past the cutoff is pruned, freeing a slot", () => {
    const limit = 1;
    const windowMs = 10_000;
    const ts = [4_999];
    const now = 15_000; // cutoff = 5_000; 4_999 < 5_000 → pruned
    expect(pruneAndCheckRateLimit(ts, now, limit, windowMs)).toBe(false);
    expect(ts).toEqual([15_000]);
  });

  test("a full window drains over time and recovers capacity", () => {
    const limit = 2;
    const windowMs = 1_000;
    const ts: number[] = [];
    expect(pruneAndCheckRateLimit(ts, 0, limit, windowMs)).toBe(false);
    expect(pruneAndCheckRateLimit(ts, 100, limit, windowMs)).toBe(false);
    // saturated at t=200
    expect(pruneAndCheckRateLimit(ts, 200, limit, windowMs)).toBe(true);
    // jump past the window of both prior entries → both pruned, accepted again
    expect(pruneAndCheckRateLimit(ts, 1_200, limit, windowMs)).toBe(false);
    expect(ts).toEqual([1_200]);
  });

  test("defaults to module RATE_LIMIT / RATE_WINDOW_MS", () => {
    const ts: number[] = [];
    for (let i = 0; i < RATE_LIMIT; i++) {
      expect(pruneAndCheckRateLimit(ts, 1_000 + i)).toBe(false);
    }
    // one more inside the default window is limited
    expect(pruneAndCheckRateLimit(ts, 1_000 + RATE_LIMIT)).toBe(true);
    // after the default window fully passes, capacity returns
    expect(pruneAndCheckRateLimit(ts, 1_000 + RATE_WINDOW_MS + 1)).toBe(false);
  });
});

describe("isTokenFresh", () => {
  const make = (expiresAt: number): CachedToken => ({ value: "tok", expiresAt });

  test("null cache is never fresh", () => {
    expect(isTokenFresh(null, 0)).toBe(false);
  });

  test("fresh when expiry is more than the skew ahead of now", () => {
    const now = 1_000_000;
    // expiry exactly skew+1 ahead → strictly greater than now+skew → fresh
    expect(isTokenFresh(make(now + TOKEN_REFRESH_SKEW_MS + 1), now)).toBe(true);
  });

  test("NOT fresh at exactly now + skew (strict comparison)", () => {
    const now = 1_000_000;
    expect(isTokenFresh(make(now + TOKEN_REFRESH_SKEW_MS), now)).toBe(false);
  });

  test("stale when expiry is within the skew window", () => {
    const now = 1_000_000;
    expect(isTokenFresh(make(now + TOKEN_REFRESH_SKEW_MS - 1), now)).toBe(false);
  });

  test("already-expired token is stale", () => {
    expect(isTokenFresh(make(500), 1_000)).toBe(false);
  });

  test("honors a custom skew", () => {
    const now = 0;
    expect(isTokenFresh(make(5_001), now, 5_000)).toBe(true);
    expect(isTokenFresh(make(5_000), now, 5_000)).toBe(false);
  });
});

describe("computeExpiresAt", () => {
  test("uses server-reported expires_in (seconds → ms) added to now", () => {
    // now=10_000ms, expires_in=120s → 10_000 + 120*1000 = 130_000
    expect(computeExpiresAt(10_000, 120)).toBe(130_000);
  });

  test("falls back to the default TTL when expires_in is undefined", () => {
    // 0 + DEFAULT_TOKEN_TTL_S*1000
    expect(computeExpiresAt(0, undefined)).toBe(DEFAULT_TOKEN_TTL_S * 1000);
  });

  test("expires_in of 0 is honored (not treated as missing)", () => {
    // 0 ?? default → 0, so result is exactly `now`
    expect(computeExpiresAt(5_000, 0)).toBe(5_000);
  });

  test("honors a custom default TTL", () => {
    expect(computeExpiresAt(1_000, undefined, 10)).toBe(1_000 + 10_000);
  });
});

describe("buildClientCredentialsBody", () => {
  test("encodes the client_credentials grant with id and secret", () => {
    const body = buildClientCredentialsBody("cid", "shh");
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_id")).toBe("cid");
    expect(body.get("client_secret")).toBe("shh");
  });

  test("omits scope by default", () => {
    const body = buildClientCredentialsBody("cid", "shh");
    expect(body.has("scope")).toBe(false);
  });

  test("includes scope when a non-empty override is given", () => {
    const body = buildClientCredentialsBody("cid", "shh", "trips:read places:read");
    expect(body.get("scope")).toBe("trips:read places:read");
  });

  test("treats an empty-string scope as absent", () => {
    const body = buildClientCredentialsBody("cid", "shh", "");
    expect(body.has("scope")).toBe(false);
  });

  test("produces standard urlencoded output (spaces as +)", () => {
    const body = buildClientCredentialsBody("cid", "shh", "a b");
    // URLSearchParams encodes spaces as "+"
    expect(body.toString()).toContain("scope=a+b");
    expect(body.toString()).toContain("grant_type=client_credentials");
  });
});

describe("module constants sanity", () => {
  test("rate limit and window are positive", () => {
    expect(RATE_LIMIT).toBeGreaterThan(0);
    expect(RATE_WINDOW_MS).toBeGreaterThan(0);
  });

  test("refresh skew is shorter than the default token lifetime", () => {
    // otherwise every freshly issued token would already be considered stale
    expect(TOKEN_REFRESH_SKEW_MS).toBeLessThan(DEFAULT_TOKEN_TTL_S * 1000);
  });
});
