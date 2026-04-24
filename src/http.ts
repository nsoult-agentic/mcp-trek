/**
 * MCP proxy for TREK — auth boundary isolation.
 * Proxies MCP requests to TREK's native /mcp endpoint.
 *
 * TREK has 150+ native MCP tools. This server does NOT reimplement them.
 * It accepts MCP requests from Claude Code, injects the TREK API token
 * (stored inside this container), and forwards to TREK.
 *
 * This follows the established PAI MCP pattern:
 *   Claude Code → mcp-trek (bearer auth) → TREK (internal token)
 *   Secrets stay inside the container. Claude Code never sees TREK_TOKEN.
 *
 * Usage: PORT=8911 SECRETS_DIR=/secrets TREK_URL=http://host.docker.internal:8910 bun run src/http.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Configuration ──────────────────────────────────────────
const PORT = Number(process.env["PORT"]) || 8911;
const SECRETS_DIR = process.env["SECRETS_DIR"] || "/secrets";
const TREK_URL = process.env["TREK_URL"] || "http://host.docker.internal:8910";

// Read TREK API token from file (NEVER from env var)
function loadTrekToken(): string {
  const tokenPath = resolve(SECRETS_DIR, "trek-token");
  try {
    const token = readFileSync(tokenPath, "utf-8").trim();
    if (token.length === 0) {
      throw new Error("TREK token file is empty");
    }
    return token;
  } catch {
    throw new Error("Failed to load TREK API token. Check secrets mount.");
  }
}

const TREK_TOKEN = loadTrekToken();

// ── Rate Limiter ──────────────────────────────────────────
const RATE_LIMIT = 30; // max requests per window
const RATE_WINDOW_MS = 60_000; // 1 minute
const requestTimestamps: number[] = [];

function isRateLimited(): boolean {
  const now = Date.now();
  while (requestTimestamps.length > 0 && requestTimestamps[0] < now - RATE_WINDOW_MS) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= RATE_LIMIT) return true;
  requestTimestamps.push(now);
  return false;
}

// ── Proxy ─────────────────────────────────────────────────

const MAX_BODY_SIZE = 1_048_576; // 1MB — MCP payloads are small JSON

async function proxyToTrek(req: Request): Promise<Response> {
  const trekMcpUrl = `${TREK_URL}/mcp`;

  try {
    const outHeaders: Record<string, string> = {
      "Authorization": `Bearer ${TREK_TOKEN}`,
      "Accept": req.headers.get("Accept") || "application/json, text/event-stream",
    };
    const sessionId = req.headers.get("Mcp-Session-Id");
    if (sessionId) outHeaders["Mcp-Session-Id"] = sessionId;

    // Only read body for POST; enforce 1MB size limit to prevent OOM
    let body: ArrayBuffer | undefined;
    if (req.method === "POST") {
      const contentLength = Number(req.headers.get("Content-Length") || "0");
      if (contentLength > MAX_BODY_SIZE) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Payload too large" }, id: null }),
          { status: 413, headers: { "Content-Type": "application/json" } },
        );
      }
      body = await req.arrayBuffer();
      if (body.byteLength > MAX_BODY_SIZE) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Payload too large" }, id: null }),
          { status: 413, headers: { "Content-Type": "application/json" } },
        );
      }
      outHeaders["Content-Type"] = req.headers.get("Content-Type") || "application/json";
    }

    // POST: 30s timeout (request/response). GET/DELETE: no timeout (SSE streams are long-lived).
    const signal = req.method === "POST" ? AbortSignal.timeout(30_000) : undefined;

    const trekRes = await fetch(trekMcpUrl, {
      method: req.method,
      headers: outHeaders,
      body,
      signal,
    });

    // Forward the response as-is, preserving streaming + session header
    const resHeaders: Record<string, string> = {
      "Content-Type": trekRes.headers.get("Content-Type") || "application/json",
    };
    const resSessionId = trekRes.headers.get("Mcp-Session-Id");
    if (resSessionId) resHeaders["Mcp-Session-Id"] = resSessionId;

    return new Response(trekRes.body, {
      status: trekRes.status,
      statusText: trekRes.statusText,
      headers: resHeaders,
    });
  } catch (err) {
    console.error("[mcp-trek] Proxy error:", err instanceof Error ? err.message : "unknown");
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "TREK upstream unavailable" }, id: null }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
}

// ── HTTP Server ───────────────────────────────────────────

const httpServer = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      // Quick health check — verify we can reach TREK
      try {
        const trekHealth = await fetch(`${TREK_URL}/api/health`, {
          signal: AbortSignal.timeout(5_000),
        });
        return new Response(
          JSON.stringify({
            status: "ok",
            service: "mcp-trek",
            port: PORT,
            trek_upstream: trekHealth.ok ? "ok" : `error:${trekHealth.status}`,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      } catch {
        return new Response(
          JSON.stringify({
            status: "degraded",
            service: "mcp-trek",
            port: PORT,
            trek_upstream: "unreachable",
          }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    if (url.pathname === "/mcp") {
      if (isRateLimited()) {
        return new Response("Rate limit exceeded", { status: 429 });
      }
      return proxyToTrek(req);
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`mcp-trek proxy listening on http://0.0.0.0:${PORT}/mcp`);
console.log(`Proxying to TREK at ${TREK_URL}/mcp`);

process.on("SIGTERM", () => {
  httpServer.stop();
  process.exit(0);
});

process.on("SIGINT", () => {
  httpServer.stop();
  process.exit(0);
});
