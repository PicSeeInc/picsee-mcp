# PicSee MCP Server

The official remote Model Context Protocol (MCP) server for [PicSee](https://picsee.io), a URL shortener with link management and click analytics.

Connect an AI agent to PicSee to create short links, manage existing links, and inspect click performance using natural language.

## Official MCP endpoint

```text
https://api.picsee.io/mcp
```

- Transport: Streamable HTTP
- Authentication: Anonymous or OAuth 2.1 with PKCE
- Registry name: `io.picsee/short-link`
- Official Registry: [MCP Registry](https://registry.modelcontextprotocol.io/?q=io.picsee%2Fshort-link)

## Capabilities

### Anonymous access

Anonymous clients can create a PicSee short link using the shared `pse.is` domain. Anonymous access does not expose account data, link lists, management tools, or analytics.

### Signed-in access

After signing in with PicSee OAuth, available tools depend on the account's API plan:

- Create short links using available PicSee or branded domains.
- Check API plan status and usage.
- List available domains, tags, and tracking tools.
- List, delete, or recover short links.
- View overview, daily clicks, device, referrer, and country analytics.
- Use Advanced-plan editing, search, metadata, tracking, and audience-label features when available.

The server dynamically exposes only the tools supported by the signed-in account.

## Install

### Codex

```bash
codex mcp add picsee --url https://api.picsee.io/mcp
```

Restart Codex after installation. To sign in for account management and analytics:

```bash
codex mcp login picsee
```

### Claude Desktop or another MCP client

Add the following Streamable HTTP server to the client's MCP configuration:

```json
{
  "mcpServers": {
    "picsee": {
      "url": "https://api.picsee.io/mcp"
    }
  }
}
```

If a client does not support remote Streamable HTTP directly, use an MCP remote bridge supported by that client.

## Example prompts

```text
Shorten https://picsee.io and attribute the API usage to Codex.
```

```text
Show my 10 most recent PicSee short links.
```

```text
Show daily clicks and referrer sources for short link abc123 over the last 30 days.
```

```text
Change the destination of abc123 to https://example.com/new-page.
```

Editing requires an eligible PicSee API plan.

## Authentication

PicSee uses OAuth 2.1 authorization code flow with PKCE and Dynamic Client Registration.

- Authorization server: `https://public-api-oauth.picsee.io`
- Protected resource: `https://api.picsee.io/mcp`
- Scopes: `user:read`, `user:write`

The MCP client stores the access and refresh tokens. This repository does not ask users to paste API tokens into prompts or configuration files.

### Why these scopes are requested

- `user:read`: Read the account's API status, domains, tags, short-link list, and analytics.
- `user:write`: Create, edit, delete, and recover short links when the account plan permits those actions.

## Tool availability

| Access level | Available tools |
| --- | --- |
| Anonymous | `create_short_link` |
| Signed in | `create_short_link`, `get_api_status`, `get_api_usage_by_external_id`, `get_my_domains`, `get_my_tags`, `get_my_tracking_tools`, `list_short_links`, `delete_short_link`, `get_link_overview`, `get_link_daily_clicks`, `get_link_platforms`, `get_link_referrers`, `get_link_regions` |
| Advanced plan | Signed-in tools plus `edit_short_link` and `get_link_audience_labels`; advanced fields and search filters are also enabled |

Tool availability is determined at connection time. Use your MCP client's tool inspector or `tools/list` to see the exact tools available to the current account.

## Privacy and security

- Never share PicSee access tokens in prompts, issues, screenshots, or logs.
- Review the destination URL before creating or editing a short link.
- Analytics may contain private campaign and audience information; share it only with intended recipients.
- OAuth permissions can be revoked from your PicSee account.

See [PicSee Privacy Notice](https://picsee.io/privacy) and [Terms of Use](https://picsee.io/policy).

## Documentation and support

- [MCP and Agent Skill guide](https://picsee.io/help/agent-skill)
- [PicSee API documentation](https://picsee.io/developers/docs/public-api.html)
- [PicSee Help Center](https://picsee.io/help/)
- [Report a technical issue](https://github.com/PicSeeInc/picsee-mcp/issues)

When reporting an issue, include the MCP client name, operation attempted, timestamp, and sanitized error message. Do not include access tokens or private analytics data.

## Development

Prerequisites:

- Node.js 22 or later
- pnpm

```bash
pnpm install
pnpm check
pnpm dev
```

Before releasing, verify that the version in `package.json`, `server.json`, and the MCP `initialize` response is identical.

## License

MIT © PicSee Inc.
