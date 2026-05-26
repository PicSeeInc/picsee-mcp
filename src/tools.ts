import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  TextContent,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  PicSeeApiError,
  PicSeeClient,
  type PicSeePlanTier,
} from "./picsee-client.ts";

const TIME_FORMAT_HINT = "Taipei time in `YYYY-MM-DDTHH:mm:ss` format.";

const TARGET_DEVICES = [
  "ios_android",
  "ios",
  "ios_store",
  "android",
  "android_store",
  "ios_line",
  "ios_safari",
  "android_fb",
  "pc_mac",
  "pc",
  "mac",
  "facebook",
  "twitter",
] as const;

const utmSchema = z
  .object({
    source: z.string().optional().describe("utm_source"),
    medium: z.string().optional().describe("utm_medium"),
    campaign: z.string().optional().describe("utm_campaign"),
    term: z.string().optional().describe("utm_term"),
    content: z.string().optional().describe("utm_content"),
  })
  .describe(
    "UTM parameters appended to the destination URL. Pass `null` on edit to clear all previously set UTM values.",
  );

const targetSchema = z.object({
  target: z
    .enum(TARGET_DEVICES)
    .describe(
      "Device / source bucket. `ios_android` = all mobile, `pc_mac` = all desktop. App-store buckets (`ios_store`, `android_store`) redirect installed-app users only.",
    ),
  url: z
    .string()
    .url()
    .describe("Destination URL for visitors matching this bucket."),
});

const pathFormatSchema = z.object({
  key: z
    .string()
    .describe(
      "Name of the GET parameter that decides the destination URL (Path Parameterization add-on, Advanced plan).",
    ),
});

function textResult(data: unknown): CallToolResult {
  const text: TextContent = {
    type: "text",
    text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
  };
  return { content: [text] };
}

function errorResult(message: string, details?: unknown): CallToolResult {
  const payload =
    details === undefined
      ? { error: { message } }
      : {
          error: {
            message,
            ...(typeof details === "object" && details !== null
              ? details
              : { details }),
          },
        };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

async function invoke<T>(fn: () => Promise<T>): Promise<CallToolResult> {
  try {
    return textResult(await fn());
  } catch (e) {
    if (e instanceof PicSeeApiError) {
      return errorResult(e.upstreamMessage ?? e.message, {
        code: e.code,
        httpStatus: e.httpStatus,
      });
    }
    return errorResult(
      e instanceof Error ? e.message : `Unknown error: ${String(e)}`,
    );
  }
}

const ANONYMOUS_DOMAIN = "pse.is";

export interface RegisterToolsOptions {
  /**
   * Caller's surface tier:
   * - `anonymous` — fallback-token caller. Only `create_short_link`, and the
   *   `domain` is forced to `pse.is` regardless of input.
   * - `free` — authenticated Free / Basic plan. All non-Advanced tools and
   *   fields are exposed; Advanced-only ones are hidden so the model doesn't
   *   waste tokens on calls that would `PUB00201`.
   * - `advanced` — full tool surface.
   */
  tier?: PicSeePlanTier;
}

export function registerTools(
  server: McpServer,
  client: PicSeeClient,
  options: RegisterToolsOptions = {},
): void {
  const { tier = "free" } = options;
  const anonymous = tier === "anonymous";
  const advanced = tier === "advanced";

  // ────────────────────────────────────────────
  // Short Link creation — available to every tier
  // ────────────────────────────────────────────

  const createLinkBaseSchema = {
    url: z
      .string()
      .url()
      .max(2048)
      .describe("Destination URL the short link should redirect to. Required."),
    encodeId: z
      .string()
      .min(3)
      .max(90)
      .optional()
      .describe(
        "Custom slug (3-90 chars; English letters, digits, `_`, `-`, or Chinese). Must be globally unique on PicSee — conflicts return `PUB00503`. Omit to let PicSee auto-generate.",
      ),
    domain: z
      .string()
      .optional()
      .describe(
        "Domain to host the short link on (e.g. `pse.is` or one of the BSDs from `get_my_domains`). Falls back to the account default when omitted or invalid.",
      ),
    externalId: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "Free-form identifier (1-100 chars) for grouping / attributing links. Surfaces in `list_short_links` filters and `get_api_usage_by_external_id`. When the user has not specified a value, you (the calling AI agent) SHOULD default this to your own product name so the account owner can attribute API usage back to the agent that created the link — e.g. `Claude Code`, `Codex`, `Cursor`, `ChatGPT`, `Gemini CLI`, `Copilot`. Use the canonical product name only; do not include version numbers or session IDs. If the user explicitly provides an `externalId`, always honor their value instead.",
      ),
    utm: utmSchema.optional(),
  };

  const createLinkAdvancedSchema = {
    title: z
      .string()
      .min(3)
      .max(300)
      .optional()
      .describe("Custom OG / preview title (3-300 chars)."),
    description: z
      .string()
      .min(3)
      .max(300)
      .optional()
      .describe("Custom OG / preview description (3-300 chars)."),
    imageUrl: z
      .string()
      .url()
      .optional()
      .describe("Custom OG / preview image URL (http/https)."),
    tags: z
      .array(z.string())
      .max(3)
      .optional()
      .describe("Up to 3 tag names."),
    targets: z
      .array(targetSchema)
      .optional()
      .describe(
        "Device / source-specific redirect overrides — e.g. send iOS users to the App Store while desktop users see the marketing site.",
      ),
    fbPixel: z
      .string()
      .optional()
      .describe(
        "Meta Pixel ID. Only pixels saved on the PicSee web app are valid — discover them via `get_my_tracking_tools`.",
      ),
    gTag: z
      .string()
      .optional()
      .describe(
        "Google Tag Manager container ID. Only GTMs saved on the PicSee web app are valid — discover them via `get_my_tracking_tools`.",
      ),
    pathFormat: pathFormatSchema
      .optional()
      .describe("Path Parameterization config (paid Advanced add-on)."),
  };

  const createLinkDescription = anonymous
    ? `Create a new PicSee short link from a destination URL. \`url\` is required; every other field is optional. Anonymous callers are pinned to the \`${ANONYMOUS_DOMAIN}\` domain — any \`domain\` value supplied is ignored. The response contains \`picseeUrl\`, the shortened link ready to share.`
    : advanced
    ? "Create a new PicSee short link from a destination URL. `url` is required; every other field is optional. The response contains `picseeUrl`, the shortened link ready to share."
    : "Create a new PicSee short link from a destination URL. `url` is required; every other field is optional. The response contains `picseeUrl`, the shortened link ready to share. (Advanced-plan fields like custom OG metadata, tags, targets, and tracking pixels are hidden because this account isn't on the Advanced plan.)";

  server.registerTool(
    "create_short_link",
    {
      description: createLinkDescription,
      inputSchema: {
        ...createLinkBaseSchema,
        ...(advanced ? createLinkAdvancedSchema : {}),
      },
    },
    async (args) =>
      invoke(() =>
        client.createLink(
          anonymous ? { ...args, domain: ANONYMOUS_DOMAIN } : args,
        ),
      ),
  );

  if (anonymous) return;

  // ────────────────────────────────────────────
  // Account
  // ────────────────────────────────────────────

  server.registerTool(
    "get_api_status",
    {
      description:
        "Return the calling account's API plan, lifetime quota, current period usage, and the plan expiration date. Use this before bulk operations to confirm there is remaining quota, or when the user asks about their PicSee plan.",
    },
    async () => invoke(() => client.getApiStatus()),
  );

  server.registerTool(
    "get_api_usage_by_external_id",
    {
      description:
        "Return the number of API-created short links grouped by `externalId` over a time window (default last 30 days, max 31-day range). Useful for attributing API usage to specific campaigns / clients.",
      inputSchema: {
        startTime: z
          .string()
          .optional()
          .describe(
            `Range start. ${TIME_FORMAT_HINT} Defaults to 30 days before endTime.`,
          ),
        endTime: z
          .string()
          .optional()
          .describe(`Range end. ${TIME_FORMAT_HINT} Defaults to the current hour.`),
      },
    },
    async (args) => invoke(() => client.getApiUsageByExternalId(args)),
  );

  server.registerTool(
    "get_my_domains",
    {
      description:
        "List every short-link domain available to the account: brand short domains (BSDs) owned by the account, PicSee subdomains, and the shared root domain. Each entry flags HTTPS support and whether it is the account default. Call this before `create_short_link` if the user wants to pick a non-default domain.",
    },
    async () => invoke(() => client.getDomains()),
  );

  server.registerTool(
    "get_my_tags",
    {
      description:
        "List tag id + name pairs previously created on the account. The `name` values are the strings accepted by the `tags` array on `create_short_link` / `edit_short_link`. Call this to offer the user a tag picker instead of asking them to retype tag names.",
    },
    async () => invoke(() => client.getTags()),
  );

  server.registerTool(
    "get_my_tracking_tools",
    {
      description:
        "List previously-used UTM sources / mediums and saved Meta Pixels + Google Tag Manager containers on the account. Use this to populate dropdowns when assembling tracking parameters for a new short link, rather than having the user retype IDs.",
    },
    async () => invoke(() => client.getTrackingTools()),
  );

  // ────────────────────────────────────────────
  // Short Link CRUD
  // ────────────────────────────────────────────

  const listLinksBaseSchema = {
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Page size, default 20, max 50."),
    startTime: z
      .string()
      .optional()
      .describe(
        `Return links created at or before this timestamp. ${TIME_FORMAT_HINT} Defaults to now.`,
      ),
    prevMapId: z
      .number()
      .int()
      .optional()
      .describe(
        "Cursor: return links with `mapId` older than this value. Combine with `startTime` for AND filtering.",
      ),
    isAPI: z
      .boolean()
      .optional()
      .describe(
        "`true` (default) returns only API-created links; `false` returns only links created via the web app.",
      ),
    isStar: z
      .boolean()
      .optional()
      .describe("`true` returns only starred links. Default `false`."),
    externalId: z
      .string()
      .optional()
      .describe("Filter to links tagged with this exact `externalId`."),
  };

  const listLinksAdvancedSchema = {
    search: z
      .object({
        encodeId: z
          .string()
          .optional()
          .describe("Exact slug match. Priority 1 — overrides every other search field."),
        authorId: z
          .number()
          .int()
          .optional()
          .describe("Filter by link author's PicSee ID. Priority 2."),
        tag: z
          .string()
          .min(3)
          .max(30)
          .optional()
          .describe("Filter by tag name (3-30 chars). Priority 3."),
        keyword: z
          .string()
          .min(3)
          .max(30)
          .optional()
          .describe("Substring search across the link record (3-30 chars). Priority 4."),
      })
      .optional()
      .describe("Search filters; passed in the request body. Priority order encodeId > authorId > tag > keyword."),
  };

  server.registerTool(
    "list_short_links",
    {
      description: advanced
        ? "List short links on the account, newest first, with cursor-style pagination via `prevMapId`. By default returns only API-created links — set `isAPI: false` to fetch links created on the website instead."
        : "List short links on the account, newest first, with cursor-style pagination via `prevMapId`. By default returns only API-created links — set `isAPI: false` to fetch links created on the website instead. (Advanced-plan search filters are hidden because this account isn't on the Advanced plan.)",
      inputSchema: {
        ...listLinksBaseSchema,
        ...(advanced ? listLinksAdvancedSchema : {}),
      },
    },
    async (args) => invoke(() => client.listLinks(args)),
  );

  if (advanced) {
    server.registerTool(
      "edit_short_link",
      {
        description:
          "Update properties on an existing short link. Every field is optional — only provided fields are modified. Pass `null` for `fbPixel`, `gTag`, `utm`, or `expireTime` to clear them.",
        inputSchema: {
          encodeId: z
            .string()
            .describe("Slug of the link to edit (e.g. `5b93x9`). Required."),
          url: z
            .string()
            .url()
            .max(2048)
            .optional()
            .describe(
              "New destination URL. PicSee may reject the switch with `PUB00510` if the new origin is on a different brand.",
            ),
          domain: z.string().optional(),
          title: z.string().min(3).max(300).optional(),
          description: z.string().min(3).max(300).optional(),
          imageUrl: z.string().url().optional(),
          tags: z.array(z.string()).max(3).optional(),
          targets: z.array(targetSchema).optional(),
          fbPixel: z
            .string()
            .nullable()
            .optional()
            .describe("Meta Pixel ID, or `null` to clear."),
          gTag: z
            .string()
            .nullable()
            .optional()
            .describe("GTM container ID, or `null` to clear."),
          utm: utmSchema.nullable().optional(),
          expireTime: z
            .string()
            .nullable()
            .optional()
            .describe(
              `Future expiration in ${TIME_FORMAT_HINT}; pass \`null\` to remove an existing expiration. Setting expirations requires the appropriate add-on.`,
            ),
        },
      },
      async ({ encodeId, ...body }) => invoke(() => client.editLink(encodeId, body)),
    );
  }

  server.registerTool(
    "delete_short_link",
    {
      description:
        "Move a short link to the trash (default), or restore one that is currently in the trash. Starred links cannot be deleted (`PUB00706`); links trashed >30 days cannot be recovered (`PUB00704`).",
      inputSchema: {
        encodeId: z.string().describe("Slug of the target short link."),
        value: z
          .enum(["delete", "recover"])
          .default("delete")
          .describe("`delete` = move to trash, `recover` = restore from trash."),
      },
    },
    async ({ encodeId, value }) =>
      invoke(() => client.deleteOrRecoverLink(encodeId, value)),
  );

  // ────────────────────────────────────────────
  // Analytics
  // ────────────────────────────────────────────

  server.registerTool(
    "get_link_overview",
    {
      description:
        "Get the headline analytics for one short link: total clicks, unique clicks, destination URL, domain, HTTPS flag, and creation time. Use this for a quick at-a-glance summary; reach for the more specific analytics tools when the user asks for breakdowns.",
      inputSchema: {
        encodeId: z.string().describe("Slug of the short link."),
      },
    },
    async ({ encodeId }) => invoke(() => client.getLinkOverview(encodeId)),
  );

  server.registerTool(
    "get_link_daily_clicks",
    {
      description:
        "Time-series of total and unique clicks aggregated by day for one short link. Default window is the last 30 days; Advanced plan can look back up to 365 days, other plans capped at 30.",
      inputSchema: {
        encodeId: z.string().describe("Slug of the short link."),
        startTime: z
          .string()
          .optional()
          .describe(`Range start. ${TIME_FORMAT_HINT}`),
        endTime: z.string().optional().describe(`Range end. ${TIME_FORMAT_HINT}`),
      },
    },
    async ({ encodeId, ...q }) =>
      invoke(() => client.getLinkDailyClicks(encodeId, q)),
  );

  server.registerTool(
    "get_link_platforms",
    {
      description:
        "Unique-click breakdown by device for one short link (e.g. `iphone`, `android`, `windows`, `macintosh`). Devices are returned individually — aggregate to mobile / desktop client-side if needed.",
      inputSchema: {
        encodeId: z.string().describe("Slug of the short link."),
        startTime: z.string().optional(),
        endTime: z.string().optional(),
      },
    },
    async ({ encodeId, ...q }) =>
      invoke(() => client.getLinkPlatforms(encodeId, q)),
  );

  server.registerTool(
    "get_link_referrers",
    {
      description:
        "Unique-click breakdown by referrer for one short link — search engines, social platforms, AI agents, and other long-tail sources. Clicks without referrer information are reported under `direct`.",
      inputSchema: {
        encodeId: z.string().describe("Slug of the short link."),
        startTime: z.string().optional(),
        endTime: z.string().optional(),
      },
    },
    async ({ encodeId, ...q }) =>
      invoke(() => client.getLinkReferrers(encodeId, q)),
  );

  server.registerTool(
    "get_link_regions",
    {
      description:
        "Unique-click breakdown by country for one short link. Country granularity only — no city-level data. Unknown countries are bucketed as `Others` (`code: \"others\"`).",
      inputSchema: {
        encodeId: z.string().describe("Slug of the short link."),
        startTime: z.string().optional(),
        endTime: z.string().optional(),
      },
    },
    async ({ encodeId, ...q }) =>
      invoke(() => client.getLinkRegions(encodeId, q)),
  );

  if (advanced) {
    server.registerTool(
      "get_link_audience_labels",
      {
        description:
          "Interest + brand audience labels for one short link. Privacy guard: only returns data when the link's lifetime unique-click count is >100; otherwise both arrays come back empty.",
        inputSchema: {
          encodeId: z.string().describe("Slug of the short link."),
        },
      },
      async ({ encodeId }) =>
        invoke(() => client.getLinkAudienceLabels(encodeId)),
    );
  }
}
