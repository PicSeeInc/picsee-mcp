# Contributing

Thank you for helping improve the PicSee MCP Server.

## Before opening an issue

- Check existing issues for duplicates.
- Confirm the issue still occurs against `https://api.picsee.io/mcp`.
- Remove access tokens, private URLs, account identifiers, and analytics data.

## Development setup

```bash
pnpm install
pnpm check
pnpm dev
```

## Pull requests

- Keep changes focused and explain the user impact.
- Add or update tests for behavior changes.
- Update README and tool descriptions when capabilities change.
- Keep `package.json`, `server.json`, and MCP runtime versions aligned.
- Do not commit credentials, access tokens, deployment secrets, or production customer data.

By submitting a contribution, you agree that it may be distributed under the repository's license.
