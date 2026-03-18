# Polymarket Trading Bot (TypeScript)

## Overview

This bot trades on Polymarket’s **5-minute Up/Down** prediction markets for **BTC**, **ETH**, **Solana**, and **XRP**. The strategy has two parts:

1. **Dual limit at period start** — At the start of each 5-minute period, place **limit buy** orders for both **Up** and **Down** tokens at a fixed price (e.g. **$0.45**), in a single batch.
2. **Limit sell when one side fills** — If **exactly one side** gets filled and the **unfilled side’s best bid** crosses a trigger (default **$0.80**), place a **limit sell** at a target price (default **$0.85**) on the **filled** token. No market buys, no stop-loss.

Markets are discovered by slug (e.g. `btc-updown-5m-{timestamp}`). BTC is always enabled; ETH, Solana, and XRP can be turned on or off in config.

### Trading logic summary

| Step | When | Action |
|------|------|--------|
| **1. Limit buys** | Start of each 5-minute period (or within 2s if bot started mid-period) | Place a **batch** of limit buys: Up and Down at `dual_limit_price` (e.g. $0.45), `dual_limit_shares` per side. One CLOB batch per period. |
| **2. Market refresh** | When the period timestamp changes | Re-discover markets for the new period and re-fetch the order book snapshot. |
| **3. Limit sell (SL)** | Every poll after 2s elapsed, once per market per period | For each market: if **one side has balance** and the **other has none**, and the **unfilled side’s best bid** ≥ `dual_limit_SL_sell_trigger_bid` (e.g. $0.80), place a **limit sell** at `dual_limit_SL_sell_at_price` (e.g. $0.85) for the **filled** token (size = filled balance). Track so we only do this once per period per market. |

There is **no** hedge (no market buy on the unfilled side), **no** stop-loss, and **no** automatic redemption at market close — only the limit buys at start and the optional limit sell when the trigger is hit.

**Watch the bot in action:**

[![Polymarket Trading Bot Demo](https://img.youtube.com/vi/1nF556ypGXM/0.jpg)](https://youtu.be/1nF556ypGXM?si=3d4zmY6lKVj4fVhO)

---

## Architecture

```
┌─────────────────┐
│  Monitor        │  Fetches snapshots, discovers markets by slug
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Main loop      │  Period start → batch limit buys; then check balances + trigger → limit sell
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Trader         │  executeLimitBuyBatch, executeLimitSell, getBalance
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  CLOB / Gamma   │  Auth (API key + signature_type + proxy), orders, balance
└─────────────────┘
```

## Requirements

- Node.js >= 18
- `config.json` with Polymarket `private_key`. Use `proxy_wallet_address` and `signature_type: 2` if you use a proxy/Gnosis Safe wallet. The bot **derives the CLOB trading API key** from your private key (L1 auth) — **do not** use the "Builder" key from polymarket.com/settings?tab=builder (that is for order attribution only).

## Setup

```bash
npm install
cp config.json.example config.json   # or copy from another project
# Edit config.json: set polymarket.private_key (and proxy_wallet_address + signature_type: 2 if using proxy)
```

## Usage

- **Simulation (default)** — no real orders, logs what would be placed:
  ```bash
  npm run dev
  # or
  npx tsx src/main-dual-limit-045.ts
  ```

- **Production (live)** — place real limit orders:
  ```bash
  npm run dev:live
  # or
  npx tsx src/main-dual-limit-045.ts --no-simulation
  ```

- **Config path**:
  ```bash
  npx tsx src/main-dual-limit-045.ts -c /path/to/config.json
  ```

## Configuration

Create or edit `config.json` in the project root.

### Example `config.json`

```json
{
  "polymarket": {
    "gamma_api_url": "https://gamma-api.polymarket.com",
    "clob_api_url": "https://clob.polymarket.com",
    "private_key": "your_private_key_hex",
    "proxy_wallet_address": "0x...your_proxy_wallet",
    "signature_type": 2
  },
  "trading": {
    "check_interval_ms": 1000,
    "enable_eth_trading": false,
    "enable_solana_trading": false,
    "enable_xrp_trading": false,
    "dual_limit_price": 0.45,
    "dual_limit_shares": 5,
    "dual_limit_SL_sell_trigger_bid": 0.8,
    "dual_limit_SL_sell_at_price": 0.85
  }
}
```

### Polymarket (API) settings

| Parameter | Description | Required |
|-----------|-------------|----------|
| `private_key` | Wallet private key (hex, with or without `0x`). The bot derives the CLOB trading API key from this via L1 auth. | Yes |
| `proxy_wallet_address` | Polymarket proxy wallet address (the one that holds funds on polymarket.com) | For proxy/Gnosis Safe |
| `signature_type` | `0` = EOA, `1` = Proxy, `2` = Gnosis Safe | Use `2` for proxy wallet |

**Note:** Do not use the "Builder" API key from polymarket.com/settings?tab=builder — that is for order attribution. This bot creates/derives the CLOB trading key automatically from your `private_key`.

### Trading settings

| Parameter | Description | Default |
|-----------|-------------|---------|
| `check_interval_ms` | Poll interval (ms) for market snapshot | 1000 |
| `dual_limit_price` | Limit buy price for Up/Down at period start | 0.45 |
| `dual_limit_shares` | Shares per limit order (each side) | 1 |
| `dual_limit_SL_sell_trigger_bid` | When one side filled: place limit sell on filled token only if unfilled side’s best bid ≥ this | 0.8 |
| `dual_limit_SL_sell_at_price` | Limit sell price for the filled token when trigger is hit | 0.85 |
| `enable_eth_trading` | Enable ETH 5m Up/Down market | false |
| `enable_solana_trading` | Enable Solana 5m Up/Down market | false |
| `enable_xrp_trading` | Enable XRP 5m Up/Down market | false |

### Market discovery

Markets are discovered by slug (e.g. `btc-updown-5m-{period_timestamp}`). When the 5-minute period changes, the bot refreshes markets for the new period. No condition IDs need to be set in config.

---

## Features

- **Automatic market discovery** — Finds 5-minute Up/Down markets for BTC, ETH, Solana, XRP; refreshes on period rollover.
- **Dual limit at period start** — Single batch of limit buys for Up and Down at a configurable price and shares.
- **Limit sell on trigger** — When exactly one side is filled and the unfilled side’s bid crosses the trigger, place a limit sell at a target price on the filled token (once per market per period).
- **Configurable markets** — BTC always on; enable/disable ETH, Solana, XRP.
- **Simulation mode** — Run without sending orders.
- **Structured logging** — Stderr logging for monitoring and debugging.


## Security

- Do **not** commit `config.json` with real keys or secrets.
- Use simulation and small sizes when testing.
- Monitor logs and balances in production.

---

## Support

For questions or customizations:
- E-Mail: admin@hyperbuildx.com
- Telegram: [@bettyjk_0915](https://t.me/bettyjk_0915)
