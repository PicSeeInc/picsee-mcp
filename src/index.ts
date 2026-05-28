import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  PicSeeClient,
  parsePlanTier,
  type PicSeePlanTier,
} from "./picsee-client.ts";
import { registerTools } from "./tools.ts";
import { FetchTransport } from "./transport.ts";

const MCP_BASE_PATH = "/mcp";
const MCP_AUTH_PATH = "/mcp/auth";
const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
const RESOURCE_METADATA_AUTH_PATH = "/.well-known/oauth-protected-resource/mcp/auth";

function isMcpPath(pathname: string): boolean {
  return pathname === MCP_BASE_PATH || pathname.startsWith(`${MCP_BASE_PATH}/`);
}

// `/mcp/auth` is the OAuth-only endpoint: anonymous fallback is never used,
// so missing-Bearer requests always 401 and clients are forced through the
// OAuth flow. `/mcp` keeps the anonymous fallback when configured.
function requiresOAuth(pathname: string): boolean {
  return pathname === MCP_AUTH_PATH;
}

interface ResolvedToken {
  token: string;
  /**
   * True when the request did not present its own Bearer token and we fell
   * back to the env-configured shared token. Anonymous callers are restricted
   * to a reduced tool surface (URL shortening only).
   */
  anonymous: boolean;
}

/**
 * Returns the Bearer token sent by the client, or `null` if none was provided
 * (and no fallback is configured). A non-null return — including the env
 * fallback — means "process the request"; null means "challenge for OAuth".
 */
function extractAccessToken(
  request: Request,
  env: Env,
  allowFallback: boolean,
): ResolvedToken | null {
  const auth = request.headers.get("Authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    const token = m?.[1]?.trim();
    if (token) return { token, anonymous: false };
  }
  if (allowFallback && env.FALLBACK_ACCESS_TOKEN) {
    return { token: env.FALLBACK_ACCESS_TOKEN, anonymous: true };
  }
  return null;
}

function resourceMetadataUrl(request: Request, resourcePath: string): string {
  const u = new URL(request.url);
  const metadataPath =
    resourcePath === MCP_AUTH_PATH
      ? RESOURCE_METADATA_AUTH_PATH
      : RESOURCE_METADATA_PATH;
  return `${u.protocol}//${u.host}${metadataPath}`;
}

function buildResourceMetadata(
  request: Request,
  env: Env,
  resourcePath: string,
): Record<string, unknown> {
  const u = new URL(request.url);
  // Per RFC 8707, the resource identifier is the canonical URI of the MCP
  // endpoint — not just the host — so clients (Claude, etc.) bind their
  // access tokens to this exact endpoint.
  const resource = `${u.protocol}//${u.host}${resourcePath}`;
  return {
    resource,
    authorization_servers: [env.OAUTH_AUTHORIZATION_SERVER],
    bearer_methods_supported: ["header"],
    scopes_supported: ["user:read", "user:write"],
    resource_documentation: "https://picsee.io/developers",
  };
}

function unauthorizedResponse(
  request: Request,
  resourcePath: string,
  description: string,
): Response {
  // RFC 9728 / MCP spec: surface the resource-metadata URL so the client can
  // discover which Authorization Server to use for the OAuth flow.
  const wwwAuthenticate = `Bearer realm="picsee-mcp", error="invalid_token", error_description="${description}", resource_metadata="${resourceMetadataUrl(request, resourcePath)}"`;
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

/**
 * For authenticated callers, probe `GET /v2/my/api/status` so we can hide
 * Advanced-only tools from Free / Basic accounts (avoids the model burning
 * tokens on calls that would just return `PUB00201`). Failures fall back to
 * `free` — strictly fewer tools is the safer default than over-exposing.
 */
async function detectTier(
  client: PicSeeClient,
  resolved: ResolvedToken,
): Promise<PicSeePlanTier> {
  if (resolved.anonymous) return "anonymous";
  try {
    return parsePlanTier(await client.getApiStatus());
  } catch {
    return "free";
  }
}

async function createServer(
  env: Env,
  resolved: ResolvedToken,
): Promise<McpServer> {
  const server = new McpServer({
    name: "PicSee Short Link MCP",
    version: "0.1.0",
  });
  const client = new PicSeeClient({
    baseUrl: env.PICSEE_API_BASE,
    accessToken: resolved.token,
  });
  const tier = await detectTier(client, resolved);
  registerTools(server, client, { tier });
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

  const url = new URL(request.url);
  const resourcePath = requiresOAuth(url.pathname)
    ? MCP_AUTH_PATH
    : MCP_BASE_PATH;
  const allowFallback = !requiresOAuth(url.pathname);
  const accessToken = extractAccessToken(request, env, allowFallback);
  if (accessToken === null) {
    return unauthorizedResponse(
      request,
      resourcePath,
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

  const server = await createServer(env, accessToken);
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
      return jsonResponse(buildResourceMetadata(request, env, MCP_BASE_PATH));
    }
    if (url.pathname === RESOURCE_METADATA_AUTH_PATH) {
      return jsonResponse(buildResourceMetadata(request, env, MCP_AUTH_PATH));
    }

    if (isMcpPath(url.pathname)) {
      return handleMcpRequest(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};
