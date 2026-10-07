import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  // bindings
  OAUTH_PROVIDER: OAuthHelpers; // injected by OAuthProvider
  OAUTH_KV: KVNamespace;
  DB: D1Database;
  // secrets
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALPACA_KEY_ID: string;
  ALPACA_SECRET_KEY: string;
  // vars
  PUBLIC_URL: string;
  ALLOWED_GITHUB_LOGIN: string;
  MAX_ORDER_PCT: string;
  MAX_POSITION_PCT: string;
  MAX_ORDERS_PER_DAY: string;
  SYMBOL_ALLOWLIST: string;
}

export type AuthProps = { login: string; githubId: number };
