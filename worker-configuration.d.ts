interface Env {
  PICSEE_API_BASE: string;
  /**
   * Shared anonymous-mode token. Stored as a Worker secret (set with
   * `wrangler secret put FALLBACK_ACCESS_TOKEN`, or in `.dev.vars` locally).
   * Undefined when the secret is unset — anonymous mode is disabled and
   * unauthenticated callers get a 401 / OAuth challenge.
   */
  FALLBACK_ACCESS_TOKEN?: string;
  /**
   * OAuth Authorization Server that issues tokens accepted by this MCP server.
   * Surfaced via `WWW-Authenticate` and the resource-metadata document so MCP
   * clients can discover where to send users for the authorization flow.
   */
  OAUTH_AUTHORIZATION_SERVER: string;
}
