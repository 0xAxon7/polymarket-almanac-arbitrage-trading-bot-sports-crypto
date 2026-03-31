import { useEffect, useState } from "react";
import {
  CopyActivityEvent,
  getCopyActivityWsUrl,
  getTargetTrades,
  getWallet,
  startCopy,
  stopCopy,
} from "./api";

type TradeRow = {
  timestamp: number;
  side: "BUY" | "SELL";
  outcome: string;
  outcomeIndex: number;
  price: number;
  size: number;
  transactionHash: string;
  title: string;
  conditionId?: string;
  slug?: string;
};

function formatTimeHm(tSeconds: number) {
  const d = new Date(tSeconds * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

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

function parseOptionalMinCopySize(s: string): number | undefined {
  const t = s.trim();
  if (!t) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 5) return undefined;
  return n;
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
  const txShort = tx && e.kind !== "error" ? `tx ${tx.slice(0, 10)}…` : "";
  const head = e.kind === "simulated" && e.message?.trim() ? e.message.trim() : "";
  const tail = [base || null, txShort || null].filter(Boolean).join(" · ");
  if (head && tail) return `${head} · ${tail}`;
  if (head) return head;
  return tail || "—";
}

export default function App() {
  const [targetAddress, setTargetAddress] = useState<string>("");
  const [targetTrades, setTargetTrades] = useState<TradeRow[]>([]);

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
  const [myTrades, setMyTrades] = useState<TradeRow[]>([]);
  const [copyActivity, setCopyActivity] = useState<CopyActivityEvent[]>([]);
  const [copySession, setCopySession] = useState<{ targetAddress: string } | null>(null);

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
    if (!targetAddress.trim() && !copyRunning) {
      setTargetTrades([]);
    }
  }, [targetAddress, copyRunning]);

  async function loadTargetTrades() {
    const addr = targetAddress.trim();
    if (!addr) return;
    try {
      setLoading(true);
      setStatus("Loading target trades…");
      const res = await getTargetTrades({ userAddress: addr, allMarkets: true, limit: 1000 });
      setTargetTrades(res.trades as TradeRow[]);
      setStatus(`Loaded ${res.trades.length} recent trade(s) across all markets.`);
    } catch (e: any) {
      setStatus(`Failed to load target trades: ${e?.message ?? String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!copyRunning || !funderAddress?.trim()) {
      if (!copyRunning) setMyTrades([]);
      return;
    }
    const addr = funderAddress.trim();
    const tick = () => {
      void getTargetTrades({ userAddress: addr, allMarkets: true, limit: 1000 })
        .then((res) => setMyTrades(res.trades as TradeRow[]))
        .catch(() => {});
    };
    tick();
    const id = window.setInterval(tick, 8000);
    return () => window.clearInterval(id);
  }, [copyRunning, funderAddress]);

  useEffect(() => {
    if (!copyRunning || !copySession?.targetAddress.trim()) return;
    const addr = copySession.targetAddress.trim();
    const url = getCopyActivityWsUrl(addr, { global: true });
    const socket = new WebSocket(url);
    socket.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          type?: string;
          event?: CopyActivityEvent;
          trades?: TradeRow[];
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
  }, [copyRunning, copySession?.targetAddress]);

  useEffect(() => {
    if (!copyRunning || !copySession) return;
    const form = targetAddress.trim().toLowerCase();
    const sessAddr = copySession.targetAddress.trim().toLowerCase();
    if (form === sessAddr) return;

    let cancelled = false;
    const sess = copySession;

    void (async () => {
      try {
        await stopCopy({ targetAddress: sess.targetAddress, global: true, fullStop: true });
      } catch {
        // still reset UI
      }
      if (cancelled) return;
      setCopyRunning(false);
      setCopyKey("");
      setCopySession(null);
      setCopyActivity([]);
      setTargetTrades([]);
      setStatus("Copy stopped: target address changed. Press Start to follow the new wallet.");
    })();

    return () => {
      cancelled = true;
    };
  }, [targetAddress, copyRunning, copySession]);

  async function onStartCopy() {
    const addr = targetAddress.trim();
    if (!addr) return;
    let sizing: { copySizePercent: number; minCopySize?: number; maxCopySize?: number };
    try {
      sizing = getCopySizingForApi(copySizePercent, minCopySizeInput, maxCopySizeInput);
    } catch (e: any) {
      setStatus(e?.message ?? String(e));
      return;
    }
    setTargetTrades([]);
    setCopyActivity([]);
    const payload = {
      targetAddress: addr,
      global: true as const,
      dryRun,
      pollMs: 250 as const,
      ...sizing,
    };
    const applyStartResult = (res: Awaited<ReturnType<typeof startCopy>>, note?: string) => {
      setCopyKey(res.key);
      setCopyRunning(res.running);
      setCopySession({ targetAddress: res.targetAddress });
      setStatus(note ?? (res.ok ? `Copy loop started (all markets): ${res.key}` : "Start failed"));
    };
    try {
      setLoading(true);
      setStatus(`Starting global copy (dryRun=${dryRun})…`);
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
          await stopCopy({ targetAddress: addr, global: true, fullStop: true });
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
    const stopTarget = copySession?.targetAddress ?? targetAddress.trim();
    if (!stopTarget) return;
    try {
      setLoading(true);
      const res = await stopCopy({ targetAddress: stopTarget, global: true, fullStop: true });
      setCopyRunning(false);
      setCopyKey("");
      setCopySession(null);
      setCopyActivity([]);
      setTargetTrades([]);
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
            <div className="hint">
              Enter a wallet address. When they trade on any market, new fills are copied to the same outcome (dry run or
              live).
            </div>
          </div>
          <div className="pill">
            <span className="dot" />
            <span>{loading ? "Loading…" : "Ready"}</span>
          </div>
        </div>

        <div className="app-panel-gap" style={{ height: 12 }} />

        <div className="grid">
          <div className="panel grid-sidebar" style={{ padding: 14 }}>
            <div className="sidebar-controls">
              <label>Target address</label>
              <input
                value={targetAddress}
                onChange={(e) => setTargetAddress(e.target.value)}
                placeholder="0x… Polymarket proxy wallet"
              />
              <div className="hint" style={{ marginTop: 4 }}>
                Use Refresh trades for a snapshot. Start copy to poll activity (~250ms) and stream target trades + copy
                events over WebSocket.
              </div>

              <div style={{ height: 12 }} />

              <div className="row" style={{ justifyContent: "space-between" }}>
                <button type="button" onClick={() => void loadTargetTrades()} disabled={!targetAddress.trim() || loading}>
                  Refresh trades
                </button>
              </div>

              <div style={{ height: 12 }} />

              <div className="row" style={{ justifyContent: "space-between" }}>
                <label className="checkboxLabel">
                  <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
                  Dry run mode
                </label>
              </div>
              <div className="hint">Dry run logs simulated orders only; live mode needs CLOB keys on the backend.</div>
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

              <div style={{ height: 8 }} />

              <label>Min copy size (optional, ≥ 5)</label>
              <input
                value={minCopySizeInput}
                onChange={(e) => setMinCopySizeInput(e.target.value)}
                placeholder="e.g. 5"
                inputMode="decimal"
              />

              <div style={{ height: 8 }} />

              <label>Max copy size (optional)</label>
              <input
                value={maxCopySizeInput}
                onChange={(e) => setMaxCopySizeInput(e.target.value)}
                placeholder="e.g. 50"
                inputMode="decimal"
              />

              <div style={{ height: 10 }} />

              <div className="row" style={{ justifyContent: "space-between" }}>
                <button
                  type="button"
                  onClick={() => void onStartCopy()}
                  disabled={!targetAddress.trim() || copyRunning || loading}
                >
                  {copyRunning ? "Copy running" : `Start copy (${dryRun ? "dry run" : "LIVE"})`}
                </button>
                <button type="button" onClick={() => void onStopCopy()} disabled={!copyRunning || loading}>
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
                  <div className="trade-tab-hint">Recent trades for the target across all markets (poll + websocket).</div>
                  <div style={{ height: 10 }} />
                  <div className="target-trades-scroll">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>Market</th>
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
                                <td style={{ maxWidth: 200, wordBreak: "break-word" }} title={t.conditionId}>
                                  {t.title || t.slug || "—"}
                                </td>
                                <td>{t.side}</td>
                                <td>{t.outcome}</td>
                                <td>{t.price?.toFixed?.(4) ?? t.price}</td>
                                <td>{t.size?.toString?.() ?? t.size}</td>
                                <td style={{ maxWidth: 140, wordBreak: "break-all", fontSize: 11 }}>
                                  {t.transactionHash}
                                </td>
                              </tr>
                            ))
                        ) : (
                          <tr>
                            <td colSpan={7} className="hint">
                              Enter a target address to stream trades, or press Refresh trades.
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
                    New target fills after the zero-point snapshot are copied on the same market/outcome (token from
                    trade data). Very active wallets may exceed the API trade window — increase poll frequency on the
                    backend if needed.
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
                                ? "Waiting for baseline and copy events…"
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
                        ? "Dry run: no on-chain fills. See Copy activity."
                        : "Your bot wallet — recent trades across all markets (polled while copy runs)."
                      : "Start copy to poll."}{" "}
                    {!funderAddress ? "Set CLOB_FUNDER_ADDRESS on the backend." : ""}
                  </div>
                  <div style={{ height: 10 }} />
                  <div className="target-trades-scroll">
                    <table className="table table-compact">
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>Mkt</th>
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
                                <td style={{ maxWidth: 72, fontSize: 11 }} title={t.title}>
                                  {(t.title ?? "").slice(0, 14)}
                                  {(t.title ?? "").length > 14 ? "…" : ""}
                                </td>
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
                                <td style={{ maxWidth: 64, wordBreak: "break-all", fontSize: 10 }} title={t.transactionHash}>
                                  {t.transactionHash ? `${t.transactionHash.slice(0, 6)}…` : "—"}
                                </td>
                              </tr>
                            ))
                        ) : (
                          <tr>
                            <td colSpan={7} className="hint">
                              {!funderAddress
                                ? "Configure bot wallet on the server."
                                : !copyRunning
                                  ? "Start copy to poll."
                                  : dryRun
                                    ? "No fills in dry run."
                                    : "No recent trades returned for your wallet."}
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
