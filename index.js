require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  SlashCommandBuilder,
} = require("discord.js");
const { createProviders } = require("./providers");
const { createBinancePriceService } = require("./services/binance-price-service");

const REQUIRED_ENV = ["DISCORD_BOT_TOKEN", "DISCORD_CHANNEL_ID"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing ENV variable: ${key}`);
    process.exit(1);
  }
}

const providers = createProviders({ env: process.env });
if (providers.length === 0) {
  console.error(
    "No enabled providers. Set ENABLED_PROVIDERS=binance (or another supported provider)."
  );
  process.exit(1);
}

for (const provider of providers) {
  const missing = provider.validateEnv();
  if (missing.length > 0) {
    console.error(`[${provider.displayName}] Missing ENV: ${missing.join(", ")}`);
    process.exit(1);
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const seenDepositIds = new Set();
const adminUserIds = parseCsvSet(process.env.BOT_ADMIN_USER_IDS);
const binancePriceService = createBinancePriceService();

const timezone = process.env.TIMEZONE || "Africa/Cairo";
const sendOldDeposits =
  String(process.env.SEND_OLD_DEPOSITS || "false").toLowerCase() === "true";
const checkEverySeconds = Math.max(
  15,
  parsePositiveInt(process.env.CHECK_EVERY_SECONDS, 60)
);
const fetchLimit = Math.max(1, parsePositiveInt(process.env.BINANCE_FETCH_LIMIT, 1000));

let firstRun = true;
let targetChannelCache = null;

function parseCsvSet(value) {
  if (!value || !value.trim()) return new Set();
  return new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function shortText(value, max = 90) {
  if (!value) return "Unknown";
  const text = String(value);
  if (text.length <= max) return text;
  const edge = Math.floor(max / 2);
  return `${text.slice(0, edge)}...${text.slice(-edge)}`;
}

function formatDate(timestampMs) {
  const value = Number(timestampMs);
  const date = Number.isFinite(value) ? new Date(value) : new Date();

  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(date);
}

function normalizeError(error) {
  const responseData = error?.response?.data;
  if (typeof responseData === "string") return responseData;
  if (responseData && typeof responseData === "object") {
    try {
      return JSON.stringify(responseData);
    } catch {
      return "Unknown API error";
    }
  }
  return error?.message || String(error);
}

function formatUsdValue(value) {
  if (!Number.isFinite(value)) return "Unavailable";

  let maximumFractionDigits = 2;
  if (Math.abs(value) < 1) maximumFractionDigits = 6;
  if (Math.abs(value) < 0.01) maximumFractionDigits = 8;

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits,
  }).format(value);
}

function buildDepositEmbed(deposit, { isTest = false } = {}) {
  const title = isTest
    ? `TEST - ${deposit.providerName} Deposit Notification`
    : `${deposit.providerName} Deposit Received`;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(isTest ? 0x4caf50 : 0xf0b90b)
    .addFields(
      {
        name: "Account",
        value: shortText(deposit.accountName || "Unknown"),
        inline: true,
      },
      { name: "Coin", value: shortText(deposit.coin || "Unknown"), inline: true },
      {
        name: "Amount",
        value: shortText(`${deposit.amount || "0"} ${deposit.coin || ""}`.trim()),
        inline: true,
      },
      {
        name: "USD Value",
        value: formatUsdValue(deposit.usdValue),
        inline: true,
      },
      {
        name: "Network",
        value: shortText(deposit.network || "Unknown"),
        inline: true,
      },
      { name: "From", value: shortText(deposit.from || "Unknown", 120), inline: false },
      { name: "TxID", value: shortText(deposit.txId || "Unknown", 120), inline: false },
      { name: "Date", value: formatDate(deposit.timestamp), inline: true },
      {
        name: "Status",
        value: shortText(deposit.status || "Pending"),
        inline: true,
      }
    )
    .setFooter({
      text: isTest
        ? "Test message from deposit monitor"
        : "Automatic deposit monitor",
    })
    .setTimestamp(new Date(Number(deposit.timestamp) || Date.now()));

  if (isTest) {
    embed.setDescription(
      "This is a test notification. No real deposit was received."
    );
    if (process.env.TEST_EMBED_IMAGE_URL) {
      embed.setImage(process.env.TEST_EMBED_IMAGE_URL);
    }
  }

  return embed;
}

async function getTargetChannel() {
  if (targetChannelCache && targetChannelCache.isTextBased()) {
    return targetChannelCache;
  }

  const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
  if (!channel || !channel.isTextBased()) {
    throw new Error("DISCORD_CHANNEL_ID must point to a text-based channel.");
  }

  targetChannelCache = channel;
  return channel;
}

async function sendDepositNotification(deposit, { isTest = false } = {}) {
  const channel = await getTargetChannel();
  const pricedDeposit = await enrichDepositWithUsdValue(deposit);
  const embed = buildDepositEmbed(pricedDeposit, { isTest });
  await channel.send({ embeds: [embed] });
}

async function enrichDepositWithUsdValue(deposit) {
  try {
    const usdQuote = await binancePriceService.quoteUsdValue(
      deposit.coin,
      deposit.amount
    );

    if (!usdQuote) return deposit;

    return {
      ...deposit,
      usdValue: usdQuote.usdValue,
      usdRate: usdQuote.usdRate,
      usdRoute: usdQuote.route,
    };
  } catch (error) {
    console.error(
      `USD pricing error for ${deposit.coin || "unknown coin"}:`,
      normalizeError(error)
    );
    return deposit;
  }
}

function isAuthorizedUser(userId) {
  if (adminUserIds.size === 0) return true;
  return adminUserIds.has(userId);
}

function getProviderByKey(providerKey) {
  if (!providerKey) return providers[0] || null;
  return providers.find((provider) => provider.key === providerKey) || null;
}

function buildCommandData() {
  const commandList = [];
  const providerChoices = providers.slice(0, 25).map((provider) => ({
    name: provider.displayName.slice(0, 100),
    value: provider.key.slice(0, 100),
  }));

  const depositTestCommand = new SlashCommandBuilder()
    .setName("deposit-test")
    .setDescription("Send a test deposit embed to the configured channel.");

  if (providerChoices.length > 1) {
    depositTestCommand.addStringOption((option) =>
      option
        .setName("provider")
        .setDescription("Provider to test")
        .setRequired(false)
        .addChoices(...providerChoices)
    );
  }

  const statusCommand = new SlashCommandBuilder()
    .setName("monitor-status")
    .setDescription("Check Discord + providers status quickly.");

  commandList.push(depositTestCommand.toJSON(), statusCommand.toJSON());
  return commandList;
}

async function registerSlashCommands() {
  const commands = buildCommandData();
  const guildId = process.env.DISCORD_GUILD_ID;

  if (guildId) {
    const guild = await client.guilds.fetch(guildId);
    await guild.commands.set(commands);
    console.log(`[OK] Slash commands synced to guild ${guildId}.`);
    return;
  }

  await client.application.commands.set(commands);
  console.log("[OK] Slash commands synced globally.");
}

async function collectMonitorStatus() {
  const report = [];
  report.push(`Time: ${formatDate(Date.now())}`);
  report.push(`Channel: ${process.env.DISCORD_CHANNEL_ID}`);
  report.push(`Providers: ${providers.map((provider) => provider.displayName).join(", ")}`);

  try {
    await getTargetChannel();
    report.push("Discord channel check: OK");
  } catch (error) {
    report.push(`Discord channel check: FAIL -> ${normalizeError(error)}`);
  }

  for (const provider of providers) {
    try {
      const result = await provider.ping();
      report.push(
        `${provider.displayName} API check: OK${
          result?.message ? ` -> ${result.message}` : ""
        }`
      );
    } catch (error) {
      report.push(
        `${provider.displayName} API check: FAIL -> ${normalizeError(error)}`
      );
    }
  }

  return report.join("\n");
}

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;

  if (!isAuthorizedUser(interaction.user.id)) {
    await interaction.reply({
      content:
        "You are not allowed to run this command. Add your user ID in BOT_ADMIN_USER_IDS.",
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === "deposit-test") {
    const providerKey = interaction.options.getString("provider");
    const provider = getProviderByKey(providerKey);

    if (!provider) {
      await interaction.reply({
        content: "Provider not found.",
        ephemeral: true,
      });
      return;
    }

    const testDeposit = provider.buildTestDeposit();
    await sendDepositNotification(testDeposit, { isTest: true });

    await interaction.reply({
      content: `Test embed sent to <#${process.env.DISCORD_CHANNEL_ID}> using ${provider.displayName}.`,
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === "monitor-status") {
    const statusText = await collectMonitorStatus();
    await interaction.reply({
      content: `\`\`\`\n${statusText}\n\`\`\``,
      ephemeral: true,
    });
  }
}

async function checkDepositsOnce() {
  const summaries = [];

  for (const provider of providers) {
    try {
      const deposits = await provider.fetchDeposits({ limit: fetchLimit });
      const confirmed = deposits.filter((deposit) => deposit.isConfirmed);
      confirmed.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

      let sentCount = 0;
      for (const deposit of confirmed) {
        if (seenDepositIds.has(deposit.id)) continue;
        seenDepositIds.add(deposit.id);

        if (firstRun && !sendOldDeposits) continue;
        await sendDepositNotification(deposit);
        sentCount += 1;
      }

      summaries.push(
        `${provider.displayName}: confirmed=${confirmed.length}, sent=${sentCount}`
      );
    } catch (error) {
      summaries.push(
        `${provider.displayName}: ERROR -> ${shortText(normalizeError(error), 140)}`
      );
    }
  }

  firstRun = false;
  console.log(`[CHECK] ${summaries.join(" | ")}`);
}

client.once("ready", async () => {
  console.log(`Discord bot logged in as ${client.user.tag}`);

  try {
    await registerSlashCommands();
  } catch (error) {
    console.error("Slash command registration error:", normalizeError(error));
  }

  await checkDepositsOnce();
  setInterval(checkDepositsOnce, checkEverySeconds * 1000);
});

client.on("interactionCreate", async (interaction) => {
  try {
    await handleInteraction(interaction);
  } catch (error) {
    console.error("Interaction error:", normalizeError(error));
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "Command failed. Check bot logs.",
        ephemeral: true,
      });
    }
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
