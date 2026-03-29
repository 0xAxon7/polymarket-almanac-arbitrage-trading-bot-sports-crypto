import { useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Chain,
  ChartResponse,
  CopyActivityEvent,
  Duration,
  getChart,
  getCopyActivity,
  getCryptoMarkets,
  getCurrentCryptoMarket,
  getChartWsUrl,
  getCopyActivityWsUrl,
  getTargetTrades,
  getWallet,
  startCopy,
  startTargetFeed,
  stopCopy,
  stopTargetFeed,
} from "./api";

type MarketListItem = { conditionId: string; question: string; slug?: string; eventId?: number };
type Point = { t: number; p: number };

/** Local wall time hh:mm (tooltips, tables, chart axis start/end). */
function formatTimeHm(tSeconds: number) {
  const d = new Date(tSeconds * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Polymarket trades: unix seconds (~1e9) vs ms (~1e12) — normalize to seconds for sort/display. */
function tradeTimestampSeconds(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n > 1e12) return Math.floor(n / 1000);
  return Math.floor(n);
}

function compareTradesNewestFirst(
  a: { timestamp: unknown; transactionHash?: string },
  b: { timestamp: unknown; transactionHash?: string },
): number {
  const tb = tradeTimestampSeconds(b.timestamp);
  const ta = tradeTimestampSeconds(a.timestamp);
  if (tb !== ta) return tb - ta;
  return String(b.transactionHash ?? "").localeCompare(String(a.transactionHash ?? ""));
}

/** Trade tables: today shows hh:mm; other days M/D hh:mm so multi-day lists read chronologically. */
function formatTradeTableTime(raw: unknown) {
  const sec = tradeTimestampSeconds(raw);
  const d = new Date(sec * 1000);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** Local minutes only (chart x-axis interior ticks). */
function formatMinuteOnly(tSeconds: number) {
  const d = new Date(tSeconds * 1000);
  return String(d.getMinutes()).padStart(2, "0");
}

function formatChartXAxisTick(value: number, ticks: number[] | undefined) {
  if (!ticks?.length) return formatTimeHm(value);
  const first = ticks[0];
  const last = ticks[ticks.length - 1];
  if (value === first || value === last) return formatTimeHm(value);
  return formatMinuteOnly(value);
}

function formatActivityKind(kind: CopyActivityEvent["kind"]) {
  if (kind === "simulated") return "Dry run";
  if (kind === "order_posted") return "Order posted";
  if (kind === "baseline") return "Ready";
  if (kind === "skipped") return "Skipped";
  return "Error";
}

function parseOptionalPositiveSize(s: string): number | undefined {
  const t = s.trim();
  if (!t) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

/** Min copy field: empty or a number ≥ 5. */
function parseOptionalMinCopySize(s: string): number | undefined {
  const t = s.trim();
  if (!t) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 5) return undefined;
  return n;
}

function sameConditionId(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function getCopySizingForApi(
  pct: number,
  minStr: string,
  maxStr: string,
): { copySizePercent: number; minCopySize?: number; maxCopySize?: number } {
  if (!Number.isFinite(pct) || pct < 0.01) {
    throw new Error("Copy size % must be a number ≥ 0.01");
  }
  const minV = parseOptionalMinCopySize(minStr);
  const maxV = parseOptionalPositiveSize(maxStr);
  if (minStr.trim() && minV === undefined) {
    throw new Error("Invalid min copy size (use a number ≥ 5 shares, or leave empty)");
  }
  if (maxStr.trim() && maxV === undefined) throw new Error("Invalid max copy size (need a positive number)");
  if (minV != null && maxV != null && maxV <= minV) {
    throw new Error("Max copy size must be greater than min copy size");
  }
  return {
    copySizePercent: pct,
    ...(minV != null ? { minCopySize: minV } : {}),
    ...(maxV != null ? { maxCopySize: maxV } : {}),
  };
}

function formatActivityDetail(e: CopyActivityEvent) {
  if (e.kind === "baseline" && e.message) return e.message;
  if (e.kind === "skipped" && e.message) return e.message;
  if (e.kind === "error" && e.message) return e.message;
  const bits = [
    e.side,
    e.outcome,
    e.price != null && Number.isFinite(e.price) ? `@ ${e.price}` : "",
    e.size != null && Number.isFinite(e.size) ? `size ${e.size}` : "",
  ].filter(Boolean);
  const base = bits.join(" ");
  const tx = e.targetTransactionHash;
  if (tx && e.kind !== "error") return `${base} · tx ${tx.slice(0, 10)}…`;
  return base || "—";
}


export default function App() {
  const [chain, setChain] = useState<Chain>("btc");
  const [duration, setDuration] = useState<Duration>("15m");
  const [markets, setMarkets] = useState<MarketListItem[]>([]);
  const [selectedConditionId, setSelectedConditionId] = useState<string>("");
  const selectedConditionIdRef = useRef(selectedConditionId);
  useEffect(() => {
    selectedConditionIdRef.current = selectedConditionId;
  }, [selectedConditionId]);

  const [targetAddress, setTargetAddress] = useState<string>("");
  const [targetTrades, setTargetTrades] = useState<
    { timestamp: number; side: "BUY" | "SELL"; outcome: string; outcomeIndex: number; price: number; size: number; transactionHash: string; title: string }[]
  >([]);

  const [chart, setChart] = useState<ChartResponse | null>(null);
  const [chartError, setChartError] = useState<string>("");

  // Realtime updates from CLOB websocket.
  const [liveUpSeries, setLiveUpSeries] = useState<Point[]>([]);
  const [liveDownSeries, setLiveDownSeries] = useState<Point[]>([]);
  const chartWsRef = useRef<WebSocket | null>(null);

  const [status, setStatus] = useState<string>("");
  const [copyKey, setCopyKey] = useState<string>("");
  const [copyRunning, setCopyRunning] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [dryRun, setDryRun] = useState<boolean>(true);
  const [copySizePercent, setCopySizePercent] = useState<number>(100);
  const [minCopySizeInput, setMinCopySizeInput] = useState<string>("");
  const [maxCopySizeInput, setMaxCopySizeInput] = useState<string>("");
  const [tradePanelTab, setTradePanelTab] = useState<"target" | "copy" | "my">("target");

  const [funderAddress, setFunderAddress] = useState<string | null>(null);
  const [myTrades, setMyTrades] = useState<
    { timestamp: number; side: "BUY" | "SELL"; outcome: string; outcomeIndex: number; price: number; size: number; transactionHash: string; title: string }[]
  >([]);
  const [copyActivity, setCopyActivity] = useState<CopyActivityEvent[]>([]);
  const [copySession, setCopySession] = useState<{
    targetAddress: string;
    conditionId: string;
    eventId: number;
  } | null>(null);
  const copyMigrateGenRef = useRef(0);
  const copyRunningRef = useRef(false);
  useEffect(() => {
    copyRunningRef.current = copyRunning;
  }, [copyRunning]);

  const feedParamsRef = useRef<{
    targetAddress: string;
    conditionId: string;
    eventId?: number;
  } | null>(null);
  /** Resolved eventId for WS (backend); list payload may omit eventId. */
  const [feedEventId, setFeedEventId] = useState<number | null>(null);

  const selectedEventId = useMemo(() => {
    const m = markets.find((x) => sameConditionId(x.conditionId, selectedConditionId));
    return m?.eventId;
  }, [markets, selectedConditionId]);

  const targetAddressRef = useRef(targetAddress);
  useEffect(() => {
    targetAddressRef.current = targetAddress;
  }, [targetAddress]);

  useEffect(() => {
    let cancelled = false;
    void getWallet()
      .then((w) => {
        if (!cancelled) setFunderAddress(w.address);
      })
      .catch(() => {
        if (!cancelled) setFunderAddress(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setMarkets([]);
        setSelectedConditionId("");
        const res = await getCryptoMarkets(chain, duration);
        setMarkets(res.markets);
        const first = res.markets[0];
        setSelectedConditionId(first?.conditionId ?? "");
        setStatus(res.markets.length ? "" : "No current markets found for this chain + duration.");
      } catch (e: any) {
        setStatus(`Failed to load crypto markets: ${e?.message ?? String(e)}`);
      } finally {
        setLoading(false);
      }
    })();
  }, [chain, duration]);

  useEffect(() => {
    if (!selectedConditionId) return;
    (async () => {
      try {
        setLoading(true);
        setChartError("");
        setLiveUpSeries([]);
        setLiveDownSeries([]);
        const selectedMarket = markets.find((m) => m.conditionId === selectedConditionId);
        const res = await getChart(selectedConditionId, selectedMarket?.slug);
        setChart(res);
      } catch (e: any) {
        setChartError(e?.message ?? String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [selectedConditionId, markets]);

  // Auto-advance the selected market when the current bucket ends.
  useEffect(() => {
    let timer: number | undefined;
    let cancelled = false;

    const poll = async () => {
      if (!chain || !duration) return;
      try {
        const cur = await getCurrentCryptoMarket(chain, duration);
        if (cancelled) return;
        const newId = cur.market?.conditionId;
        if (!newId) return;
        if (newId !== selectedConditionId) {
          // Ensure the dropdown contains the new market; otherwise refetch the list.
          const exists = markets.some((m) => m.conditionId === newId);
          if (!exists) {
            const nextMarkets = await getCryptoMarkets(chain, duration);
            if (cancelled) return;
            setMarkets(nextMarkets.markets);
          }
          setSelectedConditionId(newId);
        }
      } catch {
        // ignore polling errors
      }
    };

    // Poll reasonably often for 5m buckets.
    timer = window.setInterval(() => {
      void poll();
    }, 10_000);

    // Also poll immediately on mount/change.
    void poll();

    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [chain, duration, selectedConditionId, markets]);

  const mergedChartData = useMemo(() => {
    if (!chart) return [];
    const byT = new Map<number, { t: number; up?: number; down?: number }>();

    const upAll = chart.upSeries.concat(liveUpSeries);
    const downAll = chart.downSeries.concat(liveDownSeries);

    for (const pt of upAll) byT.set(pt.t, { t: pt.t, ...(byT.get(pt.t) ?? {}), up: pt.p });
    for (const pt of downAll) {
      const existing = byT.get(pt.t);
      if (existing) byT.set(pt.t, { ...existing, down: pt.p });
      else byT.set(pt.t, { t: pt.t, down: pt.p });
    }
    return Array.from(byT.values()).sort((a, b) => a.t - b.t);
  }, [chart, liveUpSeries, liveDownSeries]);

  const latestPrices = useMemo(() => {
    if (!chart) return { up: null as number | null, down: null as number | null };

    const pickLatest = (pts: Point[]) => {
      if (!pts.length) return null;
      return pts.reduce((best, cur) => (cur.t >= best.t ? cur : best), pts[0]).p;
    };

    const up = pickLatest(liveUpSeries.length ? liveUpSeries : chart.upSeries);
    const down = pickLatest(liveDownSeries.length ? liveDownSeries : chart.downSeries);
    return { up, down };
  }, [chart, liveUpSeries, liveDownSeries]);

  const xAxisTicks = useMemo(() => {
    const startTs = chart?.window?.startTs;
    const endTs = chart?.window?.endTs;
    if (!startTs || !endTs || endTs <= startTs) return undefined;

    const ticks: number[] = [];
    // One-minute spacing so 15m markets show 15 one-minute steps.
    for (let t = startTs; t <= endTs; t += 60) ticks.push(t);
    if (ticks[ticks.length - 1] !== endTs) ticks.push(endTs);
    return ticks;
  }, [chart?.window?.startTs, chart?.window?.endTs]);

  // Backend relays Polymarket CLOB market WS (best_bid_ask mid only) for the live chart.
  useEffect(() => {
    if (!chart?.window?.endTs) return;
    if (!chart?.up?.tokenId || !chart?.down?.tokenId) return;

    const endTs = chart.window.endTs;
    const startTs = chart.window.startTs ?? 0;
    const upTokenId = chart.up.tokenId;
    const downTokenId = chart.down.tokenId;

    const nowTs = Math.floor(Date.now() / 1000);
    if (nowTs >= endTs) return;

    chartWsRef.current?.close();
    chartWsRef.current = null;

    const url = getChartWsUrl({
      upToken: upTokenId,
      downToken: downTokenId,
      startTs,
      endTs,
    });
    const socket = new WebSocket(url);
    chartWsRef.current = socket;

    const upsert = (prev: Point[], point: Point) => {
      const idx = prev.findIndex((p) => p.t === point.t);
      if (idx >= 0) {
        const next = prev.slice();
        next[idx] = point;
        return next;
      }
      const next = [...prev, point];
      next.sort((a, b) => a.t - b.t);
      return next.length > 2000 ? next.slice(next.length - 2000) : next;
    };

    socket.onmessage = (event) => {
      try {
        const raw = typeof event.data === "string" ? event.data : String(event.data);
        const msg = JSON.parse(raw) as { type?: string; asset_id?: string; t?: number; p?: number };
        if (msg.type !== "chart_mid" || !msg.asset_id) return;
        const assetId = String(msg.asset_id);
        if (assetId !== upTokenId && assetId !== downTokenId) return;
        const t = Number(msg.t);
        const p = Number(msg.p);
        if (!Number.isFinite(t) || !Number.isFinite(p)) return;
        if (t < startTs || t > endTs) return;
        if (assetId === upTokenId) {
          setLiveUpSeries((prev) => upsert(prev, { t, p }));
        } else {
          setLiveDownSeries((prev) => upsert(prev, { t, p }));
        }
      } catch {
        // ignore
      }
    };

    const closeTimer = window.setTimeout(() => {
      socket.close();
    }, Math.max((endTs - Math.floor(Date.now() / 1000)) * 1000, 0));

    return () => {
      window.clearTimeout(closeTimer);
      if (chartWsRef.current === socket) {
        chartWsRef.current = null;
      }
      socket.close();
    };
  }, [chart?.conditionId, chart?.window?.startTs, chart?.window?.endTs, chart?.up?.tokenId, chart?.down?.tokenId]);

  async function loadTargetTrades() {
    if (!selectedConditionId || !targetAddress) return;
    try {
      setLoading(true);
      setStatus("Loading target trades...");
      const res = await getTargetTrades({
        conditionId: selectedConditionId,
        eventId: selectedEventId,
        userAddress: targetAddress,
        limit: 1000,
      });
      setTargetTrades(res.trades);
      setStatus(`Loaded ${res.trades.length} trades for target.`);
    } catch (e: any) {
      setStatus(`Failed to load target trades: ${e?.message ?? String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  // Target trade feed: backend poll + WS (same loop as copy when copy is on).
  useEffect(() => {
    let cancelled = false;
    const addr = targetAddress.trim();
    const c = selectedConditionId;
    const e = selectedEventId;

    const run = async () => {
      if (!c || !addr) {
        const fp = feedParamsRef.current;
        if (fp && !copyRunningRef.current) {
          await stopTargetFeed(fp).catch(() => {});
          feedParamsRef.current = null;
        }
        if (!addr) {
          setTargetTrades([]);
          setFeedEventId(null);
        }
        return;
      }
      if (copyRunningRef.current) return;

      const fp = feedParamsRef.current;
      if (
        fp &&
        (fp.conditionId !== c || fp.targetAddress !== addr || fp.eventId !== e)
      ) {
        await stopTargetFeed(fp).catch(() => {});
        feedParamsRef.current = null;
      }

      await new Promise((r) => setTimeout(r, 500));
      if (cancelled || copyRunningRef.current) return;

      try {
        const res = await startTargetFeed({
          targetAddress: addr,
          conditionId: c,
          eventId: e,
          pollMs: 5000,
        });
        if (cancelled || copyRunningRef.current) return;
        feedParamsRef.current = {
          targetAddress: res.targetAddress,
          conditionId: res.conditionId,
          eventId: res.eventId,
        };
        setFeedEventId(res.eventId);
        const snap = await getTargetTrades({
          userAddress: addr,
          conditionId: res.conditionId,
          eventId: res.eventId,
          limit: 1000,
        });
        if (!cancelled) setTargetTrades(snap.trades);
      } catch {
        // ignore
      }
    };

    void run();
    return () => {
      cancelled = true;
      const fp = feedParamsRef.current;
      if (fp && !copyRunningRef.current) {
        void stopTargetFeed(fp).catch(() => {});
        feedParamsRef.current = null;
      }
    };
  }, [selectedConditionId, selectedEventId, targetAddress]);

  useEffect(() => {
    if (!copyRunning || !selectedConditionId) return;
    const addr = funderAddress?.trim();
    if (!addr) {
      setMyTrades([]);
      return;
    }
    const tick = () => {
      void getTargetTrades({
        conditionId: selectedConditionId,
        eventId: selectedEventId,
        userAddress: addr,
        limit: 1000,
      })
        .then((res) => setMyTrades(res.trades))
        .catch(() => {});
    };
    tick();
    const id = window.setInterval(tick, 8000);
    return () => window.clearInterval(id);
  }, [copyRunning, selectedConditionId, selectedEventId, funderAddress]);

  useEffect(() => {
    if (!copyRunning || !copySession) {
      if (!copyRunning) setCopyActivity([]);
      return;
    }
    void getCopyActivity({
      targetAddress: copySession.targetAddress,
      conditionId: copySession.conditionId,
      eventId: copySession.eventId,
      limit: 50,
    })
      .then((res) => setCopyActivity(res.events))
      .catch(() => {});
  }, [copyRunning, copySession]);

  useEffect(() => {
    const addr = targetAddress.trim();
    const eid = feedEventId ?? selectedEventId;
    if (!selectedConditionId || !addr || eid == null || !Number.isFinite(eid) || eid < 1) {
      return () => {};
    }
    const url = getCopyActivityWsUrl(addr, Math.floor(eid));
    const socket = new WebSocket(url);
    socket.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          type?: string;
          event?: CopyActivityEvent;
          trades?: {
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
        if (msg.type === "target_trades" && Array.isArray(msg.trades)) {
          setTargetTrades(msg.trades);
          return;
        }
        if (msg.type === "copy_activity" && msg.event) {
          setCopyActivity((prev) => [msg.event!, ...prev].slice(0, 100));
        }
      } catch {
        // ignore
      }
    };
    return () => socket.close();
  }, [selectedConditionId, selectedEventId, targetAddress, feedEventId]);

  // Target input must match the running session; editing it stops copy (user presses Start again for the new wallet).
  useEffect(() => {
    if (!copyRunning || !copySession) return;
    const form = targetAddress.trim().toLowerCase();
    const sessAddr = copySession.targetAddress.trim().toLowerCase();
    if (form === sessAddr) return;

    copyMigrateGenRef.current += 1;
    const sess = copySession;
    let cancelled = false;

    void (async () => {
      try {
        await stopCopy({
          targetAddress: sess.targetAddress,
          conditionId: sess.conditionId,
          eventId: sess.eventId,
          fullStop: true,
        });
      } catch {
        // still reset UI
      }
      if (cancelled) return;
      setCopyRunning(false);
      setCopyKey("");
      setCopySession(null);
      setCopyActivity([]);
      setStatus("Copy stopped: target address changed. Press Start to follow the new wallet.");
    })();

    return () => {
      cancelled = true;
    };
  }, [targetAddress, copyRunning, copySession]);

  // When the UI market advances (new time bucket), move the server copy loop to the new conditionId.
  useEffect(() => {
    if (!copyRunning || !copySession || !selectedConditionId) return;
    const nextId = selectedConditionId.trim();
    const prevId = copySession.conditionId.trim();
    if (sameConditionId(nextId, prevId)) return;
    const formTarget = targetAddress.trim().toLowerCase();
    if (formTarget !== copySession.targetAddress.trim().toLowerCase()) return;

    const gen = ++copyMigrateGenRef.current;
    let cancelled = false;
    const sess = copySession;

    void (async () => {
      try {
        setStatus("Moving copy to new market…");
        await stopCopy({
          targetAddress: sess.targetAddress,
          conditionId: prevId,
          eventId: sess.eventId,
          fullStop: true,
        });
        if (cancelled || gen !== copyMigrateGenRef.current) return;
        if (targetAddressRef.current.trim().toLowerCase() !== sess.targetAddress.toLowerCase()) {
          setCopyRunning(false);
          setCopyKey("");
          setCopySession(null);
          setCopyActivity([]);
          setStatus("Copy stopped: target address changed while switching market.");
          return;
        }
        let sizing: { copySizePercent: number; minCopySize?: number; maxCopySize?: number };
        try {
          sizing = getCopySizingForApi(copySizePercent, minCopySizeInput, maxCopySizeInput);
        } catch (e: any) {
          setCopyRunning(false);
          setCopyKey("");
          setCopySession(null);
          setCopyActivity([]);
          setStatus(`Copy migrate aborted: ${e?.message ?? String(e)}`);
          return;
        }
        const res = await startCopy({
          targetAddress: sess.targetAddress,
          conditionId: nextId,
          eventId: selectedEventId,
          dryRun,
          pollMs: 5000,
          ...sizing,
        });
        if (cancelled || gen !== copyMigrateGenRef.current) return;
        setCopyKey(res.key);
        setCopyRunning(res.running);
        setFeedEventId(res.eventId);
        setCopySession({
          targetAddress: res.targetAddress,
          conditionId: res.conditionId,
          eventId: res.eventId,
        });
        setStatus(`Copy running on new market (${res.key})`);
      } catch (e: any) {
        if (cancelled || gen !== copyMigrateGenRef.current) return;
        setCopyRunning(false);
        setCopyKey("");
        setCopySession(null);
        setCopyActivity([]);
        setStatus(
          `Copy migrate failed: ${e?.message ?? String(e)} — press Start Copy to run on this market.`,
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    copyRunning,
    copySession,
    selectedConditionId,
    selectedEventId,
    dryRun,
    targetAddress,
    copySizePercent,
    minCopySizeInput,
    maxCopySizeInput,
  ]);

  async function onStartCopy() {
    if (!selectedConditionId || !targetAddress) return;
    let sizing: { copySizePercent: number; minCopySize?: number; maxCopySize?: number };
    try {
      sizing = getCopySizingForApi(copySizePercent, minCopySizeInput, maxCopySizeInput);
    } catch (e: any) {
      setStatus(e?.message ?? String(e));
      return;
    }
    const payload = {
      targetAddress: targetAddress.trim(),
      conditionId: selectedConditionId.trim(),
      eventId: selectedEventId,
      dryRun,
      pollMs: 5000 as const,
      ...sizing,
    };
    const applyStartResult = (res: Awaited<ReturnType<typeof startCopy>>, note?: string) => {
      setCopyKey(res.key);
      setCopyRunning(res.running);
      setFeedEventId(res.eventId);
      setCopySession({
        targetAddress: res.targetAddress,
        conditionId: res.conditionId,
        eventId: res.eventId,
      });
      setStatus(
        note ?? (res.ok ? `Copy loop started: ${res.key}` : `Start failed`),
      );
    };
    try {
      setLoading(true);
      setStatus(`Starting copy loop (dryRun=${dryRun})...`);
      const res = await startCopy(payload);
      applyStartResult(res);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      const staleLoop =
        msg.includes("409") ||
        /already running/i.test(msg) ||
        /Copy loop already running/i.test(msg);
      if (staleLoop) {
        try {
          setStatus("Clearing stale copy loop on server, then starting…");
          await stopCopy({
            targetAddress: payload.targetAddress,
            conditionId: payload.conditionId,
            eventId: payload.eventId,
            fullStop: true,
          });
          const res = await startCopy(payload);
          applyStartResult(res, `Copy loop started: ${res.key} (synced with server)`);
        } catch (e2: any) {
          setStatus(`Failed to start copy: ${e2?.message ?? String(e2)}`);
        }
      } else {
        setStatus(`Failed to start copy: ${msg}`);
      }
    } finally {
      setLoading(false);
    }
  }

  async function onStopCopy() {
    copyMigrateGenRef.current += 1;
    const stopTarget = copySession?.targetAddress ?? targetAddress.trim();
    const stopConditionId = copySession?.conditionId ?? selectedConditionId;
    if (!stopConditionId || !stopTarget) return;
    try {
      setLoading(true);
      const res = await stopCopy({
        targetAddress: stopTarget,
        conditionId: stopConditionId,
        eventId: copySession?.eventId,
      });
      setCopyRunning(false);
      setCopyKey("");
      setCopySession(null);
      setStatus(
        res.alreadyStopped
          ? "No active copy loop on server (already stopped or backend restarted). UI reset."
          : "Copy loop stopped.",
      );
    } catch (e: any) {
      setStatus(`Failed to stop copy: ${e?.message ?? String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container">
      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2 style={{ margin: 0 }}>Polymarket Copy Trading Bot</h2>
            <div className="hint">Fetch a target’s trades + visualize the current UP/DOWN prices.</div>
          </div>
          <div className="pill">
            <span className="dot" />
            <span>{loading ? "Loading..." : "Ready"}</span>
          </div>
        </div>

        <div className="app-panel-gap" style={{ height: 12 }} />

        <div className="grid">
          <div className="panel grid-sidebar" style={{ padding: 14 }}>
            <div className="sidebar-controls">
            <label>Chain</label>
            <select value={chain} onChange={(e) => setChain(e.target.value as Chain)}>
              <option value="btc">Btc</option>
              <option value="eth">Eth</option>
              <option value="sol">Sol</option>
              <option value="xrp">Xrp</option>
            </select>

            <div style={{ height: 10 }} />

            <label>Duration</label>
            <select value={duration} onChange={(e) => setDuration(e.target.value as Duration)}>
              <option value="5m">5m</option>
              <option value="15m">15m</option>
            </select>

            <div style={{ height: 10 }} />

            <label>Market (conditionId)</label>
            <select
              value={selectedConditionId}
              onChange={(e) => setSelectedConditionId(e.target.value)}
              disabled={!markets.length}
            >
              {markets.map((m) => (
                <option key={m.conditionId} value={m.conditionId}>
                  {m.question ? `${m.question.slice(0, 60)}...` : m.conditionId}
                </option>
              ))}
            </select>

            <div style={{ height: 10 }} />

            <label>Target Address</label>
            <input
              value={targetAddress}
              onChange={(e) => setTargetAddress(e.target.value)}
              placeholder="0x... target wallet"
            />

            <div style={{ height: 10 }} />

            <div className="row" style={{ justifyContent: "space-between" }}>
              <button onClick={loadTargetTrades} disabled={!selectedConditionId || !targetAddress || loading}>
                Load Target Trades
              </button>
            </div>

            <div style={{ height: 12 }} />

            <div className="row" style={{ justifyContent: "space-between" }}>
              <label className="checkboxLabel">
                <input
                  type="checkbox"
                  checked={dryRun}
                  onChange={(e) => setDryRun(e.target.checked)}
                />
                Dry run mode
              </label>
            </div>
            <div className="hint">Dry run means monitor + simulate copy only, and do not place real orders.</div>
            <div style={{ height: 10 }} />

            <label>Copy size (% of target)</label>
            <input
              type="number"
              min={0.01}
              step={0.1}
              value={Number.isFinite(copySizePercent) ? copySizePercent : 100}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                setCopySizePercent(Number.isFinite(v) ? v : 100);
              }}
            />
            <div className="hint" style={{ marginTop: 4 }}>
              Scales the target’s trade size (outcome shares). If the % amount is below your min copy size, the order uses
              the min. Then max caps the size when set.
            </div>

            <div style={{ height: 8 }} />

            <label>Min copy size (shares, optional, minimum 5)</label>
            <input
              value={minCopySizeInput}
              onChange={(e) => setMinCopySizeInput(e.target.value)}
              placeholder="e.g. 5 (≥ 5 if set)"
              inputMode="decimal"
            />

            <div style={{ height: 8 }} />

            <label>Max copy size (shares, optional, must be greater than min if both set)</label>
            <input
              value={maxCopySizeInput}
              onChange={(e) => setMaxCopySizeInput(e.target.value)}
              placeholder="e.g. 50"
              inputMode="decimal"
            />

            <div style={{ height: 10 }} />

            <div className="row" style={{ justifyContent: "space-between" }}>
              <button
                onClick={onStartCopy}
                disabled={!selectedConditionId || !targetAddress || copyRunning || loading}
              >
                {copyRunning ? "Copy Running" : `Start Copy (${dryRun ? "dryRun" : "LIVE"})`}
              </button>
              <button onClick={onStopCopy} disabled={!copyRunning || loading}>
                Stop
              </button>
            </div>

            <div style={{ height: 12 }} />
            <div className="status">{status || " "}</div>
            {copyKey ? <div className="hint">Loop key: {copyKey}</div> : null}
            {funderAddress ? (
              <div className="hint">
                Bot wallet: {funderAddress.slice(0, 6)}…{funderAddress.slice(-4)}
              </div>
            ) : (
              <div className="hint">Bot wallet not set — set CLOB_FUNDER_ADDRESS for “My trades”.</div>
            )}
            </div>
          </div>

          <div className="grid-main">
            <div className="panel panel-main-section panel-chart-section">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <div className="hint">Current UP/DOWN price (from clob-client price history)</div>
                  <div style={{ height: 8 }} />
                  <div className="row chart-price-legend-row">
                    <span className="pill">
                      UP: {latestPrices.up === null ? "—" : latestPrices.up.toFixed(4)}
                    </span>
                    <span className="pill">
                      DOWN: {latestPrices.down === null ? "—" : latestPrices.down.toFixed(4)}
                    </span>
                    <div className="chart-inline-legend" aria-hidden>
                      <span className="chart-inline-legend-item">
                        <span className="chart-inline-legend-line" style={{ background: "#4cc9f0" }} />
                        UP
                      </span>
                      <span className="chart-inline-legend-item">
                        <span className="chart-inline-legend-line" style={{ background: "#ffd166" }} />
                        DOWN
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ height: 10 }} />

              {chartError ? (
                <div className="danger">{chartError}</div>
              ) : (
                <div className="chart-body-scroll">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={mergedChartData}>
                      <CartesianGrid stroke="rgba(255,255,255,0.08)" />
                      <XAxis
                        dataKey="t"
                        type="number"
                        domain={chart?.window?.startTs && chart?.window?.endTs ? [chart.window.startTs, chart.window.endTs] : undefined}
                        ticks={xAxisTicks}
                        tickFormatter={(v) => formatChartXAxisTick(Number(v), xAxisTicks)}
                        interval={0}
                      />
                      <YAxis domain={[0, 1]} tickFormatter={(v) => v.toFixed(2)} />
                      <Tooltip
                        labelFormatter={(v) => formatTimeHm(Number(v))}
                        formatter={(val: any, name: any) => [Number(val).toFixed(4), name]}
                      />
                      <Line
                        type="monotone"
                        dataKey="up"
                        name="UP"
                        stroke="#4cc9f0"
                        dot={false}
                        connectNulls
                        strokeWidth={2}
                      />
                      <Line
                        type="monotone"
                        dataKey="down"
                        name="DOWN"
                        stroke="#ffd166"
                        dot={false}
                        connectNulls
                        strokeWidth={2}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            <div className="panel panel-main-section panel-trade-tabs">
              <div className="trade-tabs-bar" role="tablist" aria-label="Trades and copy activity">
                <button
                  type="button"
                  role="tab"
                  className="trade-tab-btn"
                  aria-selected={tradePanelTab === "target"}
                  onClick={() => setTradePanelTab("target")}
                >
                  Target trades
                </button>
                <button
                  type="button"
                  role="tab"
                  className="trade-tab-btn"
                  aria-selected={tradePanelTab === "copy"}
                  onClick={() => setTradePanelTab("copy")}
                >
                  Copy activity
                </button>
                <button
                  type="button"
                  role="tab"
                  className="trade-tab-btn"
                  aria-selected={tradePanelTab === "my"}
                  onClick={() => setTradePanelTab("my")}
                >
                  My trades
                </button>
              </div>

              {tradePanelTab === "target" ? (
                <div className="trade-tab-panel" role="tabpanel">
                  <div className="trade-tab-hint">Trading history for the target address on this market.</div>
                  <div style={{ height: 10 }} />
                  <div className="target-trades-scroll">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>Side</th>
                          <th>Outcome</th>
                          <th>Price</th>
                          <th>Size</th>
                          <th>Tx</th>
                        </tr>
                      </thead>
                      <tbody>
                        {targetTrades.length ? (
                          targetTrades
                            .slice()
                            .sort(compareTradesNewestFirst)
                            .map((t) => (
                              <tr key={`${t.transactionHash}:${t.timestamp}:${t.outcomeIndex}:${t.side}`}>
                                <td>{formatTradeTableTime(t.timestamp)}</td>
                                <td>{t.side}</td>
                                <td>{t.outcome}</td>
                                <td>{t.price?.toFixed?.(4) ?? t.price}</td>
                                <td>{t.size?.toString?.() ?? t.size}</td>
                                <td style={{ maxWidth: 180, wordBreak: "break-word" }}>{t.transactionHash}</td>
                              </tr>
                            ))
                        ) : (
                          <tr>
                            <td colSpan={6} className="hint">
                              Load target trades to populate the table.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              {tradePanelTab === "copy" ? (
                <div className="trade-tab-panel" role="tabpanel">
                  <div className="trade-tab-hint">
                    First poll is the zero point for this market (feed may be empty). After that, only trades newer than
                    that snapshot are copied. When the crypto bucket rolls, a new zero point runs on the new market
                    automatically (same target and dry-run / live mode).
                  </div>
                  <div style={{ height: 10 }} />
                  <div className="target-trades-scroll">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>Event</th>
                          <th>Detail</th>
                        </tr>
                      </thead>
                      <tbody>
                        {copyActivity.length ? (
                          copyActivity.map((e, i) => (
                            <tr key={`${e.at}-${e.kind}-${i}`}>
                              <td>{formatTimeHm(e.at)}</td>
                              <td>{formatActivityKind(e.kind)}</td>
                              <td style={{ wordBreak: "break-word" }}>{formatActivityDetail(e)}</td>
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td colSpan={3} className="hint">
                              {copyRunning
                                ? "After the Ready row: if the zero point saw no trades, the next fills are copied; if it saw trades, only fills after that snapshot are copied."
                                : "Start copy to record simulated or live activity here."}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              {tradePanelTab === "my" ? (
                <div className="trade-tab-panel" role="tabpanel">
                  <div className="trade-tab-hint">
                    {copyRunning
                      ? dryRun
                        ? "Dry run: no on-chain fills. See Copy activity tab."
                        : "Your bot wallet on this market (polled while copy runs)."
                      : "Start copy to poll."}{" "}
                    {!funderAddress ? "Set CLOB_FUNDER_ADDRESS on the backend." : ""}
                  </div>
                  <div style={{ height: 10 }} />
                  <div className="target-trades-scroll">
                    <table className="table table-compact">
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>Side</th>
                          <th>Out</th>
                          <th>Px</th>
                          <th>Sz</th>
                          <th>Tx</th>
                        </tr>
                      </thead>
                      <tbody>
                        {myTrades.length ? (
                          myTrades
                            .slice()
                            .sort(compareTradesNewestFirst)
                            .map((t) => (
                              <tr key={`my-${t.transactionHash}:${t.timestamp}:${t.outcomeIndex}:${t.side}`}>
                                <td>{formatTradeTableTime(t.timestamp)}</td>
                                <td>{t.side}</td>
                                <td>{t.outcome?.slice(0, 3) ?? ""}</td>
                                <td>{t.price?.toFixed?.(2) ?? t.price}</td>
                                <td>
                                  {(() => {
                                    const n = Number(t.size);
                                    return Number.isFinite(n) && n >= 1000
                                      ? `${(n / 1000).toFixed(1)}k`
                                      : (t.size?.toString?.() ?? t.size);
                                  })()}
                                </td>
                                <td
                                  style={{ maxWidth: 72, wordBreak: "break-all", fontSize: 10 }}
                                  title={t.transactionHash}
                                >
                                  {t.transactionHash ? `${t.transactionHash.slice(0, 6)}…` : "—"}
                                </td>
                              </tr>
                            ))
                        ) : (
                          <tr>
                            <td colSpan={6} className="hint">
                              {!funderAddress
                                ? "Configure bot wallet on the server."
                                : !copyRunning
                                  ? "Start copy to poll this market."
                                  : dryRun
                                    ? "No fills in dry run."
                                    : "No trades yet for your wallet."}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

