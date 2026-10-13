# portfolio-mcp

Remote MCP server that lets Claude trade an **Alpaca paper-trading account**, plus a small static site.

| Piece | Where it runs |
|---|---|
| MCP server (`supabase/functions/mcp`) | Supabase Edge Function: `https://kdbmfnybaqcgluxqhntp.supabase.co/functions/v1/mcp` |
| Login | Supabase Auth (GitHub provider + OAuth 2.1 server with dynamic client registration) |
| Trade log + SPY snapshots | Supabase Postgres (`trades`, `snapshots`; RLS on, no public access) |
| Consent page + dashboard | GitHub Pages from `site/` at `https://portfolio.oliverseydlitz.com` (`/` is the dashboard, `/oauth/consent` the connector consent page) |
| DNS only | Cloudflare (`portfolio` CNAME to `oliverseydlitz-ai.github.io`, DNS-only) |

**Paper only.** The Alpaca base URL is a constant in `supabase/functions/mcp/alpaca.ts`; there is no switch to live.

## Tools
`get_account`, `get_positions`, `get_quotes`, `get_bars`, `get_market_clock`, `get_orders`, `place_order`, `cancel_order`, `get_trade_log`, `save_note`, `get_notes`.

`save_note` / `get_notes` are Claude's memory between scheduled runs (table `notes`): at the start of a run it reads recent notes, at the end it saves one, so a day with no trades still leaves context for the next run. Notes show on the dashboard.

`place_order` guardrails (`guardrails.ts`, enforced server-side): market open, US equities/ETFs only, long-only,
no margin (buys must fit in cash net of open buys), max order 10% of equity (buys), max position 20% of equity after the
order, max 10 orders/day, optional `SYMBOL_ALLOWLIST`, mandatory `reason`. Every attempt, including rejections, is logged.

## Telegram approval for big trades
When Claude's `place_order` is at or above the approval threshold (dashboard → bell icon, default 5% of equity, 0 = never ask), it is **not** sent. The server runs the guardrails, stores the request (table `approvals`), and Telegram messages you the trade and Claude's reason with **Yes / No** buttons. Claude is told it is pending and must not resubmit.
- **Yes** re-runs the guardrails against live conditions (market open, cash, caps) and then places the order, logged as `source = mcp` with "approved via Telegram" in the reason. **No** or no answer within `APPROVAL_TTL_MINUTES` (default 30) places nothing.
- A decision is claimed atomically, so double taps and Telegram retries can't place an order twice.
- Fails closed: if the Telegram message can't be sent, nothing is placed. Manual dashboard orders and orders under the threshold are unaffected.
- Optional: with no Telegram secrets set, every order goes straight out as before, and nothing is messaged.

Setup: talk to @BotFather → `/newbot` for the token; message your bot once, then read your chat id from `https://api.telegram.org/bot<TOKEN>/getUpdates`. Store `telegram_bot_token`, `telegram_chat_id` and `telegram_webhook_secret` in Vault (`select vault.create_secret('<value>', '<name>')`; the function reads them through `public.telegram_config()`, and Vault wins over function secrets), or set the function secrets `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET` (any long random string; Telegram allows `A-Za-z0-9_-`), optionally `APPROVAL_TTL_MINUTES` (default 30), apply `migrations/20261013000000_approvals.sql` and `migrations/20261013010000_bot_settings.sql`, redeploy, then register the webhook once:
```sh
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d url="https://kdbmfnybaqcgluxqhntp.supabase.co/functions/v1/mcp/telegram" \
  -d secret_token="<TELEGRAM_WEBHOOK_SECRET>" -d allowed_updates='["message","callback_query"]'
```
Only messages and taps from your chat id with the right secret header are acted on.

### Commands
| Command | Does |
|---|---|
| `/portfolio` (or `/status`) | Equity, day P&L, cash, positions with weight and P&L |
| `/perf` | You vs SPY: today, ~1 week, 1 month |
| `/quote TSLA AAPL` | Latest prices and today's change (up to 10) |
| `/buy 5 TSLA`, `/buy $500 TSLA`, `/buy 5 TSLA @ 240` | Market by shares, market by dollars, limit |
| `/sell 5 TSLA`, `/sell all TSLA` | Same, `all` sells the whole position |
| `/orders` | Open orders |
| `/cancel TSLA`, `/cancel all` | Cancel open orders for a symbol, or all |
| `/alert TSLA > 250`, `/alert TSLA < 200` | Price alert (one-shot, checked every 5 min while the market is open) |
| `/alerts`, `/unalert 3` | List / remove alerts |
| `/pause`, `/resume` | Kill switch: Claude's `place_order` is rejected (`PAUSED`, logged) while paused. Your own trades still work |
| `/settings` | Current bot settings |
| `/note text` | Saves a note (tags `telegram`, `oliver`). Claude reads it with `get_notes` on its next run; it shows on the dashboard |
| `/notes` | Last 5 notes |

Telegram trades go straight out (no confirm step) through the same guardrails as dashboard trades, logged as `source = manual` with the command as the reason. Optional, for the command menu in Telegram:
```sh
curl "https://api.telegram.org/bot<TOKEN>/setMyCommands" -H 'content-type: application/json' -d '{"commands":[
 {"command":"portfolio","description":"Portfolio state"},{"command":"buy","description":"/buy 5 TSLA"},
 {"command":"sell","description":"/sell 5 TSLA"},{"command":"orders","description":"Open orders"},
 {"command":"note","description":"Leave Claude a note"},{"command":"notes","description":"Recent notes"},
 {"command":"perf","description":"You vs SPY"},{"command":"quote","description":"/quote TSLA"},{"command":"cancel","description":"/cancel TSLA or all"},
 {"command":"alert","description":"/alert TSLA > 250"},{"command":"alerts","description":"Active alerts"},
 {"command":"pause","description":"Pause Claude"},{"command":"resume","description":"Resume Claude"},{"command":"settings","description":"Bot settings"}]}'
```

### Dashboard settings (bell icon)
| Setting | Default |
|---|---|
| Claude's trading on / paused (instant; also a banner with Resume on the dashboard) | on |
| Ask before Claude orders of ≥ X% of equity (0 = never) | 5% |
| Portfolio updates: off, hourly, 4 h, daily, weekly (hourly and 4 h only while the market is open) | off |
| Ping when Claude trades (order, size, its reason) | on |
| Ping on order fills | off |
| Big mover ping when a holding moves ±X% in a day, once per stock per day (0 = off) | off |
| Price alerts list, with remove | |

Claude has no tool to change any of these.

### Scheduler
Portfolio updates, price alerts, big movers and fill pings run from one tick: a pg_cron job pings the function every 5 minutes and each job decides whether it has anything to send. Run once in the SQL editor:
```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
select vault.create_secret('<TELEGRAM_WEBHOOK_SECRET>', 'telegram_webhook_secret');
select cron.schedule('telegram-tick', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://kdbmfnybaqcgluxqhntp.supabase.co/functions/v1/mcp/telegram/tick',
    headers := jsonb_build_object('x-telegram-bot-api-secret-token',
      (select decrypted_secret from vault.decrypted_secrets where name = 'telegram_webhook_secret'))
  )
$$);
```

## Dashboard
Sign in with GitHub (same allowlist). It shows equity vs SPY (indexed), allocation (stocks / ETFs / bond ETFs / cash), best and worst
performers, positions, a manual trade ticket, open orders, the trade log, and editable limits. It talks to the same edge function under
`/functions/v1/mcp/api/*`, authenticated with your Supabase session token.

- Manual orders use the same guardrails and logging as Claude's (`order-service.ts`), tagged `source = manual`. The daily order cap counts Claude's orders only.
- Limits live in the `settings` table (hard ceiling of 100% on the percentages, 1 to 100 orders/day). If none are saved, the `MAX_*` / `SYMBOL_ALLOWLIST` function secrets are the defaults.
- Claude has no MCP tool for changing limits; only the dashboard can.
- Bonds are bond ETFs, classified by asset name (`categorize.ts`). Crypto is excluded.

## Security model
- Only the GitHub login `ALLOWED_GITHUB_LOGIN` (default `oliverseydlitz-ai`) is accepted. Enforced in the edge function on every request (`auth.ts`), and also on the consent page.
- Alpaca keys live only in Supabase Edge Function secrets.
- The function is deployed with `verify_jwt=false` because it does its own bearer-token validation (`auth.getUser`) and must serve the unauthenticated OAuth discovery document.

## Setup checklist
1. Supabase → Authentication → Providers → GitHub: enable with a GitHub OAuth app (callback `https://kdbmfnybaqcgluxqhntp.supabase.co/auth/v1/callback`).
2. Supabase → Authentication → URL Configuration: Site URL `https://portfolio.oliverseydlitz.com`, add redirect URL `https://portfolio.oliverseydlitz.com/**`.
3. Supabase → Authentication → OAuth Server: enable, authorization path `/oauth/consent`, enable dynamic client registration.
4. Supabase → Edge Functions → Secrets: `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY` (paper keys). Optional: `TELEGRAM_*` / `APPROVAL_TTL_MINUTES` (see above), `ALLOWED_GITHUB_LOGIN`, `MAX_ORDER_PCT`, `MAX_POSITION_PCT`, `MAX_ORDERS_PER_DAY`, `SYMBOL_ALLOWLIST`.
5. GitHub → Settings → Pages: Source = **GitHub Actions** (the workflow deploys `site/`); custom domain `portfolio.oliverseydlitz.com`, Enforce HTTPS.
6. Cloudflare DNS: CNAME `portfolio` → `oliverseydlitz-ai.github.io`, proxy status DNS only.
7. claude.ai → Settings → Connectors → Add custom connector → the MCP URL above.

## Development
```sh
npm ci
npm run typecheck
npm test      # guardrails + MCP handler tests (mocked Alpaca, in-memory store)
```
The edge function is deployed with the Supabase connector or `supabase functions deploy mcp --no-verify-jwt`.
