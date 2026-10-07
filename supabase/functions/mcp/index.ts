import { createClient } from "@supabase/supabase-js";
import { Alpaca } from "./alpaca.ts";
import { createHandler } from "./app.ts";
import { allowedGithubLogin } from "./auth.ts";
import { parseConfig } from "./guardrails.ts";
import { supabaseStore } from "./supabase-store.ts";

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (r: Request) => Response | Promise<Response>): void };

const need = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`Missing env var ${k}`);
  return v;
};

const supabaseUrl = need("SUPABASE_URL");
const serviceKey = need("SUPABASE_SERVICE_ROLE_KEY");
// Single-user allowlist (override with the ALLOWED_GITHUB_LOGIN secret). Anyone else is rejected.
const allowedLogin = (Deno.env.get("ALLOWED_GITHUB_LOGIN") ?? "oliverseydlitz-ai").trim().toLowerCase();

const authClient = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

const handler = createHandler({
  store: supabaseStore(supabaseUrl, serviceKey),
  alpaca: new Alpaca({ keyId: Deno.env.get("ALPACA_KEY_ID") ?? "", secretKey: Deno.env.get("ALPACA_SECRET_KEY") ?? "" }),
  cfg: parseConfig({
    MAX_ORDER_PCT: Deno.env.get("MAX_ORDER_PCT") ?? "10",
    MAX_POSITION_PCT: Deno.env.get("MAX_POSITION_PCT") ?? "20",
    MAX_ORDERS_PER_DAY: Deno.env.get("MAX_ORDERS_PER_DAY") ?? "10",
    SYMBOL_ALLOWLIST: Deno.env.get("SYMBOL_ALLOWLIST") ?? "",
  }),
  resourceUrl: `${supabaseUrl}/functions/v1/mcp`,
  authServerUrl: `${supabaseUrl}/auth/v1`,
  async authenticate(token) {
    // getUser() validates the token with Supabase Auth, so it works for any JWT signing algorithm.
    const { data, error } = await authClient.auth.getUser(token);
    if (error || !data.user) return null;
    const login = allowedGithubLogin(data.user, allowedLogin);
    return login ? { login } : null;
  },
});

Deno.serve(handler);
