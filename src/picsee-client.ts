export interface PicSeeErrorBody {
  status: number;
  code: string;
  message?: string;
}

export class PicSeeApiError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  readonly upstreamMessage?: string;
  readonly raw: unknown;

  constructor(httpStatus: number, body: unknown) {
    const err = (body as { error?: PicSeeErrorBody } | null)?.error;
    const code = err?.code ?? "UNKNOWN";
    const msg = err?.message ?? `PicSee API error (HTTP ${httpStatus})`;
    super(`[${code}] ${msg}`);
    this.name = "PicSeeApiError";
    this.httpStatus = httpStatus;
    this.code = code;
    this.upstreamMessage = err?.message;
    this.raw = body;
  }
}

export interface PicSeeClientOptions {
  baseUrl: string;
  accessToken: string;
  userAgent?: string;
}

/**
 * Tool surface tier. `anonymous` is the shared fallback-token caller (most
 * restricted). `free` covers PicSee's Free / Basic accounts — Advanced-only
 * tools and fields are hidden. `advanced` exposes the full surface.
 */
export type PicSeePlanTier = "anonymous" | "free" | "advanced";

/**
 * Parses the plan tier from `GET /v2/my/api/status`. The response shape is
 * `{ data: { planName: "free" | "advanced" | ... } }`. Falls back to `free`
 * on any unrecognized shape — the safer default, since Advanced-gated calls
 * still fail clearly via `PUB00201` and we never accidentally expose paid
 * features.
 */
export function parsePlanTier(apiStatus: unknown): PicSeePlanTier {
  if (apiStatus && typeof apiStatus === "object") {
    const data = (apiStatus as { data?: unknown }).data;
    const planName = (data as { planName?: unknown } | undefined)?.planName;
    if (typeof planName === "string" && planName.toLowerCase().includes("advanced")) {
      return "advanced";
    }
  }
  return "free";
}

type QueryValue = string | number | boolean | null | undefined;

function buildQuery(params?: Record<string, QueryValue>): string {
  if (!params) return "";
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

/**
 * Thin HTTP wrapper around the PicSee REST API. Each method maps 1:1 to an
 * endpoint documented in openapi.yaml. The client is intentionally untyped on
 * the response side (returns `unknown`) so the MCP layer forwards exactly what
 * PicSee returns — we only normalize error shape.
 */
export class PicSeeClient {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly userAgent: string;

  constructor(opts: PicSeeClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.accessToken = opts.accessToken;
    this.userAgent = opts.userAgent ?? "picsee-mcp/0.1";
  }

  private async request(
    method: string,
    path: string,
    init?: { query?: Record<string, QueryValue>; body?: unknown },
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}${buildQuery(init?.query)}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.accessToken}`,
      "User-Agent": this.userAgent,
    };
    let body: BodyInit | undefined;
    if (init?.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.body);
    }

    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      throw new PicSeeApiError(res.status, parsed);
    }
    return parsed;
  }

  // ---- My Account ----

  getApiStatus() {
    return this.request("GET", "/v2/my/api/status");
  }

  getApiUsageByExternalId(params: { startTime?: string; endTime?: string }) {
    return this.request("GET", "/v4/my/api/usage", { query: params });
  }

  getDomains() {
    return this.request("GET", "/v4/my/api/domains");
  }

  getTags() {
    return this.request("GET", "/v4/my/api/tags");
  }

  getTrackingTools() {
    return this.request("GET", "/v4/my/api/trackingTools");
  }

  // ---- Short Links ----

  createLink(body: Record<string, unknown>) {
    return this.request("POST", "/v1/links", { body });
  }

  listLinks(params: {
    limit?: number;
    startTime?: string;
    prevMapId?: number;
    isAPI?: boolean;
    isStar?: boolean;
    externalId?: string;
    search?: {
      encodeId?: string;
      authorId?: number;
      tag?: string;
      keyword?: string;
    };
  }) {
    const { search, ...query } = params;
    return this.request("POST", "/v2/links/overview", {
      query,
      body: search && Object.keys(search).length > 0 ? search : undefined,
    });
  }

  editLink(encodeId: string, body: Record<string, unknown>) {
    return this.request(
      "PUT",
      `/v2/links/${encodeURIComponent(encodeId)}`,
      { body },
    );
  }

  deleteOrRecoverLink(encodeId: string, value: "delete" | "recover") {
    return this.request(
      "POST",
      `/v2/links/${encodeURIComponent(encodeId)}/delete`,
      { body: { value } },
    );
  }

  // ---- Analytics ----

  getLinkOverview(encodeId: string) {
    return this.request(
      "GET",
      `/v1/links/${encodeURIComponent(encodeId)}/overview`,
    );
  }

  getLinkDailyClicks(
    encodeId: string,
    params: { startTime?: string; endTime?: string },
  ) {
    return this.request(
      "GET",
      `/v4/links/${encodeURIComponent(encodeId)}/details/dailyClicks`,
      { query: params },
    );
  }

  getLinkPlatforms(
    encodeId: string,
    params: { startTime?: string; endTime?: string },
  ) {
    return this.request(
      "GET",
      `/v4/links/${encodeURIComponent(encodeId)}/details/platform`,
      { query: params },
    );
  }

  getLinkReferrers(
    encodeId: string,
    params: { startTime?: string; endTime?: string },
  ) {
    return this.request(
      "GET",
      `/v4/links/${encodeURIComponent(encodeId)}/details/referrers`,
      { query: params },
    );
  }

  getLinkRegions(
    encodeId: string,
    params: { startTime?: string; endTime?: string },
  ) {
    return this.request(
      "GET",
      `/v4/links/${encodeURIComponent(encodeId)}/details/regions`,
      { query: params },
    );
  }

  getLinkAudienceLabels(encodeId: string) {
    return this.request(
      "GET",
      `/v4/links/${encodeURIComponent(encodeId)}/details/audienceLabels`,
    );
  }
}
