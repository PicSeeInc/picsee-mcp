import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { PicSeeClient } from "./picsee-client.ts";
import { registerTools } from "./tools.ts";
import { FetchTransport } from "./transport.ts";

const MCP_BASE_PATH = "/mcp";
const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

function isMcpPath(pathname: string): boolean {
  return pathname === MCP_BASE_PATH || pathname.startsWith(`${MCP_BASE_PATH}/`);
}

/**
 * Returns the Bearer token sent by the client, or `null` if none was provided
 * (and no fallback is configured). A non-null return — including the env
 * fallback — means "process the request"; null means "challenge for OAuth".
 */
function extractAccessToken(request: Request, env: Env): string | null {
  const auth = request.headers.get("Authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    const token = m?.[1]?.trim();
    if (token) return token;
  }
  if (env.FALLBACK_ACCESS_TOKEN) return env.FALLBACK_ACCESS_TOKEN;
  return null;
}

function resourceMetadataUrl(request: Request): string {
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}${RESOURCE_METADATA_PATH}`;
}

function buildResourceMetadata(request: Request, env: Env): Record<string, unknown> {
  const u = new URL(request.url);
  // Per RFC 8707, the resource identifier is the canonical URI of the MCP
  // endpoint — not just the host — so clients (Claude, etc.) bind their
  // access tokens to this exact endpoint.
  const resource = `${u.protocol}//${u.host}${MCP_BASE_PATH}`;
  return {
    resource,
    authorization_servers: [env.OAUTH_AUTHORIZATION_SERVER],
    bearer_methods_supported: ["header"],
    scopes_supported: ["user:read", "user:write"],
    resource_documentation: "https://picsee.io/developers",
  };
}

function unauthorizedResponse(request: Request, description: string): Response {
  // RFC 9728 / MCP spec: surface the resource-metadata URL so the client can
  // discover which Authorization Server to use for the OAuth flow.
  const wwwAuthenticate = `Bearer realm="picsee-mcp", error="invalid_token", error_description="${description}", resource_metadata="${resourceMetadataUrl(request)}"`;
  return new Response(
    JSON.stringify({ error: "invalid_token", error_description: description }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": wwwAuthenticate,
      },
    },
  );
}

function createServer(env: Env, accessToken: string): McpServer {
  const server = new McpServer({
    name: "PicSee Short Link MCP",
    version: "0.1.0",
  });
  const client = new PicSeeClient({
    baseUrl: env.PICSEE_API_BASE,
    accessToken,
  });
  registerTools(server, client);
  return server;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
): JSONRPCMessage {
  return { jsonrpc: "2.0", id: id as string | number, error: { code, message } };
}

async function handleMcpRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method === "GET" || request.method === "DELETE") {
    // Stateless server: no server-initiated streams and no session lifecycle.
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  const accessToken = extractAccessToken(request, env);
  if (accessToken === null) {
    return unauthorizedResponse(
      request,
      "Bearer access token required. Obtain one from the OAuth authorization server.",
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(rpcError(null, -32700, "Parse error"), 400);
  }

  const messages: JSONRPCMessage[] = Array.isArray(body)
    ? (body as JSONRPCMessage[])
    : [body as JSONRPCMessage];
  if (messages.length === 0) {
    return jsonResponse(rpcError(null, -32600, "Invalid Request"), 400);
  }

  const server = createServer(env, accessToken);
  const transport = new FetchTransport();
  await server.connect(transport);

  const responses: JSONRPCMessage[] = [];
  try {
    for (const msg of messages) {
      const reply = await transport.dispatch(msg);
      if (reply) responses.push(reply);
    }
  } finally {
    await server.close();
  }

  if (responses.length === 0) {
    // All inputs were notifications. Spec: respond 202 Accepted with no body.
    return new Response(null, { status: 202 });
  }

  const responseBody = Array.isArray(body) ? responses : responses[0];
  return jsonResponse(responseBody);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // RFC 9728 OAuth 2.0 Protected Resource Metadata. MCP clients fetch this
    // (URL discovered via the WWW-Authenticate header on a 401) to learn
    // which Authorization Server they should redirect the user to.
    if (url.pathname === RESOURCE_METADATA_PATH) {
      return jsonResponse(buildResourceMetadata(request, env));
    }

    if (isMcpPath(url.pathname)) {
      return handleMcpRequest(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};
