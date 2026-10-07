import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";

const ORIGIN = "https://portfolio.oliverseydlitz.com";
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

function fakeKV(): KVNamespace {
  const m = new Map<string, string>();
  return {
    get: async (k: string, o?: any) => {
      const v = m.get(k);
      return v == null ? null : o === "json" || o?.type === "json" ? JSON.parse(v) : v;
    },
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    list: async () => ({ keys: [...m.keys()].map((name) => ({ name })), list_complete: true }),
  } as unknown as KVNamespace;
}

const env = (): Env => ({
  OAUTH_KV: fakeKV(), DB: undefined as any, OAUTH_PROVIDER: undefined as any,
  GITHUB_CLIENT_ID: "gh-id", GITHUB_CLIENT_SECRET: "gh-secret", ALPACA_KEY_ID: "k", ALPACA_SECRET_KEY: "s",
  PUBLIC_URL: ORIGIN, ALLOWED_GITHUB_LOGIN: "Oliver",
  MAX_ORDER_PCT: "10", MAX_POSITION_PCT: "20", MAX_ORDERS_PER_DAY: "10", SYMBOL_ALLOWLIST: "",
});

let ghLogin = "oliver";
beforeAll(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://github.com/login/oauth/access_token")) return Response.json({ access_token: "gho_fake" });
    if (url.startsWith("https://api.github.com/user")) return Response.json({ login: ghLogin, id: 42 });
    return new Response("unmocked " + url, { status: 500 });
  }));
});
afterEach(() => { ghLogin = "oliver"; });

const b64url = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

class Jar {
  c = new Map<string, string>();
  add(res: Response) { for (const s of res.headers.getSetCookie()) { const [kv] = s.split(";"); const i = kv.indexOf("="); this.c.set(kv.slice(0, i), kv.slice(i + 1)); } }
  get header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join("; "); }
}

async function login(e: Env, user: string) {
  ghLogin = user;
  const jar = new Jar();
  const reg = await worker.fetch(new Request(`${ORIGIN}/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  }), e, ctx);
  const client = (await reg.json()) as any;
  const verifier = "v".repeat(60);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const q = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", state: "xyz", code_challenge: challenge, code_challenge_method: "S256", resource: `${ORIGIN}/mcp`, scope: "mcp" });

  const page = await worker.fetch(new Request(`${ORIGIN}/authorize?${q}`), e, ctx);
  expect(page.status).toBe(200);
  jar.add(page);
  const handle = /name="handle" value="([^"]+)"/.exec(await page.text())![1];

  const post = await worker.fetch(new Request(`${ORIGIN}/authorize`, {
    method: "POST", headers: { cookie: jar.header, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ handle, decision: "approve" }),
  }), e, ctx);
  expect(post.status).toBe(302);
  jar.add(post);
  const gh = new URL(post.headers.get("location")!);
  expect(gh.origin + gh.pathname).toBe("https://github.com/login/oauth/authorize");
  expect(gh.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/callback`);

  const cb = await worker.fetch(new Request(`${ORIGIN}/callback?code=ghcode&state=${gh.searchParams.get("state")}`, { headers: { cookie: jar.header } }), e, ctx);
  return { cb, client, verifier };
}

describe("GitHub login allowlist", () => {
  it("lets the allowlisted account (case-insensitive) through and issues a working MCP token", async () => {
    const e = env();
    const { cb, client, verifier } = await login(e, "oliver");
    expect(cb.status).toBe(302);
    const redirect = new URL(cb.headers.get("location")!);
    expect(redirect.origin + redirect.pathname).toBe("https://claude.ai/api/mcp/auth_callback");
    const code = redirect.searchParams.get("code")!;

    const tok = await worker.fetch(new Request(`${ORIGIN}/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: verifier, resource: `${ORIGIN}/mcp` }),
    }), e, ctx);
    expect(tok.status).toBe(200);
    const { access_token } = (await tok.json()) as any;

    const res = await worker.fetch(new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }), e, ctx);
    expect(res.status).toBe(200);
    const raw = await res.text();
    const names = [...raw.matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(expect.arrayContaining(["get_account", "get_positions", "get_quotes", "get_bars", "get_market_clock", "get_orders", "place_order", "cancel_order", "get_trade_log"]));
  });

  it("returns 403 for any other GitHub account and issues no code", async () => {
    const { cb } = await login(env(), "mallory");
    expect(cb.status).toBe(403);
    expect(cb.headers.get("location")).toBeNull();
  });
});
