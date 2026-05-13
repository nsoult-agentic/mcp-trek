/**
 * OAuth 2.1 PKCE token flow for TREK.
 *
 * Usage: bun run scripts/get-token.ts
 *
 * 1. Dynamically registers an OAuth client with TREK
 * 2. Opens browser to TREK's auth page
 * 3. Listens on localhost:9876 for the redirect
 * 4. Exchanges auth code for tokens
 * 5. Prints the access token (copy to secrets file)
 *
 * Requires: bun (uses Bun.serve for callback server)
 */

import { randomBytes, createHash } from "node:crypto";

const TREK_BASE = process.env["TREK_URL"] || "https://trek.stabpablo.eu";
const CALLBACK_PORT = 9876;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;
const SCOPES = [
  "trips:read", "trips:write", "trips:delete", "trips:share",
  "places:read", "places:write",
  "atlas:read", "atlas:write",
  "packing:read", "packing:write",
  "todos:read", "todos:write",
  "budget:read", "budget:write",
  "reservations:read", "reservations:write",
  "collab:read", "collab:write",
  "notifications:read", "notifications:write",
  "vacay:read", "vacay:write",
  "geo:read", "weather:read",
  "journey:read", "journey:write", "journey:share",
].join(" ");

// ── PKCE ──────────────────────────────────────────────────
function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ── Dynamic Client Registration ───────────────────────────
async function registerClient(): Promise<{ client_id: string }> {
  const resp = await fetch(`${TREK_BASE}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "mcp-trek-token-helper",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Client registration failed: ${resp.status} ${body}`);
  }

  return resp.json();
}

// ── Token Exchange ────────────────────────────────────────
async function exchangeCode(
  code: string,
  clientId: string,
  codeVerifier: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const resp = await fetch(`${TREK_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: codeVerifier,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Token exchange failed: ${resp.status} ${body}`);
  }

  return resp.json();
}

// ── Main Flow ─────────────────────────────────────────────
async function main() {
  console.log("=== TREK OAuth Token Helper ===\n");

  // 1. Register client
  console.log("1. Registering OAuth client...");
  const { client_id } = await registerClient();
  console.log(`   Client ID: ${client_id}\n`);

  // 2. Generate PKCE
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  // 3. Build auth URL
  const state = randomBytes(16).toString("hex");
  const authUrl = new URL(`${TREK_BASE}/oauth/authorize`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", client_id);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  // 4. Start callback server
  console.log("2. Starting callback server on port", CALLBACK_PORT);

  let resolveToken: (token: string) => void;
  const tokenPromise = new Promise<string>((resolve) => {
    resolveToken = resolve;
  });

  const server = Bun.serve({
    port: CALLBACK_PORT,
    hostname: "127.0.0.1",
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname !== "/callback") {
        return new Response("Not found", { status: 404 });
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        const desc = url.searchParams.get("error_description") || error;
        return new Response(
          `<h1>Authorization Failed</h1><p>${desc}</p>`,
          { headers: { "Content-Type": "text/html" } },
        );
      }

      if (!code || returnedState !== state) {
        return new Response(
          "<h1>Invalid callback</h1><p>Missing code or state mismatch.</p>",
          { headers: { "Content-Type": "text/html" } },
        );
      }

      try {
        const tokens = await exchangeCode(code, client_id, codeVerifier);
        resolveToken!(tokens.access_token);

        return new Response(
          `<h1>Success!</h1><p>Token obtained. You can close this tab.</p>`,
          { headers: { "Content-Type": "text/html" } },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown error";
        return new Response(
          `<h1>Token Exchange Failed</h1><p>${msg}</p>`,
          { headers: { "Content-Type": "text/html" } },
        );
      }
    },
  });

  console.log(`\n3. Open this URL in your browser to authorize:\n`);
  console.log(`   ${authUrl.toString()}\n`);
  console.log("   Waiting for authorization...\n");

  // 5. Wait for token
  const accessToken = await tokenPromise;

  console.log("=== TOKEN OBTAINED ===\n");
  console.log(`Access Token:\n${accessToken}\n`);
  console.log("Save this token to the appropriate secrets file:");
  console.log("  /srv/mcp-trek/secrets/trek-token-lucy\n");

  server.stop();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
