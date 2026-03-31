# Polymarket Copy Trading Bot

A full-stack tool for **Polymarket wallet copy trading** across **any market**: a target wallet’s trades (via the Data API), optional copy-trading (dry-run or live), and real-time copy activity over WebSocket.

---

## Features

| Area | Description |
|------|-------------|
| **Markets** | Target-trade and copy logic is market-agnostic: it follows the configured wallet across all Polymarket markets. |
| **Target trades** | Single backend poll loop per `target::global`; updates pushed over **WebSocket** when new trades are detected after copy zero-point seeding. Same loop drives **copy** when enabled. |
| **Copy trading** | **Dry run** (log + activity) or **live** orders (`createAndPostOrder`). Zero-point: first tick seeds baseline keys and does **not** copy; only later new trades are candidates to copy. |
| **Activity** | In-memory ring buffer + **`/api/copy/ws`** for baseline, simulated, posted, skipped, and error events. |
| **My trades** | Polls Data API for **`CLOB_FUNDER_ADDRESS`** across all markets while copy is running (same REST shape as target trades; not CLOB user WS). |

**Trade source:** Polymarket **Data API** `GET /activity` with `type=TRADE` (not `/trades`), deduped and normalized.

## Architecture

```text
┌─────────────┐     REST/WS      ┌─────────────────┐     HTTPS      ┌──────────────────────────┐
│   React UI  │ ◄──────────────► │ Express + `ws`  │ ◄────────────► │ Data API + CLOB REST +  │
│  (Vite 5173)│                  │ (Node, :3001)   │                │ Gamma metadata endpoints │
└─────────────┘                  └─────────────────┘                └──────────────────────────┘
```

- **Frontend:** `VITE_API_BASE_URL` empty in dev → Vite proxies `/api` (and WebSocket upgrades) to the backend.
- **Backend:** One **`targetFeedLoops`** map entry per `lowercase(target)::global`; **`copyEnabled`** toggles order placement on top of the same tick that can broadcast **`target_trades`** and copy activity.

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

Create **`backend/.env`** (see `.gitignore`). Current template (`backend/.env copy.example`) includes:

| Variable | Required for | Default |
|----------|----------------|---------|
| `PORT` | HTTP server | `3001` |
| `CLOB_HOST` | CLOB REST | `https://clob.polymarket.com` |
| `CLOB_CHAIN_ID` | CLOB chain | `137` |
| `GAMMA_API_BASE_URL` | Market / event metadata | `https://gamma-api.polymarket.com` |
| `DATA_API_BASE_URL` | Trades feed | `https://data-api.polymarket.com` |
| `CLOB_FUNDER_ADDRESS` | “My trades” + signing context | — |
| `CLOB_PRIVATE_KEY` | **Live** copy orders | — |
| `CLOB_SIGNATURE_TYPE` | CLOB client | often `2` |

Optional (not in the example file, but supported):

- `CLOB_API_KEY`
- `CLOB_SECRET`
- `CLOB_PASSPHRASE`

If these optional L2 creds are not set, backend auto-derives API creds from `CLOB_PRIVATE_KEY`.

**Live trading** needs a funded wallet and valid CLOB setup; **misconfiguration can lose funds**. Prefer **dry run** until you understand behavior.

---

## Notable HTTP routes

| Method | Path | Role |
|--------|------|------|
| GET | `/api/health` | Health check |
| GET | `/api/target-trades` | Merged recent trades across all markets (query: `userAddress`, optional `limit`) |
| POST | `/api/feed/start` | Start watch-only poll + WS `target_trades` |
| POST | `/api/feed/stop` | Stop that loop entirely |
| POST | `/api/copy/start` | Enable copy on the same loop key |
| POST | `/api/copy/stop` | `fullStop: false` → watch-only; `fullStop: true` → remove loop |
| GET | `/api/copy/activity` | Activity history (`global=true` in current UI flow) |
| GET | `/api/wallet` | Exposes `CLOB_FUNDER_ADDRESS` to the UI |

## WebSocket paths

| Path | Query | Payloads |
|------|--------|----------|
| `/api/copy/ws` | `targetAddress`, `global=true` | `subscribed`, `target_trades`, `copy_activity` |

## Copy loop behavior (current)

- Poll interval defaults to **250ms** (`/api/copy/start` supports `pollMs`, min 200ms).
- Each tick fetches **latest 50** target trades from Data API `/activity` (`type=TRADE`, `sortDirection=DESC`), then sorts oldest→newest for deterministic processing.
- **Zero-point on start:** first tick only seeds dedupe keys (`processedCopyKeys`) and does not copy or send baseline trades to UI.
- After zero-point, only newly discovered trades (not in `processedCopyKeys`) are:
  - broadcast as `target_trades` over `/api/copy/ws`
  - considered for copy (dry-run/live)

---

## Live order posting notes

- `order_posted` means the backend believes posting succeeded.
- If CLOB returns a structured error (for example `Unauthorized/Invalid api key`), backend now treats it as an **error** event, not success.
- If you see 401 in logs:
  - verify `CLOB_PRIVATE_KEY` and `CLOB_FUNDER_ADDRESS` match,
  - remove stale `CLOB_API_KEY` / `CLOB_SECRET` / `CLOB_PASSPHRASE` so backend can derive fresh API creds,
  - restart backend after changing `.env`.

---

## Project layout

```text
PolyMarket-Crypto-Copy-Trading-Bot/
├── backend/src/index.ts   # Single server: REST + WS + loops + Gamma/Data/CLOB
├── frontend/src/          # React UI (target trades + copy activity + my trades)
├── package.json           # Workspaces + dev script
└── README.md
```

---

## Disclaimer

This software interacts with **real markets** and, in live mode, can **place real orders**. It is provided as-is for educational and operational use at your own risk. You are responsible for keys, compliance, and capital. **Never commit private keys or `.env` files.**

---

## License

ISC (see `package.json` files in workspaces).
