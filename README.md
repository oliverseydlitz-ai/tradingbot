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
4. Supabase → Edge Functions → Secrets: `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY` (paper keys). Optional: `ALLOWED_GITHUB_LOGIN`, `MAX_ORDER_PCT`, `MAX_POSITION_PCT`, `MAX_ORDERS_PER_DAY`, `SYMBOL_ALLOWLIST`.
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
