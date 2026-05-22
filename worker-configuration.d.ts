interface Env {
  PICSEE_API_BASE: string;
  FALLBACK_ACCESS_TOKEN: string;
  /**
   * OAuth Authorization Server that issues tokens accepted by this MCP server.
   * Surfaced via `WWW-Authenticate` and the resource-metadata document so MCP
   * clients can discover where to send users for the authorization flow.
   */
  OAUTH_AUTHORIZATION_SERVER: string;
}
