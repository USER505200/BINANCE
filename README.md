# Binance Deposit Discord Bot (Railway)

Bot sends a Discord embed when a Binance deposit becomes confirmed.

It now supports a provider architecture:
- `binance` is implemented.
- You can add more providers later (PayPal, other wallets) without rewriting the full bot.

## What It Sends

For each confirmed deposit, the embed includes:
- Account name
- Coin
- Amount
- USD value at current Binance market price
- Network
- Source/address (if available from Binance)
- TxID
- Date (with timezone)
- Status

## Required Environment Variables

```env
DISCORD_BOT_TOKEN=
DISCORD_CHANNEL_ID=
BINANCE_API_KEY=
BINANCE_API_SECRET=
```

## Optional Environment Variables

```env
# Recommended for faster slash command update in your server
DISCORD_GUILD_ID=

# Provider system
ENABLED_PROVIDERS=binance

# Polling and behavior
CHECK_EVERY_SECONDS=60
SEND_OLD_DEPOSITS=false
BINANCE_FETCH_LIMIT=1000
TIMEZONE=Africa/Cairo
BINANCE_ACCOUNT_NAME=Salvy

# Restrict who can run /deposit-test and /monitor-status
BOT_ADMIN_USER_IDS=

# Optional image URL shown in /deposit-test embed
TEST_EMBED_IMAGE_URL=
```

## Binance API Permission

Use **Read-only** API key.
Do not enable trading or withdrawals.

## Slash Commands (Test + Health Check)

After bot starts, it registers:

- `/deposit-test`
  - Sends a fake test embed to your configured channel.
  - No real transfer needed.

- `/monitor-status`
  - Checks Discord channel access + Binance API connectivity.
  - Returns status report.

If `BOT_ADMIN_USER_IDS` is set, only those user IDs can run these commands.

## Run

```bash
npm install
npm start
```

## Notes

- First run does not resend old deposits unless `SEND_OLD_DEPOSITS=true`.
- USD value is estimated from the current Binance spot market price at send time.
- Confirmed statuses from Binance are handled (`1` and `6`).
- Global slash commands may take time to appear. If you set `DISCORD_GUILD_ID`, they update faster in that guild.
