# Polymarket Crypto Copy Trading Bot

A full-stack tool for **Polymarket crypto up/down markets**: live UP/DOWN charts, a **target wallet’s trades** (via the official Data API), and an optional **copy-trading loop** that mirrors fills in dry-run or live mode using the [CLOB client](https://github.com/Polymarket/clob-client).

---

## Features

| Area | Description |
|------|-------------|
| **Markets** | BTC/ETH/SOL/XRP **5m** and **15m** buckets from Gamma; auto-advance when the current bucket rolls. |
| **Chart** | Historical mid from CLOB REST; **live** mids via the backend relaying Polymarket’s **CLOB market WebSocket** (`best_bid_ask` only). |
| **Target trades** | Single backend poll loop per `(target address, eventId)`; updates pushed over **WebSocket** when the merged trade list changes. Same loop drives **copy** when enabled. |
| **Copy trading** | **Dry run** (log + activity) or **live** orders (`createAndPostOrder`). Zero-point: two snapshots **300ms** apart; only trades appearing in the second snapshot (and later ticks) are candidates to copy. |
| **Activity** | In-memory ring buffer + **`/api/copy/ws`** for baseline, simulated, posted, skipped, and error events. |
| **My trades** | Polls Data API for **`CLOB_FUNDER_ADDRESS`** on the selected **event** while copy is running (same REST shape as target trades; not CLOB user WS). |

**Trade source:** Polymarket **Data API** `GET /trades` with **`eventId`** (not `market` / condition id), merging **`takerOnly=true`** and **`takerOnly=false`**, deduped, up to **1000** rows per side of the merge.

**Event id:** Resolved from Gamma (`GET /events/slug/{slug}` for bucket slugs, or `markets?condition_ids=…` with slug fallback to embedded `events[0].id`).

---

## Architecture

```text
┌─────────────┐     REST/WS      ┌─────────────────┐     HTTPS/WSS      ┌──────────────────┐
│   React UI  │ ◄──────────────► │ Express + `ws`  │ ◄─────────────────► │ Gamma, Data API, │
│  (Vite 5173)│                  │ (Node, port     │                    │ CLOB REST + CLOB │
└─────────────┘                  │  3001 default)  │                    │ market WS         │
                                 └─────────────────┘                    └──────────────────┘
```

- **Frontend:** `VITE_API_BASE_URL` empty in dev → Vite proxies `/api` (and WebSocket upgrades) to the backend.
- **Backend:** One **`targetFeedLoops`** map entry per `lowercase(target)::e{eventId}`; **`copyEnabled`** toggles order placement on top of the same tick that broadcasts **`target_trades`**.

---

## Requirements

- **Node.js** 18+ (or 20+ recommended)
- **npm** or **yarn** at the repo root (workspaces)

---

## Quick start

```bash
# Install (from repository root)
npm install

# Development: backend :3001 + frontend :5173
npm run dev
```

Open the UI URL printed by Vite (default **http://localhost:5173**). The API is expected at **http://localhost:3001** unless you set `VITE_API_BASE_URL`.

**Production build**

```bash
npm run build
npm run start   # serves compiled backend only; host frontend/dist with any static server and set VITE_API_BASE_URL at build time
```

---

## Environment variables (backend)

Create **`backend/.env`** (see `.gitignore`). Common variables:

| Variable | Required for | Default |
|----------|----------------|---------|
| `PORT` | HTTP server | `3001` |
| `CLOB_HOST` | CLOB REST | `https://clob.polymarket.com` |
| `CLOB_CHAIN_ID` | CLOB chain | `137` |
| `GAMMA_API_BASE_URL` | Market / event metadata | `https://gamma-api.polymarket.com` |
| `DATA_API_BASE_URL` | Trades feed | `https://data-api.polymarket.com` |
| `CLOB_WS_URL` | Backend chart relay upstream | `wss://ws-subscriptions-clob.polymarket.com/ws/market` |
| `CLOB_FUNDER_ADDRESS` | “My trades” + signing context | — |
| `CLOB_PRIVATE_KEY` | **Live** copy orders | — |
| `CLOB_SIGNATURE_TYPE` | CLOB client | often `2` |
| `CLOB_API_KEY`, `CLOB_SECRET`, `CLOB_PASSPHRASE` | Optional L2 creds; else derived | — |

**Live trading** needs a funded wallet and valid CLOB setup; **misconfiguration can lose funds**. Prefer **dry run** until you understand behavior.

---

## Notable HTTP routes

| Method | Path | Role |
|--------|------|------|
| GET | `/api/health` | Health check |
| GET | `/api/crypto/markets`, `/api/crypto/current` | Crypto bucket list / current market |
| GET | `/api/chart` | UP/DOWN history + window |
| GET | `/api/target-trades` | Merged trades (query: `userAddress` + `eventId` or `conditionId`) |
| POST | `/api/feed/start` | Start watch-only poll + WS `target_trades` |
| POST | `/api/feed/stop` | Stop that loop entirely |
| POST | `/api/copy/start` | Enable copy on the same loop key |
| POST | `/api/copy/stop` | `fullStop: false` → watch-only; `fullStop: true` → remove loop |
| GET | `/api/copy/activity` | Activity history |
| GET | `/api/wallet` | Exposes `CLOB_FUNDER_ADDRESS` to the UI |

## WebSocket paths

| Path | Query | Payloads |
|------|--------|----------|
| `/api/chart/ws` | `upToken`, `downToken`, `startTs`, `endTs` | `chart_mid` |
| `/api/copy/ws` | `targetAddress`, `eventId` | `subscribed`, `target_trades`, `copy_activity` |

---

## Project layout

```text
PolyMarket-Crypto-Copy-Trading-Bot/
├── backend/src/index.ts   # Single server: REST + WS + loops + Gamma/Data/CLOB
├── frontend/src/          # React + Recharts
├── package.json           # Workspaces + dev script
└── README.md
```

---

## Disclaimer

This software interacts with **real markets** and, in live mode, can **place real orders**. It is provided as-is for educational and operational use at your own risk. You are responsible for keys, compliance, and capital. **Never commit private keys or `.env` files.**

---

## License

ISC (see `package.json` files in workspaces).
