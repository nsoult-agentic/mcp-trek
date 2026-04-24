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

async function proxyToTrek(req: Request): Promise<Response> {
  const trekMcpUrl = `${TREK_URL}/mcp`;

  try {
    const body = await req.arrayBuffer();

    const outHeaders: Record<string, string> = {
      "Content-Type": req.headers.get("Content-Type") || "application/json",
      "Authorization": `Bearer ${TREK_TOKEN}`,
      "Accept": req.headers.get("Accept") || "application/json, text/event-stream",
    };
    const sessionId = req.headers.get("Mcp-Session-Id");
    if (sessionId) outHeaders["Mcp-Session-Id"] = sessionId;

    const trekRes = await fetch(trekMcpUrl, {
      method: req.method,
      headers: outHeaders,
      body: body.byteLength > 0 ? body : undefined,
      signal: AbortSignal.timeout(30_000),
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
