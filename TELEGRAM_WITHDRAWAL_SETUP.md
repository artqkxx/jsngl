# Telegram setup for skin withdrawal requests

The withdrawal endpoint sends the submitted market screenshot and avatar to the private Telegram chat of the configured recipient. The bot token must only be configured on the server.

## Configure the server

Set these environment variables in the hosting control panel, then restart the app:

- `TELEGRAM_BOT_TOKEN`: the bot token from BotFather. Rotate the token first if it has ever been pasted into chat, committed, or otherwise shared.
- `WITHDRAWAL_ADMIN_USERNAME`: recipient username without `@` (defaults to `sogrsupport`).
- `TELEGRAM_WEBHOOK_SECRET`: a long random value used to authenticate Telegram webhook updates.
- `TELEGRAM_WITHDRAWAL_CHAT_ID`: optional. If set, requests go directly to this numeric Telegram chat ID.

## Connect the recipient chat

If `TELEGRAM_WITHDRAWAL_CHAT_ID` is not set, the server stores the chat ID when the configured recipient opens the bot and sends `/start`. Telegram must be able to reach the app at a public HTTPS address. Configure the bot webhook to:

`https://YOUR_PUBLIC_DOMAIN/api/telegram/webhook`

Set the webhook's Telegram `secret_token` to the same value as `TELEGRAM_WEBHOOK_SECRET`. Keep the existing webhook URL pointed at this route because it also handles Telegram Stars payments. After deployment, `@sogrsupport` should open `@sograderbot` and send `/start`; the bot will confirm the chat connection.

For local development, set `TELEGRAM_POLLING=1` instead of exposing a webhook. The local process will switch the bot from webhook delivery to long polling and relay updates (including Telegram Stars payment updates) into the existing handler. Run only one polling server for this bot at a time. Set `TELEGRAM_POLLING=0` on a hosted deployment and configure the HTTPS webhook above.
