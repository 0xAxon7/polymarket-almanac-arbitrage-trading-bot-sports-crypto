import { ethers } from "ethers";
import {
  ClobClient,
  Side,
  OrderType,
  Chain,
  AssetType,
  type ApiKeyCreds,
} from "@polymarket/clob-client";
import type { Config } from "./config.js";

export type { ClobClient };

/** Create ethers Wallet from private key hex (with or without 0x) */
export function createWallet(privateKey: string): ethers.Wallet {
  const key = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  return new ethers.Wallet(key);
}

/**
 * Build authenticated CLOB client for order placement.
 * Uses L1 auth (private key) to derive the CLOB trading API key — do NOT use the
 * "Builder" key from polymarket.com/settings?tab=builder (that is for attribution only).
 */
export async function createClobClient(cfg: Config["polymarket"]): Promise<ClobClient> {
  const pk = cfg.private_key;
  if (!pk) throw new Error("private_key is required in config");
  const wallet = createWallet(pk);
  const host = cfg.clob_api_url.replace(/\/$/, "");

  // 0 = EOA, 1 = POLY_PROXY, 2 = POLY_GNOSIS_SAFE (per Polymarket docs)
  const signatureType = cfg.signature_type ?? 0;
  const funderAddress =
    (signatureType === 1 || signatureType === 2) && cfg.proxy_wallet_address
      ? cfg.proxy_wallet_address
      : undefined;

  const client = new ClobClient(host, Chain.POLYGON, wallet, undefined, signatureType, funderAddress);
  let creds: ApiKeyCreds | null = null;
  try {
    const derived = await client.deriveApiKey();
    if (derived?.key && derived?.secret && derived?.passphrase) {
      creds = derived;
    }
  } catch {
    /* derive failed, try create */
  }
  if (!creds) {
    try {
      const created = await client.createApiKey();
      if (created?.key && created?.secret && created?.passphrase) {
        creds = created;
      }
    } catch (e) {
      throw new Error(
        "CLOB API key failed: create and derive both failed. Use your wallet private_key only (no Builder key). Error: " +
          String(e instanceof Error ? e.message : e)
      );
    }
  }
  if (!creds) {
    throw new Error("CLOB API key derivation/creation returned no credentials.");
  }
  return new ClobClient(host, Chain.POLYGON, wallet, creds, signatureType, funderAddress);
}

/** Verify L2 (API key) auth by calling an endpoint that requires it (no token_id). Throws with a clear message if key is invalid. */
export async function verifyClobAuth(client: ClobClient): Promise<void> {
  const res = await client.getApiKeys();
  const status = (res as { status?: number }).status;
  const error = (res as { error?: string }).error;
  if (status === 401 || (error && String(error).toLowerCase().includes("unauthorized"))) {
    throw new Error(
      "Polymarket API key rejected (401). This bot derives the CLOB trading key from your private_key — do not use the Builder key from polymarket.com/settings?tab=builder (that is for attribution only). Ensure config has the correct private_key and proxy_wallet_address/signature_type: 2 if using a proxy."
    );
  }
  if (error && status !== undefined && status !== 200) {
    throw new Error("Polymarket CLOB auth check failed: " + String(error));
  }
}

export interface PlaceLimitOrderParams {
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  tickSize?: "0.1" | "0.01" | "0.001" | "0.0001";
  negRisk?: boolean;
}

/** Place a limit order using createAndPostOrder */
export async function placeLimitOrder(
  client: ClobClient,
  params: PlaceLimitOrderParams
): Promise<{ orderID: string; status: string }> {
  const side = params.side === "BUY" ? Side.BUY : Side.SELL;
  const tickSize = params.tickSize ?? "0.01";
  const negRisk = params.negRisk ?? false;
  const result = await client.createAndPostOrder(
    {
      tokenID: params.tokenId,
      price: params.price,
      size: params.size,
      side,
    },
    { tickSize, negRisk },
    OrderType.GTC
  );
  return {
    orderID: (result as { orderID?: string }).orderID ?? (result as { id?: string }).id ?? "",
    status: (result as { status?: string }).status ?? "unknown",
  };
}

export interface PlaceLimitOrderBatchResult {
  orderID: string;
  status: string;
  success?: boolean;
  errorMsg?: string;
}

/** Place multiple limit orders in one batch (single POST /orders). */
export async function placeLimitOrdersBatch(
  client: ClobClient,
  paramsList: PlaceLimitOrderParams[]
): Promise<PlaceLimitOrderBatchResult[]> {
  if (paramsList.length === 0) return [];
  const tickSize = "0.01";
  const negRisk = false;
  const args: Array<{ order: Awaited<ReturnType<ClobClient["createOrder"]>>; orderType: OrderType }> = [];
  for (const params of paramsList) {
    const side = params.side === "BUY" ? Side.BUY : Side.SELL;
    const order = await client.createOrder(
      {
        tokenID: params.tokenId,
        price: params.price,
        size: params.size,
        side,
      },
      { tickSize: params.tickSize ?? tickSize, negRisk: params.negRisk ?? negRisk }
    );
    args.push({ order, orderType: OrderType.GTC });
  }
  const raw = await client.postOrders(args);
  const results: PlaceLimitOrderBatchResult[] = [];
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { data?: unknown }).data)
      ? (raw as { data: unknown[] }).data
      : [raw];
  for (let i = 0; i < paramsList.length; i++) {
    const r = arr[i];
    if (r && typeof r === "object") {
      const orderID =
        (r as { orderID?: string }).orderID ??
        (r as { order_id?: string }).order_id ??
        (r as { id?: string }).id ??
        "";
      const status = (r as { status?: string }).status ?? "unknown";
      const success = (r as { success?: boolean }).success;
      const errorMsg =
        (r as { errorMsg?: string }).errorMsg ??
        (r as { error?: string }).error ??
        (r as { message?: string }).message ??
        "";
      results.push({
        orderID: String(orderID ?? ""),
        status,
        ...(success !== undefined && { success }),
        ...(errorMsg !== undefined && errorMsg !== "" && { errorMsg }),
      });
    } else {
      results.push({ orderID: "", status: "unknown" });
    }
  }
  return results;
}

/** Get balance for a conditional token (shares). Returns 0 if token_id missing or on error. Throws if response indicates 401 (caller should treat as auth invalid). */
export async function getBalance(client: ClobClient, tokenId: string): Promise<number> {
  try {
    const res = await client.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenId,
    });
    const status = (res as { status?: number }).status;
    const error = (res as { error?: string }).error;
    if (status === 401 || (error && String(error).toLowerCase().includes("unauthorized"))) {
      throw new Error("POLYMARKET_API_KEY_INVALID");
    }
    const raw = parseFloat((res as { balance?: string })?.balance ?? "0");
    if (!Number.isFinite(raw)) return 0;
    return raw / 1e6;
  } catch (e) {
    if (e instanceof Error && e.message === "POLYMARKET_API_KEY_INVALID") throw e;
    return 0;
  }
}

/** Cancel one order by ID. */
export async function cancelOrder(client: ClobClient, orderId: string): Promise<void> {
  await client.cancelOrder({ orderID: orderId });
}
