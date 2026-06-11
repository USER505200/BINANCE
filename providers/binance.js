const crypto = require("crypto");
const axios = require("axios");

const BINANCE_BASE = "https://api.binance.com";

function createBinanceProvider({ env = process.env } = {}) {
  const providerKey = "binance";
  const providerName = "Binance";

  function sign(queryString) {
    return crypto
      .createHmac("sha256", env.BINANCE_API_SECRET)
      .update(queryString)
      .digest("hex");
  }

  async function signedGet(path, query = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        params.append(key, String(value));
      }
    }

    params.append("timestamp", String(Date.now()));
    params.append("recvWindow", "60000");

    const signature = sign(params.toString());
    params.append("signature", signature);

    const url = `${BINANCE_BASE}${path}?${params.toString()}`;
    const response = await axios.get(url, {
      headers: { "X-MBX-APIKEY": env.BINANCE_API_KEY },
      timeout: 20000,
    });

    return response.data;
  }

  function validateEnv() {
    const missing = [];
    if (!env.BINANCE_API_KEY) missing.push("BINANCE_API_KEY");
    if (!env.BINANCE_API_SECRET) missing.push("BINANCE_API_SECRET");
    return missing;
  }

  function mapStatus(statusCode) {
    if (statusCode === 1) return "Confirmed";
    if (statusCode === 6) return "Credited (locked for withdrawal)";
    if (statusCode === 0) return "Pending";
    return `Status ${statusCode}`;
  }

  function isConfirmed(statusCode) {
    return statusCode === 1 || statusCode === 6;
  }

  function uniqueDepositId(raw) {
    return [
      providerKey,
      raw.txId || "no_txid",
      raw.coin || "coin",
      raw.amount || "amount",
      raw.insertTime || "time",
      raw.network || "network",
      raw.address || "address",
    ].join("|");
  }

  function normalizeDeposit(raw) {
    const statusCode = Number(raw.status);

    return {
      id: uniqueDepositId(raw),
      providerKey,
      providerName,
      accountName: env.BINANCE_ACCOUNT_NAME || "My Binance Account",
      coin: raw.coin || "Unknown",
      amount: raw.amount || "0",
      network: raw.network || "Unknown",
      from: raw.address || raw.sourceAddress || "Unknown",
      txId: raw.txId || "Unknown",
      timestamp: Number(raw.insertTime) || Date.now(),
      status: mapStatus(statusCode),
      statusCode,
      isConfirmed: isConfirmed(statusCode),
      raw,
    };
  }

  async function fetchDeposits({ limit = 1000 } = {}) {
    const data = await signedGet("/sapi/v1/capital/deposit/hisrec", { limit });
    if (!Array.isArray(data)) return [];
    return data.map(normalizeDeposit);
  }

  async function ping() {
    await fetchDeposits({ limit: 1 });
    return { ok: true, message: "Deposit history API is reachable." };
  }

  function buildTestDeposit() {
    return {
      id: `${providerKey}|test|${Date.now()}`,
      providerKey,
      providerName,
      accountName: env.BINANCE_ACCOUNT_NAME || "My Binance Account",
      coin: "USDT",
      amount: "125.50",
      network: "BEP20",
      from: "0xTestWalletAddress1234567890",
      txId: "TEST-TXID-NOT-REAL",
      timestamp: Date.now(),
      status: "Confirmed",
      statusCode: 1,
      isConfirmed: true,
      raw: { test: true },
    };
  }

  return {
    key: providerKey,
    displayName: providerName,
    validateEnv,
    fetchDeposits,
    ping,
    buildTestDeposit,
  };
}

module.exports = { createBinanceProvider };
