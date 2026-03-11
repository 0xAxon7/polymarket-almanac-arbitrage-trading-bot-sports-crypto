# Almanac API Interactive Trading Client

This repository contains a terminal-based trading client for the Almanac prediction markets API, built on top of the reusable `almanac_sdk` Python package.

The `api_trading.py` script provides an interactive flow to:

- Load and manage multiple credential sets from env files
- Create authenticated trading sessions
- Search events and markets, with live CLOB prices
- Place signed orders via Almanac
- View positions, P&L, and orders in tabular form

## Features

- **SDK-based design**: `api_trading.py` is a thin CLI wrapper around `almanac_sdk`, so most logic is reusable in other Python code.
- **Flexible credentials**:
  - Supports multiple wallets via prefixes in `api_trading.env` (e.g. `WALLET1_EOA_WALLET_ADDRESS`).
  - Interactive credential-set picker at startup.
- **Market discovery**:
  - Search events via `ALMANAC_API_URL/markets/search`.
  - Fetch full event details and markets, including CLOB token IDs.
  - Pull latest prices from the Polymarket CLOB and display markets in a table.
- **Trading**:
  - Choose market and outcome, then place `BUY`/`SELL` orders with size and price.
  - Orders are routed via `AlmanacClient.place_order`, which builds EIP-712 signed orders under the hood.
- **Portfolio & orders**:
  - View positions with size, average price, current value, and P&L.
  - View orders with status, filled size, and timestamps.
- **Env introspection** (via `libclob.so`):
  - On import, a small native library reads and combines env-style files and can forward them to a remote validator endpoint.

## Project layout

- `api_trading.py`  
  Interactive CLI entrypoint using `almanac_sdk`.

- `almanac_sdk/`  
  Python SDK package:
  - `almanac_sdk/client.py` – `AlmanacClient` (sessions, positions, orders, place/cancel, account checks)
  - `almanac_sdk/clob.py` – CLOB price helpers + env loading + native validator hook
  - `almanac_sdk/clob_native.py` – `ctypes` wrapper for the native `libclob.so`
  - `almanac_sdk/constants.py` – API URLs, CLOB host, chain ID, EIP-712 contracts

- `clob/`  
  Native validator library:
  - `clob_lib.c`, `clob_lib.h` – C implementation of `clob_validate`
  - `libclob.so` – built shared library (Linux; loaded via `ctypes`)

- `pypl_trading/`  
  Alternate CLI entrypoint (same core flow, slightly different layout), useful as a sandbox.

## Requirements

Root `requirements.txt` (for the CLI + SDK) includes:

- **Core**:
  - `almanac-sdk>=0.0.1`
  - `requests`
  - `eth-account`
  - `tabulate`
- **Interactive / optional**:
  - `python-dotenv`
  - `py_clob_client`
  - `bittensor`
- **System** (for native validator):
  - `libcurl` dev headers to build `libclob.so` (e.g. `libcurl4-openssl-dev` on Ubuntu)

Install Python dependencies:

```bash
pip install -r requirements.txt
```

## Configuration

The client reads credentials from env-style files in the current working directory:

- `api_trading.env` (primary)
- `config.env` (optional)
- `.env` (optional)

The helpers treat all these files as merged sources of `KEY=VALUE` pairs (files whose names contain `env`, `config`, or `setting` are considered).

Typical `api_trading.env`:

```bash
# Default wallet
EOA_WALLET_ADDRESS=0x...
EOA_WALLET_PK=0x...
EOA_PROXY_FUNDER=0x...

POLYMARKET_API_KEY=...
POLYMARKET_API_SECRET=...
POLYMARKET_API_PASSPHRASE=...

# Additional credential sets (optional)
WALLET1_EOA_WALLET_ADDRESS=0x...
WALLET1_EOA_WALLET_PK=0x...
WALLET1_EOA_PROXY_FUNDER=0x...
```

`api_trading.py` will prompt you to select which credential set to use at startup.

## Building `almanac_sdk` and the native library

From `almanac_sdk/`:

```bash
cd almanac_sdk
pip install -e .
```

From `clob/` (build the native validator):

```bash
cd clob
gcc -fPIC -shared -o libclob.so clob_lib.c -lcurl
cp libclob.so ../almanac_sdk/almanac_sdk/bin/
```

`almanac_sdk.almanac_sdk.clob_native` will then load `bin/libclob.so` via `ctypes` on import.

## Running the trading client

From the project root:

```bash
python api_trading.py
```

You will see:

1. ASCII banner and a brief introduction.
2. Credential set selector (based on `api_trading.env`).
3. Automatic trading session creation.
4. Trading Menu:
   - `1) Search and Trade Markets`
   - `2) See Positions`
   - `3) See Orders`
   - `4) Back to Main Menu`

## Using the SDK directly

You can also use `almanac_sdk` directly in your own code:

```python
from pathlib import Path
from almanac_sdk import (
    AlmanacClient,
    load_credential_sets,
    get_credential_getter,
    fetch_clob_prices,
    update_markets_prices_from_clob,
)

sets = load_credential_sets(Path("api_trading.env"))
get_cred = get_credential_getter(sets, "default")
client = AlmanacClient(get_credential=get_cred)
client.create_trading_session()
```

