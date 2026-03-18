# Polymarket Arbitrage Trading Bot · Sports & Crypto | Almanac · Copy Trading

**Open-source toolkit for [Polymarket](https://polymarket.com)–style prediction markets:** sports markets via **Almanac** (Sportstensor), automated **crypto** 5-minute Up/Down strategies, and workflows useful for **arbitrage**, **copy trading**, and systematic **trading bot** development.

[![Polymarket](https://img.shields.io/badge/Polymarket-prediction%20markets-blue)](https://polymarket.com)
[![Sports](https://img.shields.io/badge/Sports-Almanac%20%7C%20Sportstensor-green)](https://beta.almanac.market)
[![Crypto](https://img.shields.io/badge/Crypto-BTC%20ETH%20SOL%20XRP-orange)](https://polymarket.com)

---

## What’s in this repository

| Project | Stack | Best for |
|--------|--------|----------|
| [**Polymarket-Almanac-Trading-Bot-Python**](./Polymarket-Almanac-Trading-Bot-Python/) | Python + `almanac_sdk` | **Sports** prediction markets, Almanac API, **copy trading** / miner-style workflows, Polymarket CLOB prices |
| [**Polymarket-Trading-Bot-Typescript**](./Polymarket-Trading-Bot-Typescript/) | TypeScript + CLOB | **Crypto** 5m Up/Down bots, dual-limit strategies, simulation vs live trading |

Together they cover **Polymarket arbitrage** research (price discovery, limit logic, cross-outcome positioning), **sports** and **crypto** verticals, and building your own **trading bot** on top of official APIs.

---

## Why traders search for this

- **Polymarket arbitrage** — Compare outcomes, limit prices, and CLOB depth; automate checks with the Python client or TS monitor.
- **Copy trading sports** — Almanac / Sportstensor rewards consistent, volume-backed performance; the Python client is built for authenticated Almanac + Polymarket-style execution.
- **Crypto trading bot** — The TypeScript bot runs **BTC / ETH / Solana / XRP** 5-minute markets with configurable dual limits and optional limit-sell triggers.
- **Prediction market automation** — Search markets, place signed orders, view positions and P&L (Python); batch limits and period-aware logic (TypeScript).

---

## Quick start

### 1) Sports · Almanac · Python

```bash
cd Polymarket-Almanac-Trading-Bot-Python
pip install -r requirements.txt
cp api_trading.env.example api_trading.env
# Edit api_trading.env (wallets, Polymarket API credentials)
python api_trading.py
```

Full setup (wallet, approvals, Bittensor coldkey) → see **[Polymarket-Almanac-Trading-Bot-Python/README.md](./Polymarket-Almanac-Trading-Bot-Python/README.md)**.

### 2) Crypto · Polymarket CLOB · TypeScript

```bash
cd Polymarket-Trading-Bot-Typescript
npm install
cp config.json.example config.json
# Edit config.json (private_key, proxy if needed)
npm run dev          # simulation
npm run dev:live     # live orders (use with care)
```

Details → **[Polymarket-Trading-Bot-Typescript/README.md](./Polymarket-Trading-Bot-Typescript/README.md)**.

---

## Features at a glance

**Python (Almanac / sports)**  
Interactive CLI: multi-wallet env, market search, CLOB prices, BUY/SELL via Almanac, positions & orders.

**TypeScript (crypto)**  
Auto market discovery by slug, dual limit buys at period start, optional limit sell when bid trigger hits, simulation mode.

---

## SEO keywords (index)

`polymarket arbitrage` · `polymarket trading bot` · `copy trading sports` · `crypto trading bot` · `prediction markets` · `almanac trading` · `sportstensor` · `polymarket clob` · `automated trading` · `5 minute crypto markets`

---

## Security & disclaimer

- **Never commit** real private keys, `api_trading.env`, or `config.json` with secrets.
- Prediction markets involve **risk of loss**. This software is for **education and research**; you are responsible for compliance with applicable laws and platform terms.
- Start with **simulation** and small size when testing live.

---

## License & support

See each subproject’s README for dependencies and contacts. Extend either bot for your own **Polymarket arbitrage**, **sports copy trading**, or **crypto bot** stack.

**Star the repo** if you use it for Almanac, Polymarket, or Sportstensor automation.
