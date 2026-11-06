// NEAR Intents 1Click: token prices and dry quotes. Read-only: `dry: true` commits nothing and
// returns no deposit address. Nothing in the scripts requests a non-dry quote.

import { CliError } from './cli.mjs';

const BASE = () => (process.env.NEAR_INTENTS_ONE_CLICK_URL || 'https://1click.chaindefuser.com/v0').replace(/\/$/, '');

function headers() {
  const h = { accept: 'application/json', 'content-type': 'application/json' };
  if (process.env.NEAR_INTENTS_JWT) h.authorization = `Bearer ${process.env.NEAR_INTENTS_JWT}`;
  return h;
}

export class OneClickError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'OneClickError';
    this.status = status;
  }
}

async function request(path, init = {}) {
  let res;
  try {
    res = await fetch(`${BASE()}${path}`, { ...init, headers: headers(), signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new OneClickError(502, `1Click request failed: ${error.message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      message = JSON.parse(text).message ?? message;
    } catch {
      // keep the status line
    }
    throw new OneClickError(res.status, message);
  }
  return JSON.parse(text);
}

export async function getTokens() {
  return request('/tokens');
}

/** Live USD price and decimals for each asset id. Throws if any asset is missing. */
export async function pricesFor(assetIds) {
  let tokens;
  try {
    tokens = await getTokens();
  } catch (error) {
    throw new CliError(`cannot read 1Click token prices (${error.message}); price floors and caps are derived from them`);
  }
  const out = new Map();
  for (const id of assetIds) {
    const token = tokens.find((t) => t.assetId === id);
    if (!token || typeof token.price !== 'number' || !(token.price > 0)) {
      throw new CliError(`1Click /tokens has no usable price for ${id}`);
    }
    out.set(id, { price: token.price, decimals: token.decimals, symbol: token.symbol, priceUpdatedAt: token.priceUpdatedAt });
  }
  return out;
}

/** EXACT_INPUT dry quote between two assets held on intents.near. */
export async function dryQuote({ originAsset, destinationAsset, amount, recipient, slippageBps = 100 }) {
  return request('/quote', {
    method: 'POST',
    body: JSON.stringify({
      dry: true,
      swapType: 'EXACT_INPUT',
      slippageTolerance: slippageBps,
      originAsset,
      depositType: 'INTENTS',
      destinationAsset,
      amount: String(amount),
      refundTo: recipient,
      refundType: 'INTENTS',
      recipient,
      recipientType: 'INTENTS',
      deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
    }),
  });
}
