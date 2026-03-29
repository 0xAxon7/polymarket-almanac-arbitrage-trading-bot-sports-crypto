export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "";

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

export type MarketTypesResponse = { marketTypes: string[] };
export type MarketListResponse = {
  markets: { conditionId: string; question: string; slug?: string }[];
};
export type Chain = "btc" | "eth" | "sol" | "xrp";
export type Duration = "5m" | "15m";
export type CryptoMarketsResponse = {
  chain: Chain;
  duration: Duration;
  markets: {
    conditionId: string;
    question: string;
    slug?: string;
    startDate?: string;
    endDate?: string;
    /** Gamma/Data API event id when the list payload includes it. */
    eventId?: number;
  }[];
};

export type CurrentCryptoMarketResponse = {
  chain: Chain;
  duration: Duration;
  nowTs: number;
  currentBucketStartTs: number;
  market:
    | {
        conditionId: string;
        question: string;
        slug?: string;
        startDate?: string;
        endDate?: string;
        eventId?: number;
      }
    | null;
};
export type MarketMappingResponse = {
  conditionId: string;
  up: { tokenId: string; outcome: string };
  down: { tokenId: string; outcome: string };
  tokenCount: number;
  tickSize?: string;
  negRisk?: boolean;
};
export type ChartResponse = {
  conditionId: string;
  slug?: string;
  up: { tokenId: string; outcome: string };
  down: { tokenId: string; outcome: string };
  window?: { startTs: number; endTs: number } | null;
  upSeries: { t: number; p: number }[];
  downSeries: { t: number; p: number }[];
};
export type TargetTradesResponse = {
  trades: {
    timestamp: number;
    side: "BUY" | "SELL";
    outcome: string;
    outcomeIndex: number;
    price: number;
    size: number;
    transactionHash: string;
    title: string;
  }[];
};

export async function getMarketTypes(): Promise<MarketTypesResponse> {
  return apiFetch("/api/market/types");
}

export async function getMarkets(typeId: string): Promise<MarketListResponse> {
  const params = new URLSearchParams({ typeId });
  return apiFetch(`/api/market/list?${params.toString()}`);
}

export async function getCryptoMarkets(chain: Chain, duration: Duration): Promise<CryptoMarketsResponse> {
  const params = new URLSearchParams({ chain, duration });
  return apiFetch(`/api/crypto/markets?${params.toString()}`);
}

export async function getCurrentCryptoMarket(chain: Chain, duration: Duration): Promise<CurrentCryptoMarketResponse> {
  const params = new URLSearchParams({ chain, duration });
  return apiFetch(`/api/crypto/current?${params.toString()}`);
}

export async function getChart(conditionId: string, slug?: string): Promise<ChartResponse> {
  const params = new URLSearchParams({ conditionId, interval: "1d", fidelity: "60" });
  if (slug) params.set("slug", slug);
  return apiFetch(`/api/chart?${params.toString()}`);
}

export async function getTargetTrades(args: {
  userAddress: string;
  /** Prefer when known; Data API filters by eventId. */
  eventId?: number;
  conditionId?: string;
  limit?: number;
}): Promise<TargetTradesResponse> {
  const params = new URLSearchParams({
    userAddress: args.userAddress,
    limit: String(args.limit ?? 1000),
  });
  if (args.conditionId?.trim()) params.set("conditionId", args.conditionId.trim());
  if (args.eventId != null && Number.isFinite(args.eventId) && args.eventId >= 1) {
    params.set("eventId", String(Math.floor(args.eventId)));
  }
  return apiFetch(`/api/target-trades?${params.toString()}`);
}

export async function startCopy(args: {
  targetAddress: string;
  conditionId: string;
  eventId?: number;
  dryRun?: boolean;
  pollMs?: number;
  /** Percent of target trade size (outcome shares). Default 100. */
  copySizePercent?: number;
  minCopySize?: number;
  maxCopySize?: number;
}): Promise<{
  ok: boolean;
  running: boolean;
  key: string;
  targetAddress: string;
  conditionId: string;
  eventId: number;
}> {
  const body: Record<string, unknown> = {
    targetAddress: args.targetAddress,
    conditionId: args.conditionId,
    dryRun: args.dryRun ?? true,
    pollMs: args.pollMs ?? 5000,
    copySizePercent: args.copySizePercent ?? 100,
  };
  if (args.eventId != null && Number.isFinite(args.eventId) && args.eventId >= 1) {
    body.eventId = Math.floor(args.eventId);
  }
  if (typeof args.minCopySize === "number" && Number.isFinite(args.minCopySize)) {
    body.minCopySize = args.minCopySize;
  }
  if (typeof args.maxCopySize === "number" && Number.isFinite(args.maxCopySize)) {
    body.maxCopySize = args.maxCopySize;
  }
  return apiFetch("/api/copy/start", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function stopCopy(args: {
  targetAddress: string;
  conditionId?: string;
  eventId?: number;
  /** When true, stops the target trade feed entirely (e.g. market migrate). */
  fullStop?: boolean;
}): Promise<{ ok: boolean; alreadyStopped?: boolean; mode?: string }> {
  const body: Record<string, unknown> = { targetAddress: args.targetAddress };
  if (args.conditionId?.trim()) body.conditionId = args.conditionId.trim();
  if (args.eventId != null && Number.isFinite(args.eventId) && args.eventId >= 1) {
    body.eventId = Math.floor(args.eventId);
  }
  if (args.fullStop === true) body.fullStop = true;
  return apiFetch("/api/copy/stop", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function startTargetFeed(args: {
  targetAddress: string;
  conditionId: string;
  eventId?: number;
  pollMs?: number;
}): Promise<{
  ok: boolean;
  mode: string;
  key: string;
  targetAddress: string;
  conditionId: string;
  eventId: number;
  message?: string;
}> {
  const body: Record<string, unknown> = {
    targetAddress: args.targetAddress,
    conditionId: args.conditionId,
    pollMs: args.pollMs ?? 5000,
  };
  if (args.eventId != null && Number.isFinite(args.eventId) && args.eventId >= 1) {
    body.eventId = Math.floor(args.eventId);
  }
  return apiFetch("/api/feed/start", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function stopTargetFeed(args: {
  targetAddress: string;
  conditionId?: string;
  eventId?: number;
}): Promise<{ ok: boolean; alreadyStopped?: boolean }> {
  const body: Record<string, unknown> = { targetAddress: args.targetAddress };
  if (args.conditionId?.trim()) body.conditionId = args.conditionId.trim();
  if (args.eventId != null && Number.isFinite(args.eventId) && args.eventId >= 1) {
    body.eventId = Math.floor(args.eventId);
  }
  return apiFetch("/api/feed/stop", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export type WalletResponse = { address: string | null };

export async function getWallet(): Promise<WalletResponse> {
  return apiFetch("/api/wallet");
}

export type CopyActivityKind = "simulated" | "order_posted" | "error" | "baseline" | "skipped";

export type CopyActivityEvent = {
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

export type CopyActivityResponse = { events: CopyActivityEvent[] };

export async function getCopyActivity(args: {
  targetAddress: string;
  conditionId?: string;
  eventId?: number;
  limit?: number;
}): Promise<CopyActivityResponse> {
  const params = new URLSearchParams({
    targetAddress: args.targetAddress,
    limit: String(args.limit ?? 50),
  });
  if (args.conditionId?.trim()) params.set("conditionId", args.conditionId.trim());
  if (args.eventId != null && Number.isFinite(args.eventId) && args.eventId >= 1) {
    params.set("eventId", String(Math.floor(args.eventId)));
  }
  return apiFetch(`/api/copy/activity?${params.toString()}`);
}

/** WebSocket: `target_trades` + `copy_activity` on the same session key. */
export function getCopyActivityWsUrl(targetAddress: string, eventId: number): string {
  const params = new URLSearchParams({ targetAddress, eventId: String(Math.floor(eventId)) });
  const path = `/api/copy/ws?${params.toString()}`;
  if (API_BASE_URL.startsWith("http://") || API_BASE_URL.startsWith("https://")) {
    return `${API_BASE_URL.replace(/^http/, "ws")}${path}`;
  }
  const proto = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = typeof window !== "undefined" ? window.location.host : "localhost:5173";
  return `${proto}//${host}${path}`;
}

/** Backend relay of Polymarket CLOB market stream (best_bid_ask → chart_mid). */
export function getChartWsUrl(args: {
  upToken: string;
  downToken: string;
  startTs: number;
  endTs: number;
}): string {
  const params = new URLSearchParams({
    upToken: args.upToken,
    downToken: args.downToken,
    startTs: String(args.startTs),
    endTs: String(args.endTs),
  });
  const path = `/api/chart/ws?${params.toString()}`;
  if (API_BASE_URL.startsWith("http://") || API_BASE_URL.startsWith("https://")) {
    return `${API_BASE_URL.replace(/^http/, "ws")}${path}`;
  }
  const proto = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = typeof window !== "undefined" ? window.location.host : "localhost:5173";
  return `${proto}//${host}${path}`;
}

