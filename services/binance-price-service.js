const axios = require("axios");

const BINANCE_BASE = "https://api.binance.com";
const USD_STABLES = ["USDT", "USDC", "FDUSD", "TUSD", "USDP", "DAI", "BUSD"];
const PRIORITY_ASSETS = [...USD_STABLES, "BTC", "ETH", "BNB", "EUR", "TRY"];
const GRAPH_CACHE_TTL_MS = 60 * 60 * 1000;
const PRICE_CACHE_TTL_MS = 30 * 1000;
const MAX_HOPS = 4;

function createBinancePriceService() {
  let graphCache = { expiresAt: 0, graph: new Map() };
  let pricesCache = { expiresAt: 0, prices: new Map() };

  function getAssetPriority(asset) {
    const index = PRIORITY_ASSETS.indexOf(asset);
    return index === -1 ? PRIORITY_ASSETS.length + 100 : index;
  }

  function sortNeighbors(neighbors) {
    neighbors.sort((left, right) => {
      return getAssetPriority(left.to) - getAssetPriority(right.to);
    });
  }

  async function loadGraph() {
    if (graphCache.expiresAt > Date.now() && graphCache.graph.size > 0) {
      return graphCache.graph;
    }

    const response = await axios.get(`${BINANCE_BASE}/api/v3/exchangeInfo`, {
      timeout: 20000,
    });

    const nextGraph = new Map();
    const symbols = Array.isArray(response.data?.symbols) ? response.data.symbols : [];

    for (const symbolInfo of symbols) {
      if (symbolInfo.status !== "TRADING") continue;

      const symbol = symbolInfo.symbol;
      const baseAsset = symbolInfo.baseAsset;
      const quoteAsset = symbolInfo.quoteAsset;

      if (!symbol || !baseAsset || !quoteAsset) continue;

      if (!nextGraph.has(baseAsset)) nextGraph.set(baseAsset, []);
      if (!nextGraph.has(quoteAsset)) nextGraph.set(quoteAsset, []);

      nextGraph.get(baseAsset).push({ to: quoteAsset, symbol, operation: "multiply" });
      nextGraph.get(quoteAsset).push({ to: baseAsset, symbol, operation: "divide" });
    }

    for (const neighbors of nextGraph.values()) {
      sortNeighbors(neighbors);
    }

    graphCache = {
      expiresAt: Date.now() + GRAPH_CACHE_TTL_MS,
      graph: nextGraph,
    };

    return nextGraph;
  }

  async function loadPrices() {
    if (pricesCache.expiresAt > Date.now() && pricesCache.prices.size > 0) {
      return pricesCache.prices;
    }

    const response = await axios.get(`${BINANCE_BASE}/api/v3/ticker/price`, {
      timeout: 20000,
    });

    const nextPrices = new Map();
    const rows = Array.isArray(response.data) ? response.data : [];

    for (const row of rows) {
      const price = Number(row.price);
      if (!row.symbol || !Number.isFinite(price) || price <= 0) continue;
      nextPrices.set(row.symbol, price);
    }

    pricesCache = {
      expiresAt: Date.now() + PRICE_CACHE_TTL_MS,
      prices: nextPrices,
    };

    return nextPrices;
  }

  async function getUsdRate(asset) {
    const normalizedAsset = String(asset || "").toUpperCase().trim();
    if (!normalizedAsset) return null;

    if (USD_STABLES.includes(normalizedAsset)) {
      return {
        usdRate: 1,
        route: [normalizedAsset, "USD"],
      };
    }

    const [graph, prices] = await Promise.all([loadGraph(), loadPrices()]);
    const queue = [{ asset: normalizedAsset, usdRate: 1, hops: 0, route: [normalizedAsset] }];
    const visited = new Set([normalizedAsset]);

    while (queue.length > 0) {
      const current = queue.shift();
      if (USD_STABLES.includes(current.asset)) {
        return {
          usdRate: current.usdRate,
          route: [...current.route, "USD"],
        };
      }

      if (current.hops >= MAX_HOPS) continue;

      const neighbors = graph.get(current.asset) || [];
      for (const edge of neighbors) {
        if (visited.has(edge.to)) continue;

        const marketPrice = prices.get(edge.symbol);
        if (!Number.isFinite(marketPrice) || marketPrice <= 0) continue;

        const nextRate =
          edge.operation === "multiply"
            ? current.usdRate * marketPrice
            : current.usdRate / marketPrice;

        if (!Number.isFinite(nextRate) || nextRate <= 0) continue;

        visited.add(edge.to);
        queue.push({
          asset: edge.to,
          usdRate: nextRate,
          hops: current.hops + 1,
          route: [...current.route, edge.to],
        });
      }
    }

    return null;
  }

  async function quoteUsdValue(asset, amount) {
    const normalizedAmount = Number(amount);
    if (!Number.isFinite(normalizedAmount)) return null;

    const rateData = await getUsdRate(asset);
    if (!rateData) return null;

    return {
      usdValue: normalizedAmount * rateData.usdRate,
      usdRate: rateData.usdRate,
      route: rateData.route,
    };
  }

  return {
    getUsdRate,
    quoteUsdValue,
  };
}

module.exports = { createBinancePriceService };
