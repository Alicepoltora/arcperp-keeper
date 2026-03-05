/**
 * ArcPerp Keeper Bot — Railway Edition
 * 
 * Reads config from environment variables (set in Railway dashboard)
 * Updates PriceOracle prices every 60s from Binance + CoinGecko fallback
 * 
 * Required env vars in Railway:
 *   PRIVATE_KEY       — wallet private key (no 0x prefix)
 *   ORACLE_ADDRESS    — PriceOracle contract address
 *   CLEARING_HOUSE    — ClearingHouse contract address
 *   ARC_RPC_URL       — (optional) defaults to https://rpc.testnet.arc.network
 */

const { ethers } = require("ethers");

// ── Config from env ───────────────────────────────────────────
const PRIVATE_KEY     = process.env.PRIVATE_KEY;
const ORACLE_ADDRESS  = process.env.ORACLE_ADDRESS;
const CH_ADDRESS      = process.env.CLEARING_HOUSE;
const RPC_URL         = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
const INTERVAL_MS     = parseInt(process.env.INTERVAL_MS || "60000");

if (!PRIVATE_KEY)    { console.error("❌ PRIVATE_KEY env var required"); process.exit(1); }
if (!ORACLE_ADDRESS) { console.error("❌ ORACLE_ADDRESS env var required"); process.exit(1); }
if (!CH_ADDRESS)     { console.error("❌ CLEARING_HOUSE env var required"); process.exit(1); }

// ── ABIs ─────────────────────────────────────────────────────
const ORACLE_ABI = [
  "function updatePriceBatch(bytes32[] calldata markets, uint256[] calldata prices) external",
];
const CH_ABI = [
  "function updateFundingRate(bytes32 market) external",
];

// ── Markets ──────────────────────────────────────────────────
const MARKETS = ["BTC-USDC", "ETH-USDC", "SOL-USDC", "ARB-USDC", "LINK-USDC", "MATIC-USDC"];

const BINANCE_MAP = {
  "BTC-USDC":   "BTCUSDT",
  "ETH-USDC":   "ETHUSDT",
  "SOL-USDC":   "SOLUSDT",
  "ARB-USDC":   "ARBUSDT",
  "LINK-USDC":  "LINKUSDT",
  "MATIC-USDC": "MATICUSDT",
};

const CG_MAP = {
  "BTC-USDC":   "bitcoin",
  "ETH-USDC":   "ethereum",
  "SOL-USDC":   "solana",
  "ARB-USDC":   "arbitrum",
  "LINK-USDC":  "chainlink",
  "MATIC-USDC": "matic-network",
};

// ── Fetch prices ─────────────────────────────────────────────
async function fetchPrices() {
  // Try Binance first (no rate limits, no CORS)
  try {
    const symbols = JSON.stringify(Object.values(BINANCE_MAP));
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(symbols)}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
    const data = await res.json();
    const prices = {};
    data.forEach(item => {
      const market = Object.entries(BINANCE_MAP).find(([,s]) => s === item.symbol)?.[0];
      if (market) prices[market] = parseFloat(item.price);
    });
    if (Object.keys(prices).length > 0) return prices;
    throw new Error("Empty response");
  } catch(e) {
    console.warn("  Binance unavailable:", e.message, "— trying CoinGecko");
  }

  // Fallback: CoinGecko
  const ids = Object.values(CG_MAP).join(",");
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const data = await res.json();
  const prices = {};
  Object.entries(CG_MAP).forEach(([market, cgId]) => {
    if (data[cgId]?.usd) prices[market] = data[cgId].usd;
  });
  return prices;
}

// ── Main tick ────────────────────────────────────────────────
async function tick(oracle, ch) {
  try {
    const prices = await fetchPrices();

    // Build batch arrays
    const marketIds = [];
    const priceVals = [];
    const logParts  = [];

    for (const market of MARKETS) {
      const usd = prices[market];
      if (!usd) continue;
      marketIds.push(ethers.keccak256(ethers.toUtf8Bytes(market)));
      priceVals.push(BigInt(Math.round(usd * 1e8)));
      logParts.push(`${market.split("-")[0]}: $${usd.toFixed(2)}`);
    }

    if (marketIds.length === 0) {
      console.warn(`[${ts()}] ⚠️  No prices fetched`);
      return;
    }

    // Update oracle
    const tx = await oracle.updatePriceBatch(marketIds, priceVals, {
      gasPrice: ethers.parseUnits("200", "gwei"),
    });
    await tx.wait();
    console.log(`[${ts()}] ✅ Prices updated — ${logParts.join("  ")}`);

    // Update funding rates
    for (const market of MARKETS) {
      try {
        const ftx = await ch.updateFundingRate(
          ethers.keccak256(ethers.toUtf8Bytes(market)),
          { gasPrice: ethers.parseUnits("200", "gwei") }
        );
        await ftx.wait();
      } catch { /* no OI, skip */ }
    }

  } catch(e) {
    console.error(`[${ts()}] ❌ Keeper error:`, e.message);
  }
}

function ts() { return new Date().toISOString().slice(11, 19); }

// ── Start ────────────────────────────────────────────────────
async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  const oracle   = new ethers.Contract(ORACLE_ADDRESS, ORACLE_ABI, wallet);
  const ch       = new ethers.Contract(CH_ADDRESS, CH_ABI, wallet);

  console.log("🤖 ArcPerp Keeper Bot");
  console.log("   Oracle: ", ORACLE_ADDRESS);
  console.log("   CH:     ", CH_ADDRESS);
  console.log("   Wallet: ", wallet.address);
  console.log("   RPC:    ", RPC_URL);
  console.log("   Interval:", INTERVAL_MS / 1000, "sec");
  console.log();

  await tick(oracle, ch);
  setInterval(() => tick(oracle, ch), INTERVAL_MS);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
