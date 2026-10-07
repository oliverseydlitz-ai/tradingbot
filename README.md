# portfolio-mcp

Remote MCP server (Cloudflare Worker) that lets Claude trade an **Alpaca paper-trading account**.
Served at `https://portfolio.oliverseydlitz.com/mcp` (Streamable HTTP), behind GitHub OAuth restricted to a single account.

**Paper only.** The Alpaca base URL is a constant in `src/alpaca.ts`. There is no switch to live; going live needs a code change.

## Tools
`get_account`, `get_positions`, `get_quotes`, `get_bars`, `get_market_clock`, `get_orders`, `place_order`, `cancel_order`, `get_trade_log`.

`place_order` guardrails (enforced in `src/guardrails.ts`, not by prompt): market open, US equities/ETFs only, long-only
(no shorting), no margin (buys must fit in cash net of open buy orders), max order 10% of equity (buys), max position 20% of
equity after the order, max 10 orders/day (D1), optional `SYMBOL_ALLOWLIST`. A `reason` is mandatory. Every attempt, including
guardrail rejections, is written to the `trades` table.

## One-time setup

```sh
npm ci

# 1. Cloudflare resources; paste the returned IDs into wrangler.toml
npx wrangler kv namespace create OAUTH_KV
npx wrangler d1 create portfolio-db
npx wrangler d1 migrations apply portfolio-db --remote

# 2. Set ALLOWED_GITHUB_LOGIN in wrangler.toml to your GitHub username

# 3. Two GitHub OAuth apps (github.com/settings/developers)
#    dev:  callback http://localhost:8788/callback
#    prod: callback https://portfolio.oliverseydlitz.com/callback
#    Homepage URL: the matching origin.

# 4. Prod secrets (paper-account Alpaca keys only)
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put ALPACA_KEY_ID
npx wrangler secret put ALPACA_SECRET_KEY

# 5. Deploy (creates the custom domain; the zone must be on the same Cloudflare account)
npx wrangler deploy
```

### Deploy from GitHub (CI)
`.github/workflows/deploy.yml` runs typecheck + tests on every push/PR and, on `main`, applies D1 migrations and deploys.
Add two repo secrets (Settings → Secrets and variables → Actions):
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers", plus D1 Edit)

Worker secrets (step 4) live in Cloudflare, not in GitHub; set them once with `wrangler secret put`.

## Local dev
Copy `.dev.vars.example` to `.dev.vars` (gitignored), fill in the **dev** OAuth app and paper keys, then:
```sh
npm run migrate:local
npm run dev           # http://localhost:8788
```
OAuth metadata requires an HTTPS resource URL, so end-to-end OAuth is best verified on the deployed Worker; the automated
tests (`npm test`) cover the full login/token/MCP flow with mocked GitHub and Alpaca.

## Connect Claude
claude.ai → Settings → Connectors → Add custom connector → `https://portfolio.oliverseydlitz.com/mcp`.
You can also check it with `npx @modelcontextprotocol/inspector`.

## Config (`wrangler.toml` `[vars]`)
`ALLOWED_GITHUB_LOGIN`, `MAX_ORDER_PCT`, `MAX_POSITION_PCT`, `MAX_ORDERS_PER_DAY`, `SYMBOL_ALLOWLIST` (comma-separated, empty = any).
