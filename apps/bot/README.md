# apps/bot

The Telegram bot. Players start here.

| Command | What happens |
|---|---|
| `/start` | Registers the player from their Telegram profile and asks them to share their phone number (one tap). Returning players get the Play button. |
| *(shares contact)* | Verifies it's their own Ethiopian number, links it to their account (one number per account), then shows **Play**. |
| `/play` | The Play button, which opens the game as a Telegram Mini App. |
| `/balance` | Real (ETB) and demo balances. |
| `/help` | How it works. |

Private chats only. Phone sharing is required for real money; demo works without it.

```bash
pnpm dev:bot     # long polling, restarts on file changes
```

Run **one** instance per bot token: Telegram allows only one poller.

## Testing on your phone

1. Create a test bot with [@BotFather](https://t.me/BotFather): `/newbot`, then copy the token into `.env` as `TELEGRAM_BOT_TOKEN`.
2. Start the game server: `pnpm dev:game`.
3. Telegram only opens Mini Apps over HTTPS. Expose the game server with a tunnel, e.g. `cloudflared tunnel --url http://localhost:4001`, and put the `https://…trycloudflare.com` address in `.env` as `MINI_APP_URL`.
4. Start the bot: `pnpm dev:bot`. Open your bot in Telegram and send `/start`.

The bot also sets the chat's menu button to open the game, so players can launch it from next to the message box.

## Tests

`test/bot.test.ts` runs conversations against a simulated Telegram (no network, no real token): registration, phone verification, someone else's contact card, non-Ethiopian numbers, one number on two accounts, balances, and group chats being ignored.
