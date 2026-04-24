/**
 * MCP Bridge for TREK — eliminates protocol mismatch.
 *
 * Problem: Claude Code uses stateless HTTP MCP. TREK uses session-based MCP.
 * A raw HTTP proxy forwards the protocol mismatch. This bridge terminates
 * both protocols independently:
 *
 *   Claude Code → stateless HTTP MCP → this bridge → persistent MCP client → TREK
 *
 * Server side: one Server + transport per request (stateless, same as all 9 working MCP servers)
 * Client side: persistent MCP Client session with TREK (auto-reconnects on expiry)
 *
 * Tools are fetched from TREK dynamically — no hardcoded tool definitions.
 * Auth token stays inside this container. Claude Code never sees it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── Configuration ──────────────────────────────────────────
const PORT = Number(process.env["PORT"]) || 8911;
const SECRETS_DIR = process.env["SECRETS_DIR"] || "/secrets";
const TREK_URL = process.env["TREK_URL"] || "http://host.docker.internal:8910";

// Read TREK API token from file (NEVER from env var)
function loadTrekToken(): string {
  const tokenPath = resolve(SECRETS_DIR, "trek-token");
  try {
    const token = readFileSync(tokenPath, "utf-8").trim();
    if (token.length === 0) throw new Error("Empty");
    return token;
  } catch {
    throw new Error("Failed to load TREK API token. Check secrets mount.");
  }
}

const TREK_TOKEN = loadTrekToken();

// ── TREK Client (persistent session) ──────────────────────
let trekClient: Client | null = null;
let trekInstructions: string | undefined;

async function connectToTrek(): Promise<Client> {
  const client = new Client(
    { name: "mcp-trek-bridge", version: "0.2.0" },
    { capabilities: {} },
  );

  const transport = new StreamableHTTPClientTransport(
    new URL(`${TREK_URL}/mcp`),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${TREK_TOKEN}` },
      },
    },
  );

  await client.connect(transport);
  console.log("[mcp-trek] Connected to TREK MCP");
  return client;
}

async function getTrekClient(): Promise<Client> {
  if (!trekClient) {
    trekClient = await connectToTrek();
  }
  return trekClient;
}

async function reconnectTrek(): Promise<Client> {
  if (trekClient) {
    try {
      await trekClient.close();
    } catch { /* ignore close errors */ }
  }
  trekClient = await connectToTrek();
  return trekClient;
}

// ── Server factory (one per request, stateless) ───────────

function createServer(): Server {
  const server = new Server(
    { name: "mcp-trek", version: "0.2.0" },
    {
      capabilities: { tools: {} },
      instructions: trekInstructions,
    },
  );

  // Forward tools/list → TREK
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const client = await getTrekClient();
    return await client.listTools(request.params);
  });

  // Forward tools/call → TREK (with one reconnect retry)
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const client = await getTrekClient();
    try {
      return await client.callTool(request.params);
    } catch {
      // Session may have expired — reconnect and retry once
      const reconnected = await reconnectTrek();
      return await reconnected.callTool(request.params);
    }
  });

  return server;
}

// ── Rate Limiter ──────────────────────────────────────────
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
const requestTimestamps: number[] = [];

function isRateLimited(): boolean {
  const now = Date.now();
  while (requestTimestamps.length > 0 && requestTimestamps[0]! < now - RATE_WINDOW_MS) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= RATE_LIMIT) return true;
  requestTimestamps.push(now);
  return false;
}

// ── Health Check ──────────────────────────────────────────

async function healthCheck(): Promise<Response> {
  try {
    const client = await getTrekClient();
    const { tools } = await client.listTools();
    return new Response(
      JSON.stringify({
        status: "ok",
        service: "mcp-trek",
        port: PORT,
        trek: "connected",
        tools: tools.length,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch {
    return new Response(
      JSON.stringify({
        status: "degraded",
        service: "mcp-trek",
        port: PORT,
        trek: "disconnected",
      }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }
}

// ── HTTP Server ───────────────────────────────────────────

const httpServer = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") return healthCheck();

    if (url.pathname === "/mcp") {
      if (isRateLimited()) {
        return new Response("Too Many Requests", { status: 429 });
      }
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless — same as all working MCP servers
      });
      const server = createServer();
      await server.connect(transport);
      return transport.handleRequest(req);
    }

    return new Response("Not Found", { status: 404 });
  },
});

// ── Startup ───────────────────────────────────────────────

async function startup() {
  const MAX_RETRIES = 12;
  const RETRY_DELAY = 5_000; // 5s — TREK MCP init takes ~3min after API start

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      trekClient = await connectToTrek();
      const { tools } = await trekClient.listTools();
      console.log(`[mcp-trek] TREK tools loaded: ${tools.length} tools available`);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      console.log(`[mcp-trek] TREK not ready (attempt ${i + 1}/${MAX_RETRIES}): ${msg}`);
      trekClient = null;
      if (i < MAX_RETRIES - 1) await new Promise((r) => setTimeout(r, RETRY_DELAY));
    }
  }
  console.error("[mcp-trek] Failed to connect to TREK after retries. Will retry on first request.");
}

console.log(`mcp-trek bridge listening on http://0.0.0.0:${PORT}/mcp`);
console.log(`Bridging to TREK at ${TREK_URL}/mcp`);
startup();

process.on("SIGTERM", () => {
  httpServer.stop();
  if (trekClient) trekClient.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  httpServer.stop();
  if (trekClient) trekClient.close();
  process.exit(0);
});
