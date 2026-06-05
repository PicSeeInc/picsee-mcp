import { Buffer } from "node:buffer";
import { handleRequest } from "./index.ts";

/**
 * AWS Lambda entrypoint for the PicSee MCP server.
 *
 * The same runtime-agnostic router that powers the Cloudflare Worker
 * (`handleRequest`) runs here unchanged. This module only translates between
 * AWS's event/response envelopes and the standard Web `Request`/`Response`
 * objects the router speaks — and sources `Env` from `process.env` instead of
 * a Worker binding.
 *
 * Supports both the API Gateway HTTP API / Lambda Function URL payload
 * format 2.0 and the older REST API / HTTP API format 1.0. `fetch`, `Request`,
 * `Response` and `URL` are all global on the Lambda Node.js 18+ runtimes, so
 * no polyfills are needed.
 */

// Minimal structural types for the two API Gateway payload formats we accept.
// We deliberately avoid a dependency on `@types/aws-lambda` for the runtime
// bundle; the shapes used here are stable parts of the public contract.
interface EventV2 {
  version: "2.0";
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: {
    http: { method: string; path?: string };
    domainName?: string;
  };
}

interface EventV1 {
  httpMethod: string;
  path: string;
  multiValueQueryStringParameters?: Record<string, string[] | undefined> | null;
  queryStringParameters?: Record<string, string | undefined> | null;
  headers?: Record<string, string | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
}

type LambdaEvent = EventV2 | EventV1;

interface LambdaResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
}

function buildEnv(): Env {
  const base = process.env.PICSEE_API_BASE ?? "https://api.pics.ee";
  const authServer =
    process.env.OAUTH_AUTHORIZATION_SERVER ??
    "https://public-api-oauth.picsee.io";
  return {
    PICSEE_API_BASE: base,
    OAUTH_AUTHORIZATION_SERVER: authServer,
    // Undefined when unset — disables anonymous mode, same as an unset Worker
    // secret. Configure via the Lambda environment variables / a secret store.
    FALLBACK_ACCESS_TOKEN: process.env.FALLBACK_ACCESS_TOKEN,
  };
}

function isV2(event: LambdaEvent): event is EventV2 {
  return (event as EventV2).version === "2.0";
}

/** Decode the request body, honoring base64 encoding from API Gateway. */
function decodeBody(
  body: string | null | undefined,
  isBase64Encoded: boolean | undefined,
): string | undefined {
  if (body == null) return undefined;
  return isBase64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
}

function eventToRequest(event: LambdaEvent): Request {
  let method: string;
  let path: string;
  let queryString: string;
  const headers = new Headers();

  if (isV2(event)) {
    method = event.requestContext.http.method;
    path = event.rawPath || "/";
    queryString = event.rawQueryString ? `?${event.rawQueryString}` : "";
    for (const [k, v] of Object.entries(event.headers ?? {})) {
      if (v !== undefined) headers.set(k, v);
    }
    if (event.cookies?.length) headers.set("cookie", event.cookies.join("; "));
  } else {
    method = event.httpMethod;
    path = event.path || "/";
    const params = new URLSearchParams();
    if (event.multiValueQueryStringParameters) {
      for (const [k, vs] of Object.entries(
        event.multiValueQueryStringParameters,
      )) {
        for (const v of vs ?? []) params.append(k, v);
      }
    } else if (event.queryStringParameters) {
      for (const [k, v] of Object.entries(event.queryStringParameters)) {
        if (v !== undefined) params.append(k, v);
      }
    }
    const qs = params.toString();
    queryString = qs ? `?${qs}` : "";
    for (const [k, v] of Object.entries(event.headers ?? {})) {
      if (v !== undefined) headers.set(k, v);
    }
  }

  const host = headers.get("host") ?? "localhost";
  const proto = headers.get("x-forwarded-proto") ?? "https";
  const url = `${proto}://${host}${path}${queryString}`;

  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody
    ? decodeBody(event.body, event.isBase64Encoded)
    : undefined;

  return new Request(url, {
    method,
    headers,
    body: body ?? null,
  });
}

async function responseToResult(response: Response): Promise<LambdaResult> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = await response.text();
  return {
    statusCode: response.status,
    headers,
    body,
    isBase64Encoded: false,
  };
}

export async function handler(event: LambdaEvent): Promise<LambdaResult> {
  const request = eventToRequest(event);
  const response = await handleRequest(request, buildEnv());
  return responseToResult(response);
}
