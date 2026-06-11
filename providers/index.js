const { createBinanceProvider } = require("./binance");

const providerFactories = {
  binance: createBinanceProvider,
};

function parseEnabledProviders(rawValue) {
  if (!rawValue || !rawValue.trim()) return ["binance"];

  return rawValue
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function createProviders({ env = process.env } = {}) {
  const enabled = parseEnabledProviders(env.ENABLED_PROVIDERS);
  const providers = [];

  for (const providerKey of enabled) {
    const factory = providerFactories[providerKey];
    if (!factory) {
      console.warn(`[WARN] Unknown provider "${providerKey}" ignored.`);
      continue;
    }

    providers.push(factory({ env }));
  }

  return providers;
}

module.exports = { createProviders, parseEnabledProviders };
