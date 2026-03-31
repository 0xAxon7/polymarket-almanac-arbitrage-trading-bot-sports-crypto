import http from "http";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { z } from "zod";
import { WebSocketServer, WebSocket } from "ws";
import {
  ClobClient,
  PriceHistoryInterval,
  Side,
  OrderType,
} from "@polymarket/clob-client";
import { Wallet } from "ethers";
import log from "@slackgram/logger";

dotenv.config();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT ?? 3001);
const CLOB_HOST = process.env.CLOB_HOST ?? "https://clob.polymarket.com";
const CLOB_CHAIN_ID = Number(process.env.CLOB_CHAIN_ID ?? 137);
const GAMMA_API_BASE_URL = process.env.GAMMA_API_BASE_URL ?? "https://gamma-api.polymarket.com";
const DATA_API_BASE_URL = process.env.DATA_API_BASE_URL ?? "https://data-api.polymarket.com";
const CLOB_WS_URL = process.env.CLOB_WS_URL ?? "wss://ws-subscriptions-clob.polymarket.com/ws/market";

type MarketToken = {
  token_id: string;
  outcome: string;
  winner: boolean;
  price: number;
};

type MarketMapping = {
  conditionId: string;
  up: { tokenId: string; outcome: string };
  down: { tokenId: string; outcome: string };
  tokenCount: number;
  tickSize?: string;
  negRisk?: boolean;
};

type SeriesPoint = { t: number; p: number };
type TimeWindow = { startTs: number; endTs: number };

function asNumber(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  if (!Number.isFinite(n)) throw new Error(`Expected a finite number, got: ${String(v)}`);
  return n;
}

/** Data API trade timestamps: unix seconds or ms — normalize to seconds for sort/JSON. */
function tradeTimestampSeconds(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n > 1e12) return Math.floor(n / 1000);
  return Math.floor(n);
}

/** Polymarket conditionId (0x-hex); lowercase for Data API + stable keys. */
function normalizeConditionId(id: string): string {
  return id.trim().toLowerCase();
}

/** Max rows we aggregate for copy / target UI (may span multiple `/activity` pages). */
const COPY_TRADE_FETCH_LIMIT = 1000;
/** Polymarket Data API `GET /activity` maximum `limit` per request. */
const DATA_ACTIVITY_PAGE_LIMIT = 500;
/** Default poll interval for copy / watch loops (ms). */
const COPY_POLL_MS_DEFAULT = 250;
const PROCESSED_COPY_KEYS_MAX = 6000;

/** CLOB tick size + neg-risk rarely change; avoids 2 round-trips per live copy on same token. */
const tokenMetaCache = new Map<string, { tickSize: string; negRisk: boolean }>();

function tradeDedupeKey(t: {
  transactionHash?: unknown;
  side?: unknown;
  price?: unknown;
  size?: unknown;
}): string {
  return `${String(t.transactionHash ?? "")}:${String(t.side ?? "")}:${String(t.price ?? "")}:${String(t.size ?? "")}`;
}

/** Gamma `events[0].id` for Data API `eventId` (integer). */
function parseGammaEventId(market: { events?: { id?: string | number }[] }): number | undefined {
  const raw = market.events?.[0]?.id;
  const n = typeof raw === "string" ? Number(raw) : Number(raw);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.floor(n);
}

/** Event root `id` from Gamma public-search (markets often omit `events[]`). */
function eventIdFromGammaRoot(raw: unknown): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const n = typeof raw === "string" ? Number(raw) : Number(raw);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.floor(n);
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Request failed (${res.status}): ${text}`);
  }
  return (await res.json()) as T;
}

type EventBySlugResponse = {
  id?: string | number;
  markets?: { startDate?: string; endDate?: string }[];
  startDate?: string;
  endDate?: string;
  closedTime?: string;
};

function parseEventId(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined || raw === "") {
    throw new Error("Event id is missing.");
  }
  const n = typeof raw === "number" ? raw : Number(String(raw));
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid eventId: ${JSON.stringify(raw)}`);
  }
  return Math.trunc(n);
}

async function getEventBySlug(slug: string): Promise<EventBySlugResponse> {
  const url = new URL(`/events/slug/${encodeURIComponent(slug)}`, GAMMA_API_BASE_URL);
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { accept: "application/json" },
  });

  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.text();
    } catch {
      body = "<failed to read body>";
    }
    throw new Error(
      `getEventBySlug failed for slug "${slug}": ${res.status} ${res.statusText} - ${String(body)}`,
    );
  }

  return (await res.json()) as EventBySlugResponse;
}

/** Data API `eventId` from Gamma event root `id` (canonical for bucket slugs like `btc-updown-15m-{ts}`). */
async function getEventIdForSlug(slug: string): Promise<number> {
  const trimmed = slug.trim();
  if (!trimmed) throw new Error("Slug is empty.");
  const eventResponse = await getEventBySlug(trimmed);
  return parseEventId(eventResponse.id);
}

async function getEventIdForCondition(conditionId: string): Promise<number> {
  const id = normalizeConditionId(conditionId);
  const url = new URL(`${GAMMA_API_BASE_URL}/markets`);
  url.searchParams.append("condition_ids", id);
  url.searchParams.set("limit", "1");
  const rows = await fetchJson<any[]>(url.toString());
  const first = rows?.[0];
  const marketSlug = String(first?.slug ?? "").trim();
  if (marketSlug) {
    try {
      return await getEventIdForSlug(marketSlug);
    } catch {
      // Slug may not resolve on /events/slug (e.g. stale shape); fall back.
    }
  }
  const eid = parseGammaEventId(first ?? {});
  if (eid == null) {
    throw new Error(`No Gamma event id for condition ${id}`);
  }
  return eid;
}

async function resolveEventIdForCopy(
  conditionId: string,
  optionalEventId?: number | null,
): Promise<number> {
  if (optionalEventId != null && Number.isFinite(optionalEventId) && optionalEventId >= 1) {
    return Math.floor(optionalEventId);
  }
  return getEventIdForCondition(conditionId);
}

function toUnixSeconds(dateLike?: string): number | null {
  if (!dateLike) return null;
  const ms = new Date(dateLike).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

async function getWindowFromSlug(slug: string): Promise<TimeWindow | null> {
  // Prefer the deterministic time bucket encoded in our crypto slug.
  // Example:
  //   btc-updown-5m-1774513500
  // Here the trailing number is the bucket start timestamp, and the bucket
  // length is derived from (5m => 300s, 15m => 900s).
  const bucketMatch = slug.match(/^(btc|eth|sol|xrp)-updown-(5m|15m)-(\d+)$/i);
  if (bucketMatch) {
    const duration = bucketMatch[2].toLowerCase() as "5m" | "15m";
    const startTs = Number(bucketMatch[3]);
    if (Number.isFinite(startTs) && startTs > 0) {
      const step = getDurationSeconds(duration);
      const endTs = startTs + step - 1;
      if (endTs > startTs) return { startTs, endTs };
    }
  }

  // Fallback: derive from Gamma event/market dates.
  const event = await getEventBySlug(slug);
  const firstMarket = event?.markets?.[0];
  const startTs = toUnixSeconds(firstMarket?.startDate) ?? toUnixSeconds(event?.startDate);
  const endTs =
    toUnixSeconds(event?.closedTime) ??
    toUnixSeconds(firstMarket?.endDate) ??
    toUnixSeconds(event?.endDate);

  if (startTs == null || endTs == null || endTs <= startTs) return null;
  return { startTs, endTs };
}

function getCryptoSearchQuery(chain: "btc" | "eth" | "sol" | "xrp", duration: "5m" | "15m") {
  const byChain: Record<typeof chain, string> = {
    btc: "bitcoin",
    eth: "ethereum",
    sol: "solana",
    xrp: "xrp",
  };
  return `${byChain[chain]}-updown-${duration}`;
}

function getCryptoSlugPrefix(chain: "btc" | "eth" | "sol" | "xrp", duration: "5m" | "15m") {
  return `${chain}-updown-${duration}`;
}

function getDurationSeconds(duration: "5m" | "15m") {
  return duration === "5m" ? 300 : 900;
}

function buildTimeBucketSlugs(
  chain: "btc" | "eth" | "sol" | "xrp",
  duration: "5m" | "15m",
  limit: number,
  nowTs: number = Math.floor(Date.now() / 1000),
) {
  const step = getDurationSeconds(duration);
  const base = Math.floor(nowTs / step) * step;
  const prefix = getCryptoSlugPrefix(chain, duration);

  // Build nearby buckets first (current, previous, next, ...).
  const offsets: number[] = [];
  for (let i = 0; i < Math.max(limit * 2, 20); i += 1) {
    if (i === 0) offsets.push(0);
    else {
      offsets.push(-i * step);
      offsets.push(i * step);
    }
  }

  return offsets.map((off) => `${prefix}-${base + off}`);
}

function getClobPublicClient() {
  return new ClobClient(CLOB_HOST, CLOB_CHAIN_ID);
}

async function mapConditionIdToUpDown(conditionId: string): Promise<MarketMapping> {
  const clob = getClobPublicClient();
  const market = await clob.getMarket(conditionId);

  const tokens: MarketToken[] = (market?.tokens ?? []) as MarketToken[];
  if (tokens.length < 2) {
    throw new Error(`Market ${conditionId} does not have >= 2 tokens`);
  }

  const byOutcomeLabel = (label: "UP" | "DOWN") =>
    tokens.find((t) => new RegExp(`\\b${label}\\b`, "i").test(t.outcome));

  const upToken = byOutcomeLabel("UP") ?? tokens[0];
  const downToken = byOutcomeLabel("DOWN") ?? tokens[1];

  // Best-effort market params for copy trading (tick size / neg risk).
  let tickSize: string | undefined;
  let negRisk: boolean | undefined;
  try {
    tickSize = (await clob.getTickSize(upToken.token_id)) as unknown as string;
    negRisk = await clob.getNegRisk(upToken.token_id);
  } catch {
    // Non-fatal: charting and target-trades still work.
  }

  return {
    conditionId,
    up: { tokenId: upToken.token_id, outcome: upToken.outcome },
    down: { tokenId: downToken.token_id, outcome: downToken.outcome },
    tokenCount: tokens.length,
    tickSize,
    negRisk,
  };
}

app.get("/api/health", async (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/market/types", async (_req, res) => {
  const url = new URL(`${GAMMA_API_BASE_URL}/sports/market-types`);
  const data = await fetchJson<{ marketTypes: string[] }>(url.toString());
  res.json({ marketTypes: data.marketTypes });
});

app.get("/api/market/list", async (req, res) => {
  const schema = z.object({
    typeId: z.string().min(1),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  });

  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { typeId, limit = 30, offset = 0 } = parsed.data;

  const url = new URL(`${GAMMA_API_BASE_URL}/markets`);
  url.searchParams.set("closed", "false");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  // Gamma API: array query params are supported via repeated keys.
  url.searchParams.append("sports_market_types", typeId);

  const markets = await fetchJson<any[]>(url.toString());

  res.json({
    markets: markets.map((m) => ({
      conditionId: m.conditionId as string,
      question: m.question as string,
      slug: m.slug as string | undefined,
    })),
  });
});

type GammaMarketListRow = {
  conditionId?: string;
  question?: string;
  slug?: string;
  acceptingOrders?: boolean;
  active?: boolean;
  closed?: boolean;
  events?: { id?: string | number }[];
};

/**
 * All Polymarket markets: volume-ordered browse (empty q) or public-search (q set).
 * Search results are capped to one API page; browse supports offset pagination.
 */
app.get("/api/markets/browse", async (req, res) => {
  const schema = z.object({
    q: z.string().optional().default(""),
    limit: z.coerce.number().int().min(1).max(100).optional().default(40),
    offset: z.coerce.number().int().min(0).optional().default(0),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { q, limit, offset } = parsed.data;
  const qTrim = q.trim();

  try {
    if (qTrim) {
      type SearchEv = { id?: string | number; markets?: GammaMarketListRow[] };
      const searchUrl = new URL(`${GAMMA_API_BASE_URL}/public-search`);
      searchUrl.searchParams.set("q", qTrim);
      searchUrl.searchParams.set("events_status", "active");
      searchUrl.searchParams.set("limit_per_type", String(Math.min(80, Math.max(limit, 50))));
      searchUrl.searchParams.set("page", "1");
      const data = await fetchJson<{ events?: SearchEv[] }>(searchUrl.toString());

      type Out = {
        conditionId: string;
        question: string;
        slug?: string;
        eventId?: number;
      };
      const rows: Out[] = [];
      for (const ev of data.events ?? []) {
        const parentEid = eventIdFromGammaRoot(ev.id);
        for (const m of ev.markets ?? []) {
          const cid = String(m.conditionId ?? "").trim();
          if (!cid) continue;
          const eid = parseGammaEventId(m) ?? parentEid;
          rows.push({
            conditionId: cid,
            question: String(m.question ?? m.slug ?? cid),
            slug: m.slug as string | undefined,
            ...(eid != null ? { eventId: eid } : {}),
          });
        }
      }
      const seen = new Set<string>();
      const unique = rows.filter((r) => {
        if (seen.has(r.conditionId)) return false;
        seen.add(r.conditionId);
        return true;
      });
      const page = unique.slice(0, limit);
      return res.json({
        mode: "search" as const,
        q: qTrim,
        limit,
        offset: 0,
        markets: page,
        hasMore: false,
      });
    }

    const url = new URL(`${GAMMA_API_BASE_URL}/markets`);
    url.searchParams.set("closed", "false");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("order", "volumeNum");
    url.searchParams.set("ascending", "false");

    const arr = await fetchJson<GammaMarketListRow[]>(url.toString());
    const markets = arr
      .map((m) => {
        const cid = String(m.conditionId ?? "").trim();
        if (!cid) return null;
        const eid = parseGammaEventId(m);
        return {
          conditionId: cid,
          question: String(m.question ?? m.slug ?? cid),
          slug: m.slug as string | undefined,
          ...(eid != null ? { eventId: eid } : {}),
        };
      })
      .filter((m): m is NonNullable<typeof m> => m != null);

    return res.json({
      mode: "browse" as const,
      q: "",
      limit,
      offset,
      markets,
      hasMore: markets.length === limit,
    });
  } catch (err: any) {
    res.status(400).json({
      error: err?.message ?? String(err),
      detail: { q: qTrim, limit, offset },
    });
  }
});

app.get("/api/crypto/markets", async (req, res) => {
  const schema = z.object({
    chain: z.enum(["btc", "eth", "sol", "xrp"]).default("btc"),
    duration: z.enum(["5m", "15m"]).default("15m"),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { chain, duration, limit } = parsed.data;
  const q = getCryptoSearchQuery(chain, duration);

  type GammaMarket = {
    conditionId?: string;
    question?: string;
    slug?: string;
    startDate?: string;
    endDate?: string;
    acceptingOrders?: boolean;
    active?: boolean;
    closed?: boolean;
    events?: { id?: string | number }[];
  };
  type GammaEvent = { markets?: GammaMarket[] };
  type SearchResponse = { events?: GammaEvent[] };

  try {
    const slugNeedle = `${chain}-updown-${duration}`;
    const bucketSlugs = buildTimeBucketSlugs(chain, duration, limit);

    // 1) Primary strategy: fetch by deterministic time-bucket slugs.
    const slugUrl = new URL(`${GAMMA_API_BASE_URL}/markets`);
    for (const slug of bucketSlugs) {
      slugUrl.searchParams.append("slug", slug);
    }
    slugUrl.searchParams.set("limit", String(Math.max(limit * 2, 20)));
    const slugMarkets = await fetchJson<GammaMarket[]>(slugUrl.toString());

    // 2) Secondary fallback: public-search query if bucket lookup is sparse.
    let merged: GammaMarket[] = [...(slugMarkets ?? [])];
    if (merged.length < limit) {
      const searchUrl = new URL(`${GAMMA_API_BASE_URL}/public-search`);
      searchUrl.searchParams.set("q", q);
      searchUrl.searchParams.set("events_status", "active");
      searchUrl.searchParams.set("limit_per_type", String(Math.max(50, limit)));
      searchUrl.searchParams.set("page", "1");
      const data = await fetchJson<SearchResponse>(searchUrl.toString());
      const fromSearch = (data.events ?? []).flatMap((ev) => ev.markets ?? []);
      merged = merged.concat(fromSearch);
    }

    const slugFiltered = merged.filter((m) => (m.slug ?? "").toLowerCase().includes(slugNeedle));

    // Prefer accepting orders; otherwise fallback to active and not closed.
    const acceptingFiltered = slugFiltered.filter((m) =>
      typeof m.acceptingOrders === "boolean" ? m.acceptingOrders : false,
    );
    const filtered =
      acceptingFiltered.length > 0
        ? acceptingFiltered
        : slugFiltered.filter((m) => m.active === true && m.closed === false);

    // Deduplicate by conditionId because search results can repeat across groups.
    const seen = new Set<string>();
    const markets = filtered
      .filter((m) => {
        const id = m.conditionId ?? "";
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .slice(0, limit)
      .map((m) => {
        const eid = parseGammaEventId(m);
        return {
          conditionId: m.conditionId as string,
          question: (m.question ?? m.slug ?? m.conditionId) as string,
          slug: m.slug as string | undefined,
          startDate: m.startDate as string | undefined,
          endDate: m.endDate as string | undefined,
          ...(eid != null ? { eventId: eid } : {}),
        };
      });

    res.json({ chain, duration, markets });
  } catch (err: any) {
    res.status(400).json({
      error: err?.message ?? String(err),
      detail: { chain, duration, q },
    });
  }
});

app.get("/api/crypto/current", async (req, res) => {
  const schema = z.object({
    chain: z.enum(["btc", "eth", "sol", "xrp"]).default("btc"),
    duration: z.enum(["5m", "15m"]).default("15m"),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { chain, duration } = parsed.data;
  const step = getDurationSeconds(duration);
  const nowTs = Math.floor(Date.now() / 1000);
  const bucketStartTs = Math.floor(nowTs / step) * step;
  const prefix = getCryptoSlugPrefix(chain, duration);

  type GammaMarket = {
    conditionId?: string;
    question?: string;
    slug?: string;
    startDate?: string;
    endDate?: string;
    acceptingOrders?: boolean;
    active?: boolean;
    closed?: boolean;
    events?: { id?: string | number }[];
  };

  const candidates = [bucketStartTs, bucketStartTs + step, bucketStartTs - step];

  for (const startTs of candidates) {
    if (startTs <= 0) continue;
    const slug = `${prefix}-${startTs}`;

    const url = new URL(`${GAMMA_API_BASE_URL}/markets`);
    url.searchParams.append("slug", slug);
    url.searchParams.set("closed", "false");
    url.searchParams.set("limit", "20");

    const markets = await fetchJson<any[]>(url.toString()).catch(() => []);

    const dedup: Record<string, GammaMarket> = {};
    for (const m of markets) {
      const conditionId = String(m.conditionId ?? "");
      if (!conditionId) continue;
      dedup[conditionId] = m as GammaMarket;
    }

    const arr = Object.values(dedup);
    const matching = arr.filter((m) => String(m.slug ?? "").toLowerCase() === slug.toLowerCase());
    if (!matching.length) continue;

    const accepting = matching.filter((m) => typeof m.acceptingOrders === "boolean" && m.acceptingOrders);
    const filtered = accepting.length
      ? accepting
      : matching.filter((m) => m.active === true && m.closed === false);

    const chosen = (filtered.length ? filtered : matching)[0];
    if (!chosen?.conditionId) continue;

    let eid: number | undefined;
    try {
      eid = await getEventIdForSlug(slug);
    } catch {
      eid = parseGammaEventId(chosen) ?? undefined;
    }
    return res.json({
      chain,
      duration,
      nowTs,
      currentBucketStartTs: startTs,
      market: {
        conditionId: String(chosen.conditionId),
        question: String(chosen.question ?? chosen.slug ?? chosen.conditionId),
        slug: chosen.slug as string | undefined,
        startDate: chosen.startDate as string | undefined,
        endDate: chosen.endDate as string | undefined,
        ...(eid != null ? { eventId: eid } : {}),
      },
    });
  }

  return res.json({
    chain,
    duration,
    nowTs,
    currentBucketStartTs: bucketStartTs,
    market: null,
  });
});

app.get("/api/market/:conditionId", async (req, res) => {
  const conditionIdSchema = z.string().min(1);
  const parsed = conditionIdSchema.safeParse(req.params.conditionId);
  if (!parsed.success) return res.status(400).json({ error: "Invalid conditionId" });

  try {
    const mapping = await mapConditionIdToUpDown(parsed.data);
    res.json(mapping);
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? String(err) });
  }
});

app.get("/api/chart", async (req, res) => {
  const schema = z.object({
    conditionId: z.string().min(1),
    slug: z.string().min(1).optional(),
    interval: z.enum(["1h", "6h", "1d", "1w", "max"]).optional(),
    fidelity: z.coerce.number().int().min(1).max(500).optional(),
  });

  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { conditionId, slug, interval = "1d", fidelity = 60 } = parsed.data;

  try {
    const mapping = await mapConditionIdToUpDown(conditionId);
    const clob = getClobPublicClient();

    const intervalEnum = ((): PriceHistoryInterval => {
      switch (interval) {
        case "1h":
          return PriceHistoryInterval.ONE_HOUR;
        case "6h":
          return PriceHistoryInterval.SIX_HOURS;
        case "1d":
          return PriceHistoryInterval.ONE_DAY;
        case "1w":
          return PriceHistoryInterval.ONE_WEEK;
        case "max":
          return PriceHistoryInterval.MAX;
        default:
          return PriceHistoryInterval.ONE_DAY;
      }
    })();

    const window = slug ? await getWindowFromSlug(slug) : null;
    const nowTs = Math.floor(Date.now() / 1000);
    const effectiveEndTs =
      window && typeof window.endTs === "number" ? Math.min(window.endTs, nowTs) : null;
    const effectiveWindow = window
      ? { startTs: window.startTs, endTs: effectiveEndTs ?? window.endTs }
      : null;
    const [upHistory, downHistory] = await Promise.all([
      window
        ? clob.getPricesHistory({
            market: mapping.up.tokenId,
            startTs: window.startTs,
            endTs: effectiveEndTs ?? window.endTs,
          })
        : clob.getPricesHistory({
            market: mapping.up.tokenId,
            interval: intervalEnum,
            fidelity,
          }),
      window
        ? clob.getPricesHistory({
            market: mapping.down.tokenId,
            startTs: window.startTs,
            endTs: effectiveEndTs ?? window.endTs,
          })
        : clob.getPricesHistory({
            market: mapping.down.tokenId,
            interval: intervalEnum,
            fidelity,
          }),
    ]);

    const normalizeHistory = (resp: any, tokenId: string): any[] => {
      if (Array.isArray(resp)) return resp;
      // clob-client currently returns `{ history: MarketPrice[] }`
      if (resp && Array.isArray(resp.history)) return resp.history;
      throw new Error(`Unexpected getPricesHistory response for token ${tokenId}`);
    };

    const toSeries = (resp: any, tokenId: string): SeriesPoint[] =>
      normalizeHistory(resp, tokenId)
        .map((pt) => ({ t: asNumber(pt.t), p: asNumber(pt.p) }))
        .filter((pt) => {
          if (!effectiveWindow) return true;
          return pt.t >= effectiveWindow.startTs && pt.t <= effectiveWindow.endTs;
        });

    res.json({
      conditionId,
      slug,
      up: mapping.up,
      down: mapping.down,
      window,
      upSeries: toSeries(upHistory, mapping.up.tokenId),
      downSeries: toSeries(downHistory, mapping.down.tokenId),
    });
  } catch (err: any) {
    res.status(400).json({
      error: err?.message ?? String(err),
      detail: {
        conditionId,
        slug,
        interval,
        fidelity,
      },
    });
  }
});

/**
 * Data API `GET /activity` with `type=TRADE` (replaces `/trades` + takerOnly merge).
 * Pages with DESC timestamp so we collect the newest `maxRows` fills, then sort oldest → newest for copy logic.
 */
async function fetchUserTradeActivities(params: {
  userAddress: string;
  maxRows: number;
  eventId?: number;
}): Promise<any[]> {
  const userAddress = params.userAddress.trim();
  const cap = Math.min(Math.max(1, params.maxRows), COPY_TRADE_FETCH_LIMIT);
  const merged = new Map<string, any>();
  let offset = 0;

  while (merged.size < cap && offset <= 10_000) {
    const pageSize = Math.min(DATA_ACTIVITY_PAGE_LIMIT, cap - merged.size);
    const url = new URL(`${DATA_API_BASE_URL}/activity`);
    url.searchParams.set("user", userAddress);
    url.searchParams.append("type", "TRADE");
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("sortBy", "TIMESTAMP");
    url.searchParams.set("sortDirection", "DESC");
    if (params.eventId != null && Number.isFinite(params.eventId) && params.eventId >= 1) {
      url.searchParams.append("eventId", String(Math.floor(params.eventId)));
    }

    const batch = await fetchJson<any[]>(url.toString());
    if (!Array.isArray(batch) || batch.length === 0) {
      // This is the snapshot fetch path used by `GET /api/target-trades` (Refresh trades).
      // eslint-disable-next-line no-console
      // log.info("[target-trades:snapshot] No trades found");
      break;
    }

    for (const a of batch) {
      if (String(a?.type ?? "").toUpperCase() !== "TRADE") continue;
      merged.set(tradeDedupeKey(a), a);
      if (merged.size >= cap) break;
    }
    // eslint-disable-next-line no-console
    // log.info("[target-trades:snapshot] Trades found", batch.length);

    if (batch.length < pageSize) {
      // eslint-disable-next-line no-console
      log.info("[target-trades:snapshot] Less than page size", batch.length, pageSize);
      break;
    }
    offset += batch.length;
  }

  return Array.from(merged.values()).sort(
    (a, b) => tradeTimestampSeconds(a.timestamp) - tradeTimestampSeconds(b.timestamp),
  );
}

async function fetchMergedTradesForUserAllMarkets(userAddress: string, tradeLimit: number): Promise<any[]> {
  return fetchUserTradeActivities({ userAddress, maxRows: tradeLimit });
}

/**
 * Fetch latest TRADE activities (newest first upstream), then normalize to oldest→newest.
 * Used by polling loop without a `start` window.
 */
async function fetchLatestTradeActivities(params: {
  userAddress: string;
  eventId?: number;
  maxRows?: number;
}): Promise<any[]> {
  const userAddress = params.userAddress.trim();
  const cap = Math.min(params.maxRows ?? 50, COPY_TRADE_FETCH_LIMIT);
  const out: any[] = [];
  const seen = new Set<string>();
  const url = new URL(`${DATA_API_BASE_URL}/activity`);
  url.searchParams.set("user", userAddress);
  url.searchParams.append("type", "TRADE");
  url.searchParams.set("limit", String(cap));
  url.searchParams.set("offset", "0");
  url.searchParams.set("sortBy", "TIMESTAMP");
  url.searchParams.set("sortDirection", "DESC");
  if (params.eventId != null && Number.isFinite(params.eventId) && params.eventId >= 1) {
    url.searchParams.append("eventId", String(Math.floor(params.eventId)));
  }

  const batch = await fetchJson<any[]>(url.toString());
  if (!Array.isArray(batch) || batch.length === 0) 
    {
      // eslint-disable-next-line no-console
      log.info("[target-trades:snapshot] No trades found");
      return [];
    }

  for (const a of batch) {
    if (String(a?.type ?? "").toUpperCase() !== "TRADE") continue;
    const k = tradeDedupeKey(a);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
    if (out.length >= cap) break;
  }
  // eslint-disable-next-line no-console
  // log.info("[target-trades:snapshot] Trades found", out.length);
  return out.sort((a, b) => tradeTimestampSeconds(a.timestamp) - tradeTimestampSeconds(b.timestamp));
}

function copyAttemptKey(t: any): string {
  const ts = tradeTimestampSeconds(t.timestamp);
  return `${ts}:${tradeDedupeKey(t)}:${String(t.outcomeIndex ?? "")}:${String(t.side ?? "")}`;
}

app.get("/api/target-trades", async (req, res) => {
  const schema = z.object({
    conditionId: z.string().min(1).optional(),
    eventId: z.coerce.number().int().min(1).optional(),
    userAddress: z.string().min(1),
    limit: z.coerce.number().int().min(1).max(10000).optional(),
    /** When true (or no event scope), return recent trades across all markets for the user. */
    allMarkets: z.enum(["true", "false"]).optional(),
  });

  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    // Current UI only uses "all markets" (global=true). Event-scoped support is intentionally removed
    // to keep the hot path small and fast.
    const { userAddress, limit = COPY_TRADE_FETCH_LIMIT } = parsed.data;
    const tradeLimit = Math.min(limit, COPY_TRADE_FETCH_LIMIT);
    const sortedAsc = await fetchMergedTradesForUserAllMarkets(userAddress, tradeLimit);
    const trades = sortedAsc
      .slice()
      .sort((a, b) => tradeTimestampSeconds(b.timestamp) - tradeTimestampSeconds(a.timestamp));

    res.json({
      trades: trades.slice(0, limit).map((t) => ({
        timestamp: tradeTimestampSeconds(t.timestamp),
        side: t.side as "BUY" | "SELL",
        outcome: t.outcome as string,
        outcomeIndex: t.outcomeIndex as number,
        price: t.price as number,
        size: t.size as number,
        transactionHash: t.transactionHash as string,
        title: t.title as string,
        conditionId: typeof t.conditionId === "string" ? t.conditionId : undefined,
        slug: typeof t.slug === "string" ? t.slug : undefined,
      })),
    });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? String(err) });
  }
});

// -------- Target trade feed + optional copy-trading (single poll loop per target::event) --------

type TargetFeedLoopState = {
  timer?: NodeJS.Timeout;
  pollMs: number;
  userTrim: string;
  eventIdNum: number;
  marketTrim: string;
  key: string;
  /** Poll all markets for this wallet (Data API without eventId). */
  isGlobal?: boolean;
  mappingByCondition?: Map<string, MarketMapping>;
  lastTradesFingerprint?: string;
  copyEnabled: boolean;
  dryRun?: boolean;
  copySizing?: { sizePercent: number; minSize?: number; maxSize?: number };
  mapping?: MarketMapping;
  l2Client?: any | null;
  /** Unix sec when loop started. */
  copyStartedAtSec: number;
  /** Merged TRADE rows for WS (chronological). */
  recentTradesForUi: any[];
  /** Avoid duplicate copy attempts across polls. */
  processedCopyKeys: Set<string>;
  /** One baseline message per copy session. */
  copyBaselineSent?: boolean;
  /** Seed processedCopyKeys on the first tick so we don't copy historical baseline fills. */
  zeroPointSeedDone?: boolean;
  /** Prevents overlapping ticks when fetch+copy exceeds pollMs. */
  tickInFlight?: boolean;
};

const targetFeedLoops = new Map<string, TargetFeedLoopState>();

function stopAllFeedLoopsForUser(userTrim: string, exceptKey?: string) {
  const low = userTrim.trim().toLowerCase();
  for (const [k, s] of [...targetFeedLoops.entries()]) {
    if (exceptKey && k === exceptKey) continue;
    if (s.userTrim.trim().toLowerCase() === low) {
      if (s.timer) clearInterval(s.timer);
      targetFeedLoops.delete(k);
    }
  }
}

// -------- Backend relay: Polymarket CLOB market WS → browser (best_bid_ask mid only) --------
type ChartRelaySession = {
  upstream: WebSocket;
  clients: Set<WebSocket>;
  upToken: string;
  downToken: string;
  startTs: number;
  endTs: number;
};
const chartRelaySessions = new Map<string, ChartRelaySession>();

function chartRelayKey(upToken: string, downToken: string, startTs: number, endTs: number) {
  return `${upToken}::${downToken}::${startTs}::${endTs}`;
}

function removeChartRelayClient(relayKey: string, ws: WebSocket) {
  const sess = chartRelaySessions.get(relayKey);
  if (!sess) return;
  sess.clients.delete(ws);
  if (sess.clients.size === 0) {
    try {
      sess.upstream.close();
    } catch {
      // ignore
    }
    chartRelaySessions.delete(relayKey);
  }
}

function attachChartRelayClient(
  relayKey: string,
  ws: WebSocket,
  upToken: string,
  downToken: string,
  startTs: number,
  endTs: number,
) {
  let sess = chartRelaySessions.get(relayKey);
  if (!sess) {
    const upstream = new WebSocket(CLOB_WS_URL);
    sess = { upstream, clients: new Set(), upToken, downToken, startTs, endTs };
    chartRelaySessions.set(relayKey, sess);

    upstream.on("open", () => {
      upstream.send(
        JSON.stringify({
          assets_ids: [upToken, downToken],
          type: "market",
          custom_feature_enabled: true,
        }),
      );
    });

    upstream.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as any;
        if (msg.event_type !== "best_bid_ask") return;
        const assetId = String(msg.asset_id ?? "");
        if (assetId !== upToken && assetId !== downToken) return;
        const bestBid = Number(msg.best_bid);
        const bestAsk = Number(msg.best_ask);
        if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return;
        let t = Number(msg.timestamp ?? Math.floor(Date.now() / 1000));
        if (!Number.isFinite(t)) t = Math.floor(Date.now() / 1000);
        if (t > 1e12) t = Math.floor(t / 1000);
        const mid = (bestBid + bestAsk) / 2;
        if (t < startTs || t > endTs) return;
        const cur = chartRelaySessions.get(relayKey);
        if (!cur) return;
        const payload = JSON.stringify({ type: "chart_mid", asset_id: assetId, t, p: mid });
        for (const c of cur.clients) {
          if (c.readyState === 1) {
            try {
              c.send(payload);
            } catch {
              // ignore
            }
          }
        }
      } catch {
        // ignore
      }
    });

    upstream.on("close", () => {
      const cur = chartRelaySessions.get(relayKey);
      if (!cur) return;
      for (const c of cur.clients) {
        try {
          c.close();
        } catch {
          // ignore
        }
      }
      chartRelaySessions.delete(relayKey);
    });

    upstream.on("error", () => {
      try {
        upstream.close();
      } catch {
        // ignore
      }
    });
  }

  sess.clients.add(ws);
  ws.on("close", () => removeChartRelayClient(relayKey, ws));
}

const COPY_ACTIVITY_MAX = 100;
type CopyActivityKind = "simulated" | "order_posted" | "error" | "baseline" | "skipped";

type CopySizingOptions = {
  sizePercent: number;
  minSize?: number;
  maxSize?: number;
};

/**
 * Outcome shares (same unit as Data API `size`).
 * 1) Scale target size by `sizePercent`.
 * 2) If a min is set and the scaled amount is smaller, use min (floor).
 * 3) If a max is set, cap (so final size is in [min, max] when both are set).
 */
function computeCopyOrderSize(targetSize: number, sizing: CopySizingOptions): { size: number; skip?: string } {
  const raw = Number(targetSize);
  if (!Number.isFinite(raw) || raw <= 0) {
    return { size: 0, skip: "Target trade size missing or invalid." };
  }
  let scaled = raw * (Number(sizing.sizePercent) / 100);
  const minS =
    sizing.minSize != null && Number.isFinite(Number(sizing.minSize)) ? Number(sizing.minSize) : undefined;
  const maxS =
    sizing.maxSize != null && Number.isFinite(Number(sizing.maxSize)) ? Number(sizing.maxSize) : undefined;

  if (minS !== undefined && maxS !== undefined) {
    scaled = Math.min(maxS, Math.max(minS, scaled));
  } else if (minS !== undefined) {
    scaled = Math.max(minS, scaled);
  } else if (maxS !== undefined) {
    scaled = Math.min(maxS, scaled);
  }

  scaled = Math.round(scaled * 1e6) / 1e6;
  if (!Number.isFinite(scaled) || scaled <= 0) {
    return { size: 0, skip: "Computed copy size is zero after percent / min / max." };
  }
  return { size: scaled };
}

type CopyActivityEvent = {
  at: number;
  kind: CopyActivityKind;
  dryRun: boolean;
  side?: string;
  price?: number;
  size?: number;
  outcome?: string;
  targetTransactionHash?: string;
  message?: string;
};

const copyActivityByKey = new Map<string, CopyActivityEvent[]>();
const copyActivitySubscribers = new Map<string, Set<WebSocket>>();

function subscribeCopyActivityWs(loopKey: string, ws: WebSocket) {
  let set = copyActivitySubscribers.get(loopKey);
  if (!set) {
    set = new Set();
    copyActivitySubscribers.set(loopKey, set);
  }
  set.add(ws);
  const onClose = () => {
    set!.delete(ws);
    if (set!.size === 0) copyActivitySubscribers.delete(loopKey);
    ws.off("close", onClose);
  };
  ws.on("close", onClose);

  // Avoid "target trades never appear" when the first tick broadcast happens
  // before the browser finishes subscribing. Send the current buffered state once.
  try {
    const s = targetFeedLoops.get(loopKey);
    if (s?.recentTradesForUi?.length) {
      const payload = JSON.stringify({
        type: "target_trades",
        trades: mapTradesForWire(s.recentTradesForUi),
      });
      if (ws.readyState === 1) ws.send(payload);
    }
  } catch {
    // ignore send errors
  }
}

function broadcastCopyActivity(loopKey: string, row: CopyActivityEvent) {
  const set = copyActivitySubscribers.get(loopKey);
  if (!set?.size) return;
  const payload = JSON.stringify({ type: "copy_activity", event: row });
  for (const client of set) {
    if (client.readyState === 1) {
      try {
        client.send(payload);
      } catch {
        // ignore send errors
      }
    }
  }
}

function pushCopyActivity(loopKey: string, event: Omit<CopyActivityEvent, "at"> & { at?: number }) {
  const row: CopyActivityEvent = {
    at: typeof event.at === "number" ? event.at : Math.floor(Date.now() / 1000),
    kind: event.kind,
    dryRun: event.dryRun,
    side: event.side,
    price: event.price,
    size: event.size,
    outcome: event.outcome,
    targetTransactionHash: event.targetTransactionHash,
    message: event.message,
  };
  const list = copyActivityByKey.get(loopKey) ?? [];
  list.unshift(row);
  copyActivityByKey.set(loopKey, list.slice(0, COPY_ACTIVITY_MAX));
  broadcastCopyActivity(loopKey, row);
}

/** Copy loop + activity buffer key: target wallet + Gamma/Data API event id. */
function getCopyLoopKey(targetAddress: string, eventId: number) {
  return `${targetAddress.trim().toLowerCase()}::e${Math.floor(eventId)}`;
}

/** All-markets copy/watch: one loop per target wallet. */
function getGlobalCopyLoopKey(targetAddress: string) {
  return `${targetAddress.trim().toLowerCase()}::global`;
}

async function copyLoopKeyFromParams(
  targetAddress: string,
  conditionId: string | undefined,
  eventId: number | undefined,
  global?: boolean,
): Promise<string> {
  if (global) return getGlobalCopyLoopKey(targetAddress);
  if (eventId != null && Number.isFinite(eventId) && eventId >= 1) {
    return getCopyLoopKey(targetAddress, Math.floor(eventId));
  }
  if (conditionId?.trim()) {
    const eid = await getEventIdForCondition(conditionId);
    return getCopyLoopKey(targetAddress, eid);
  }
  throw new Error("conditionId, eventId, or global=true required");
}

function fingerprintTrades(sorted: any[]): string {
  return sorted.map((t) => tradeDedupeKey(t)).join("|");
}

function mapTradesForWire(sorted: any[]) {
  return sorted.map((t) => ({
    timestamp: tradeTimestampSeconds(t.timestamp),
    side: t.side as "BUY" | "SELL",
    outcome: t.outcome as string,
    outcomeIndex: t.outcomeIndex as number,
    price: t.price as number,
    size: t.size as number,
    transactionHash: t.transactionHash as string,
    title: t.title as string,
    conditionId: typeof t.conditionId === "string" ? t.conditionId : undefined,
    slug: typeof t.slug === "string" ? t.slug : undefined,
  }));
}

function broadcastTargetTrades(loopKey: string, trades: ReturnType<typeof mapTradesForWire>) {
  const set = copyActivitySubscribers.get(loopKey);
  if (!set?.size) return;
  const payload = JSON.stringify({ type: "target_trades", trades });
  for (const client of set) {
    if (client.readyState === 1) {
      try {
        client.send(payload);
      } catch {
        // ignore
      }
    }
  }
}

function maybeBroadcastTradesIfChanged(s: TargetFeedLoopState, sorted: any[]) {
  const fp = fingerprintTrades(sorted);
  if (fp === s.lastTradesFingerprint) return;
  s.lastTradesFingerprint = fp;
  broadcastTargetTrades(s.key, mapTradesForWire(sorted));
}

function trimProcessedCopyKeys(s: TargetFeedLoopState) {
  if (s.processedCopyKeys.size <= PROCESSED_COPY_KEYS_MAX) return;
  const arr = [...s.processedCopyKeys];
  s.processedCopyKeys = new Set(arr.slice(-Math.floor(PROCESSED_COPY_KEYS_MAX / 2)));
}

function mergeTradesIntoStateAndBroadcast(s: TargetFeedLoopState, newRows: any[]) {
  const map = new Map<string, any>();
  for (const t of s.recentTradesForUi) {
    map.set(tradeDedupeKey(t), t);
  }
  for (const t of newRows) {
    if (String(t?.type ?? "").toUpperCase() !== "TRADE") continue;
    map.set(tradeDedupeKey(t), t);
  }
  const merged = Array.from(map.values()).sort(
    (a, b) => tradeTimestampSeconds(a.timestamp) - tradeTimestampSeconds(b.timestamp),
  );
  s.recentTradesForUi = merged.slice(-COPY_TRADE_FETCH_LIMIT);
  maybeBroadcastTradesIfChanged(s, s.recentTradesForUi);
}

/** Prefer Data API `asset` (CLOB token id); else map UP/DOWN / outcome index to binary mapping. */
function resolveTokenIdFromTrade(t: any, mapping: MarketMapping | undefined): string {
  const raw = String(t.asset ?? "").trim();
  if (/^\d+$/.test(raw)) return raw;
  if (!mapping) return "";
  const outcomeLabel = String(t.outcome ?? "").toLowerCase();
  if (outcomeLabel.includes("up")) return mapping.up.tokenId;
  if (outcomeLabel.includes("down")) return mapping.down.tokenId;
  const idx = Number(t.outcomeIndex);
  return idx === 0 ? mapping.up.tokenId : mapping.down.tokenId;
}

async function runTargetFeedTick(key: string) {
  const s0 = targetFeedLoops.get(key);
  if (!s0) return;
  if (s0.tickInFlight) return;
  s0.tickInFlight = true;
  const clobPublic = getClobPublicClient();

  try {
    const s = targetFeedLoops.get(key);
    if (!s) return;
    const pollBeginSec = Math.floor(Date.now() / 1000);
    // eslint-disable-next-line no-console
    // log.info(
    //   `[feed:tick:start] key=${key} copyEnabled=${s.copyEnabled} dryRun=${String(s.dryRun)} pollBeginSec=${pollBeginSec} pollMs=${s.pollMs}`,
    // );

    const applyCopyForTrade = async (t: any) => {
      const cur = targetFeedLoops.get(key);
      if (!cur?.copyEnabled || cur.copySizing == null || cur.dryRun === undefined) return;

      let mapping: MarketMapping | undefined = cur.mapping;
      if (cur.isGlobal && t.conditionId) {
        const cid = normalizeConditionId(String(t.conditionId));
        if (!cur.mappingByCondition) cur.mappingByCondition = new Map();
        if (!cur.mappingByCondition.has(cid)) {
          try {
            cur.mappingByCondition.set(cid, await mapConditionIdToUpDown(cid));
          } catch {
            /* token may still resolve via t.asset */
          }
        }
        mapping = cur.mappingByCondition.get(cid) ?? mapping;
      }

      const tokenId = resolveTokenIdFromTrade(t, mapping);
      if (!tokenId) {
        pushCopyActivity(key, {
          kind: "skipped",
          dryRun: cur.dryRun,
          side: String(t.side ?? ""),
          price: Number(t.price),
          size: Number(t.size),
          outcome: String(t.outcome ?? ""),
          targetTransactionHash: String(t.transactionHash ?? ""),
          message: "Could not resolve CLOB token (missing asset on trade and no market mapping).",
        });
        return;
      }

      const price = Number(t.price);
      const side = (t.side as string) as Side;
      const { size: orderSize, skip: sizeSkip } = computeCopyOrderSize(Number(t.size), cur.copySizing);

      if (sizeSkip) {
        pushCopyActivity(key, {
          kind: "skipped",
          dryRun: cur.dryRun,
          side: String(t.side ?? ""),
          price,
          size: Number(t.size),
          outcome: String(t.outcome ?? ""),
          targetTransactionHash: String(t.transactionHash ?? ""),
          message: sizeSkip,
        });
        return;
      }

      if (cur.dryRun) {
        // eslint-disable-next-line no-console
        log.info("[copy:dryRun]", {
          tokenId,
          price: t.price,
          size: orderSize,
          targetSize: t.size,
          side: t.side,
          transactionHash: t.transactionHash,
        });
        pushCopyActivity(key, {
          kind: "simulated",
          dryRun: true,
          side: String(t.side ?? ""),
          price,
          size: orderSize,
          outcome: String(t.outcome ?? ""),
          targetTransactionHash: String(t.transactionHash ?? ""),
          message: cur.isGlobal ? String(t.title ?? "") : undefined,
        });
        return;
      }

      const l2 = cur.l2Client;
      if (!l2) return;

      let meta = tokenMetaCache.get(tokenId);
      if (!meta) {
        const [tickSizeRaw, negRisk] = await Promise.all([
          clobPublic.getTickSize(tokenId),
          clobPublic.getNegRisk(tokenId),
        ]);
        meta = { tickSize: tickSizeRaw.toString(), negRisk };
        tokenMetaCache.set(tokenId, meta);
      }
      const { tickSize, negRisk } = meta;

      try {
        // eslint-disable-next-line no-console
        log.info("[copy:live:from-activity]", {
          key,
          activity: {
            timestamp: tradeTimestampSeconds(t.timestamp),
            transactionHash: String(t.transactionHash ?? ""),
            conditionId: String(t.conditionId ?? ""),
            title: String(t.title ?? ""),
            side: String(t.side ?? ""),
            outcome: String(t.outcome ?? ""),
            outcomeIndex: Number(t.outcomeIndex),
            price: Number(t.price),
            size: Number(t.size),
            asset: String(t.asset ?? ""),
          },
          order: {
            tokenId,
            side,
            price,
            size: orderSize,
            tickSize,
            negRisk,
          },
        });
        // createAndPostOrder should return order metadata (varies by clob-client version).
        const postRes: any = await l2.createAndPostOrder(
          {
            tokenID: tokenId,
            price,
            size: orderSize,
            side,
          },
          {
            tickSize: tickSize as any,
            negRisk,
          },
          OrderType.GTC,
        );
        // eslint-disable-next-line no-console
        log.info("[copy:live:post-result]", {
          funderAddress: process.env.CLOB_FUNDER_ADDRESS?.trim() ?? null,
          tokenId,
          order: {
            side,
            price,
            size: orderSize,
          },
          postRes,
        });

        if (postRes?.error) {
          throw new Error(`${String(postRes.error)}${postRes?.status ? ` (status ${String(postRes.status)})` : ""}`);
        }

        const orderId = postRes?.orderId ?? postRes?.id ?? postRes?.orderID ?? null;
        const orderHash = postRes?.orderHash ?? postRes?.hash ?? postRes?.uid ?? null;

        pushCopyActivity(key, {
          kind: "order_posted",
          dryRun: false,
          side: String(t.side ?? ""),
          price,
          size: orderSize,
          outcome: String(t.outcome ?? ""),
          targetTransactionHash: String(t.transactionHash ?? ""),
          message:
            orderId != null
              ? `Order posted (orderId=${String(orderId)})`
              : orderHash != null
                ? `Order posted (hash=${String(orderHash)})`
                : undefined,
        });
      } catch (orderErr: any) {
        pushCopyActivity(key, {
          kind: "error",
          dryRun: false,
          side: String(t.side ?? ""),
          price,
          size: orderSize,
          outcome: String(t.outcome ?? ""),
          targetTransactionHash: String(t.transactionHash ?? ""),
          message: orderErr?.message ?? String(orderErr),
        });
      }
    };

    try {
      const rows = await fetchLatestTradeActivities({
        userAddress: s.userTrim,
        eventId: s.isGlobal ? undefined : s.eventIdNum,
        maxRows: 50,
      });
      // eslint-disable-next-line no-console
      // log.info(
      //   `[feed:tick:fetched] key=${key} rows=${rows.length} eventScope=${s.isGlobal ? "global" : s.eventIdNum}`,
      // );

      if (s.copyEnabled && !s.copyBaselineSent) {
        s.copyBaselineSent = true;
        pushCopyActivity(key, {
          kind: "baseline",
          dryRun: s.dryRun ?? true,
          message: `Listening: GET /activity type=TRADE latest=50 (session ${s.copyStartedAtSec}), poll ${s.pollMs}ms.`,
        });
      }

      if (!s.copyEnabled) {
        // Watch mode: always maintain + broadcast the latest target trades.
        mergeTradesIntoStateAndBroadcast(s, rows);
        return;
      }

      const ordered = rows
        .filter((t) => String(t?.type ?? "").toUpperCase() === "TRADE")
        .sort((a, b) => tradeTimestampSeconds(a.timestamp) - tradeTimestampSeconds(b.timestamp));

      // Zero point: first tick after /copy/start only seeds dedupe keys (no copying).
      if (!s.zeroPointSeedDone) {
        let seeded = 0;
        for (const t of ordered) {
          const ck = copyAttemptKey(t);
          if (s.processedCopyKeys.has(ck)) continue;
          s.processedCopyKeys.add(ck);
          trimProcessedCopyKeys(s);
          seeded++;
        }
        s.zeroPointSeedDone = true;
        // eslint-disable-next-line no-console
        // log.info(`[feed:tick:seed] key=${key} baselineSeeded=${seeded}/${ordered.length}`);
        return;
      }

      const toApply: any[] = [];
      for (const t of ordered) {
        const ck = copyAttemptKey(t);
        if (s.processedCopyKeys.has(ck)) continue;
        s.processedCopyKeys.add(ck);
        trimProcessedCopyKeys(s);
        toApply.push(t);
      }
      // eslint-disable-next-line no-console
      // log.info(
      //   `[feed:tick:copy-queue] key=${key} ordered=${ordered.length} toApply=${toApply.length} mode=${s.dryRun ? "dry-run" : "live"}`,
      // );

      if (toApply.length > 0) {
        // Copy mode: only broadcast trades that are "new since zero-point".
        mergeTradesIntoStateAndBroadcast(s, toApply);
      }

      if (s.dryRun === true) {
        await Promise.all(toApply.map((t) => applyCopyForTrade(t)));
      } else {
        for (const t of toApply) {
          await applyCopyForTrade(t);
        }
      }
      // eslint-disable-next-line no-console
      // log.info(`[feed:tick:done] key=${key} applied=${toApply.length}`);
    } catch (err: any) {
      if (s.copyEnabled) {
        // eslint-disable-next-line no-console
        log.error("[copy] loop error:", err);
        pushCopyActivity(key, {
          kind: "error",
          dryRun: s.dryRun ?? true,
          message: err?.message ?? String(err),
        });
      } else {
        // eslint-disable-next-line no-console
        log.error("[feed] loop error:", err);
      }
    }
  } finally {
    const cur = targetFeedLoops.get(key);
    if (cur) cur.tickInFlight = false;
    // eslint-disable-next-line no-console
    // log.info(`[feed:tick:end] key=${key} inFlight=false`);
  }
}

app.get("/api/wallet", (_req, res) => {
  const address = process.env.CLOB_FUNDER_ADDRESS?.trim() || null;
  res.json({ address });
});

app.get("/api/copy/activity", async (req, res) => {
  const schema = z
    .object({
      targetAddress: z.string().min(1),
      conditionId: z.string().min(1).optional(),
      eventId: z.coerce.number().int().min(1).optional(),
      global: z.enum(["true", "false"]).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    })
    .refine(
      (d) =>
        d.global === "true" ||
        Boolean(d.conditionId?.trim()) ||
        (d.eventId != null && d.eventId >= 1),
      {
        message: "Provide global=true, eventId, or conditionId",
        path: ["eventId"],
      },
    );
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const key = await copyLoopKeyFromParams(
      parsed.data.targetAddress,
      parsed.data.conditionId,
      parsed.data.eventId,
      parsed.data.global === "true",
    );
    const limit = parsed.data.limit ?? 50;
    const events = (copyActivityByKey.get(key) ?? []).slice(0, limit);
    res.json({ events });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? String(err) });
  }
});

async function maybeCreateClobL2Client() {
  const privateKey = process.env.CLOB_PRIVATE_KEY;
  const funderAddress = process.env.CLOB_FUNDER_ADDRESS;
  const signatureTypeRaw = process.env.CLOB_SIGNATURE_TYPE;

  if (!privateKey || !funderAddress) return null;

  const signer = new Wallet(privateKey);
  const tempClient = new ClobClient(CLOB_HOST, CLOB_CHAIN_ID, signer);

  const apiCreds = await tempClient.createOrDeriveApiKey();

  // Log so you can copy these back into .env if needed
  log.info("[auth:derived-creds]", JSON.stringify(apiCreds));

  const signatureTypeNum = Number(signatureTypeRaw ?? 2);
  // clob-client expects the funder address for authenticated trading.
  return new ClobClient(CLOB_HOST, CLOB_CHAIN_ID, signer, apiCreds as any, signatureTypeNum as any, funderAddress);
}

app.post("/api/feed/start", async (req, res) => {
  const schema = z
    .object({
      targetAddress: z.string().min(1),
      conditionId: z.string().min(1).optional(),
      eventId: z.coerce.number().int().min(1).optional(),
      global: z.boolean().optional(),
      pollMs: z.coerce.number().int().min(200).max(60000).optional(),
    })
    .refine((d) => d.global === true || Boolean(d.conditionId?.trim()), {
      message: "Provide conditionId or global=true",
      path: ["conditionId"],
    });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const pollMs = parsed.data.pollMs ?? COPY_POLL_MS_DEFAULT;
  const userTrim = parsed.data.targetAddress.trim();
  const isGlobal = parsed.data.global === true;

  if (isGlobal) {
    stopAllFeedLoopsForUser(userTrim);
  } else {
    const gk = getGlobalCopyLoopKey(userTrim);
    const gs = targetFeedLoops.get(gk);
    if (gs?.timer) clearInterval(gs.timer);
    targetFeedLoops.delete(gk);
  }

  let eventIdNum = 0;
  let marketTrim = "";
  let key: string;
  try {
    if (isGlobal) {
      key = getGlobalCopyLoopKey(userTrim);
    } else {
      marketTrim = normalizeConditionId(parsed.data.conditionId!);
      eventIdNum = await resolveEventIdForCopy(marketTrim, parsed.data.eventId);
      key = getCopyLoopKey(userTrim, eventIdNum);
    }
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? String(err) });
  }

  const ex = targetFeedLoops.get(key);
  if (ex?.copyEnabled) {
    return res.json({
      ok: true,
      mode: "copy",
      key,
      targetAddress: userTrim,
      conditionId: marketTrim || undefined,
      eventId: isGlobal ? undefined : eventIdNum,
      global: isGlobal,
      message: "Copy already active; target trades use the same poll loop.",
    });
  }
  if (ex?.timer) clearInterval(ex.timer);
  const t0 = Math.floor(Date.now() / 1000);
  const state: TargetFeedLoopState = {
    pollMs,
    userTrim,
    eventIdNum,
    marketTrim,
    key,
    isGlobal,
    copyEnabled: false,
    copyStartedAtSec: t0,
    recentTradesForUi: [],
    processedCopyKeys: new Set(),
    lastTradesFingerprint: ex?.lastTradesFingerprint,
    zeroPointSeedDone: true,
  };
  targetFeedLoops.set(key, state);
  void runTargetFeedTick(key);
  state.timer = setInterval(() => void runTargetFeedTick(key), pollMs);
  res.json({
    ok: true,
    mode: "watch",
    key,
    targetAddress: userTrim,
    conditionId: marketTrim || undefined,
    eventId: isGlobal ? undefined : eventIdNum,
    global: isGlobal,
  });
});

app.post("/api/feed/stop", async (req, res) => {
  const schema = z
    .object({
      targetAddress: z.string().min(1),
      conditionId: z.string().min(1).optional(),
      eventId: z.coerce.number().int().min(1).optional(),
      global: z.boolean().optional(),
    })
    .refine(
      (d) =>
        d.global === true ||
        Boolean(d.conditionId?.trim()) ||
        (d.eventId != null && d.eventId >= 1),
      {
        message: "Provide global=true, eventId, or conditionId",
        path: ["eventId"],
      },
    );
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  let key: string;
  try {
    key = await copyLoopKeyFromParams(
      parsed.data.targetAddress,
      parsed.data.conditionId,
      parsed.data.eventId,
      parsed.data.global === true,
    );
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? String(err) });
  }
  const s = targetFeedLoops.get(key);
  if (!s) return res.json({ ok: true, alreadyStopped: true });
  if (s.timer) clearInterval(s.timer);
  targetFeedLoops.delete(key);
  res.json({ ok: true, alreadyStopped: false });
});

app.post("/api/copy/start", async (req, res) => {
  const schema = z
    .object({
      targetAddress: z.string().min(1),
      conditionId: z.string().min(1).optional(),
      eventId: z.coerce.number().int().min(1).optional(),
      global: z.boolean().optional(),
      pollMs: z.coerce.number().int().min(200).max(60000).optional(),
      dryRun: z.boolean().optional().default(true),
      copySizePercent: z.coerce.number().min(0.01).max(10_000).optional().default(100),
      minCopySize: z.number().min(5).optional(),
      maxCopySize: z.number().positive().optional(),
    })
    .refine((d) => d.global === true || Boolean(d.conditionId?.trim()), {
      message: "Provide conditionId or global=true",
      path: ["conditionId"],
    })
    .refine((d) => !(d.minCopySize != null && d.maxCopySize != null) || d.maxCopySize > d.minCopySize, {
      message: "maxCopySize must be greater than minCopySize",
      path: ["maxCopySize"],
    });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { pollMs = COPY_POLL_MS_DEFAULT, dryRun, copySizePercent, minCopySize, maxCopySize } = parsed.data;
  const copySizing: CopySizingOptions = {
    sizePercent: copySizePercent,
    minSize: minCopySize,
    maxSize: maxCopySize,
  };
  const userTrim = parsed.data.targetAddress.trim();
  const isGlobal = parsed.data.global === true;

  if (isGlobal) {
    stopAllFeedLoopsForUser(userTrim);
  } else {
    const gk = getGlobalCopyLoopKey(userTrim);
    const gs = targetFeedLoops.get(gk);
    if (gs?.timer) clearInterval(gs.timer);
    targetFeedLoops.delete(gk);
  }

  let eventIdNum = 0;
  let marketTrim = "";
  let key: string;
  try {
    if (isGlobal) {
      key = getGlobalCopyLoopKey(userTrim);
    } else {
      marketTrim = normalizeConditionId(parsed.data.conditionId!);
      eventIdNum = await resolveEventIdForCopy(marketTrim, parsed.data.eventId);
      key = getCopyLoopKey(userTrim, eventIdNum);
    }
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? String(err) });
  }

  const existing = targetFeedLoops.get(key);
  if (existing?.timer) clearInterval(existing.timer);
  copyActivityByKey.delete(key);

  let l2Client: any = null;
  if (!dryRun) {
    try {
      l2Client = await maybeCreateClobL2Client();

      try {
        const keys = await l2Client.getApiKeys();
        log.info("keys", keys);
        log.info("[auth:check]", JSON.stringify(keys));
      } catch (e: any) {
        log.error("[auth:check:failed]", e?.message ?? e);
      }

      if (!l2Client) {
        return res.status(400).json({ error: "Auto-copy requested but CLOB_PRIVATE_KEY and CLOB_FUNDER_ADDRESS are not set." });
      }
    } catch (err: any) {
      return res.status(400).json({ error: err?.message ?? String(err) });
    }
  }

  let mapping: MarketMapping | undefined;
  if (!isGlobal) {
    mapping = await mapConditionIdToUpDown(marketTrim);
  }

  const t0 = Math.floor(Date.now() / 1000);
  const state: TargetFeedLoopState = {
    pollMs,
    userTrim,
    eventIdNum,
    marketTrim,
    key,
    isGlobal,
    copyEnabled: true,
    copyStartedAtSec: t0,
    recentTradesForUi: [],
    processedCopyKeys: new Set(),
    dryRun,
    copySizing,
    mapping,
    mappingByCondition: isGlobal ? new Map() : undefined,
    l2Client,
    lastTradesFingerprint: existing?.lastTradesFingerprint,
    zeroPointSeedDone: false,
  };
  targetFeedLoops.set(key, state);
  void runTargetFeedTick(key);
  state.timer = setInterval(() => void runTargetFeedTick(key), pollMs);

  res.json({
    ok: true,
    running: true,
    key,
    targetAddress: userTrim,
    conditionId: marketTrim || undefined,
    eventId: isGlobal ? undefined : eventIdNum,
    global: isGlobal,
  });
});

app.post("/api/copy/stop", async (req, res) => {
  const schema = z
    .object({
      targetAddress: z.string().min(1),
      conditionId: z.string().min(1).optional(),
      eventId: z.coerce.number().int().min(1).optional(),
      global: z.boolean().optional(),
      fullStop: z.boolean().optional().default(false),
    })
    .refine(
      (d) =>
        d.global === true ||
        Boolean(d.conditionId?.trim()) ||
        (d.eventId != null && d.eventId >= 1),
      {
        message: "Provide global=true, eventId, or conditionId",
        path: ["eventId"],
      },
    );
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  let key: string;
  try {
    key = await copyLoopKeyFromParams(
      parsed.data.targetAddress,
      parsed.data.conditionId,
      parsed.data.eventId,
      parsed.data.global === true,
    );
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? String(err) });
  }

  const s = targetFeedLoops.get(key);
  if (!s) {
    return res.json({ ok: true, alreadyStopped: true });
  }

  if (parsed.data.fullStop) {
    if (s.timer) clearInterval(s.timer);
    targetFeedLoops.delete(key);
    return res.json({ ok: true, alreadyStopped: false, mode: "stopped" });
  }

  if (!s.copyEnabled) {
    return res.json({ ok: true, alreadyStopped: true, mode: "watch" });
  }

  s.copyEnabled = false;
  s.dryRun = undefined;
  s.copySizing = undefined;
  s.mapping = undefined;
  s.mappingByCondition = undefined;
  s.l2Client = null;
  s.copyBaselineSent = undefined;
  s.processedCopyKeys = new Set();
  s.zeroPointSeedDone = false;
  const nowSec = Math.floor(Date.now() / 1000);
  s.copyStartedAtSec = nowSec;
  s.recentTradesForUi = [];
  s.lastTradesFingerprint = undefined;

  if (!s.timer) {
    s.timer = setInterval(() => void runTargetFeedTick(key), s.pollMs);
  }

  res.json({ ok: true, alreadyStopped: false, mode: "watch" });
});

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: err?.message ?? "Internal server error" });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  try {
    const host = request.headers.host ?? "localhost";
    const url = new URL(request.url ?? "/", `http://${host}`);

    if (url.pathname === "/api/chart/ws") {
      const upToken = url.searchParams.get("upToken")?.trim() ?? "";
      const downToken = url.searchParams.get("downToken")?.trim() ?? "";
      const startTs = Number(url.searchParams.get("startTs"));
      const endTs = Number(url.searchParams.get("endTs"));
      if (!upToken || !downToken || !Number.isFinite(startTs) || !Number.isFinite(endTs) || endTs <= startTs) {
        socket.destroy();
        return;
      }
      const relayKey = chartRelayKey(upToken, downToken, startTs, endTs);
      wss.handleUpgrade(request, socket, head, (ws) => {
        attachChartRelayClient(relayKey, ws, upToken, downToken, startTs, endTs);
        try {
          ws.send(JSON.stringify({ type: "subscribed", kind: "chart", relayKey }));
        } catch {
          // ignore
        }
      });
      return;
    }

    if (url.pathname === "/api/copy/ws") {
      const targetAddress = url.searchParams.get("targetAddress")?.trim();
      const globalWs =
        url.searchParams.get("global") === "1" || url.searchParams.get("global") === "true";
      if (globalWs) {
        if (!targetAddress) {
          socket.destroy();
          return;
        }
        const loopKey = getGlobalCopyLoopKey(targetAddress);
        wss.handleUpgrade(request, socket, head, (ws) => {
          subscribeCopyActivityWs(loopKey, ws);
          try {
            ws.send(JSON.stringify({ type: "subscribed", key: loopKey, global: true }));
          } catch {
            // ignore
          }
        });
        return;
      }
      const eventIdStr = url.searchParams.get("eventId");
      const eventId = eventIdStr != null ? Number(eventIdStr) : NaN;
      if (!targetAddress || !Number.isFinite(eventId) || eventId < 1) {
        socket.destroy();
        return;
      }
      const loopKey = getCopyLoopKey(targetAddress, Math.floor(eventId));
      wss.handleUpgrade(request, socket, head, (ws) => {
        subscribeCopyActivityWs(loopKey, ws);
        try {
          ws.send(JSON.stringify({ type: "subscribed", key: loopKey, eventId: Math.floor(eventId) }));
        } catch {
          // ignore
        }
      });
      return;
    }

    socket.destroy();
  } catch {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  log.info(`Backend listening on http://localhost:${PORT}`);
});

