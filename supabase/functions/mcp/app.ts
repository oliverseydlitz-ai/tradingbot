import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Alpaca } from "./alpaca.ts";
import { createApi } from "./api.ts";
import type { GuardConfig } from "./guardrails.ts";
import type { Store } from "./store.ts";
import { createServer } from "./tools.ts";

export interface AppDeps {
  store: Store;
  alpaca: Alpaca;
  /** Limits used until settings are saved from the dashboard. */
  defaultCfg: GuardConfig;
  /** Origins allowed to call the dashboard API from a browser. */
  siteOrigins: string[];
  /** Public URL of this MCP endpoint, e.g. https://<ref>.supabase.co/functions/v1/mcp */
  resourceUrl: string;
  /** Supabase Auth issuer, e.g. https://<ref>.supabase.co/auth/v1 */
  authServerUrl: string;
  /** Validates a bearer token and returns the allowed identity, or null. Must enforce the single-user allowlist. */
  authenticate(token: string): Promise<{ login: string } | null>;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, accept, mcp-protocol-version, mcp-session-id",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-expose-headers": "www-authenticate, mcp-session-id",
};

const withCors = (res: Response) => {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
};

export function createHandler(deps: AppDeps) {
  const prmUrl = `${deps.resourceUrl}/.well-known/oauth-protected-resource`;
  // Saved settings win; a DB error propagates rather than silently falling back to looser defaults.
  const getCfg = async () => (await deps.store.getSettings()) ?? deps.defaultCfg;
  const api = createApi({ alpaca: deps.alpaca, store: deps.store, getCfg });

  const apiCors = (req: Request): Record<string, string> => {
    const origin = req.headers.get("origin") ?? "";
    return {
      ...(deps.siteOrigins.includes(origin) ? { "access-control-allow-origin": origin, vary: "origin" } : {}),
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
    };
  };
  const withHeaders = (res: Response, extra: Record<string, string>) => {
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(extra)) h.set(k, v);
    return new Response(res.body, { status: res.status, headers: h });
  };

  return async (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url);
    const apiRoute = /\/api(\/[^?]*)?$/.exec(pathname)?.[1];

    // Dashboard API: same bearer-token auth and single-user allowlist as the MCP endpoint.
    if (apiRoute !== undefined || /\/api$/.test(pathname)) {
      const cors = apiCors(req);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      const tok = /^Bearer (.+)$/i.exec(req.headers.get("authorization") ?? "");
      const who = tok ? await deps.authenticate(tok[1]).catch(() => null) : null;
      if (!who) return withHeaders(Response.json({ error: "unauthorized" }, { status: 401 }), cors);
      try {
        return withHeaders(await api(req, apiRoute ?? "/"), cors);
      } catch (e) {
        console.error("api error", (e as Error).message);
        return withHeaders(Response.json({ error: (e as Error).message }, { status: 500 }), cors);
      }
    }

    if (req.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));

    // RFC 9728 metadata. Served here because the function can only answer under /functions/v1/mcp/*;
    // the 401 challenge below points clients at it.
    if (pathname.endsWith("/.well-known/oauth-protected-resource")) {
      return withCors(
        Response.json({
          resource: deps.resourceUrl,
          authorization_servers: [deps.authServerUrl],
          bearer_methods_supported: ["header"],
          resource_name: "Portfolio paper-trading MCP",
        }),
      );
    }

    const m = /^Bearer (.+)$/i.exec(req.headers.get("authorization") ?? "");
    const user = m ? await deps.authenticate(m[1]).catch(() => null) : null;
    if (!user) {
      return withCors(
        new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate": `Bearer resource_metadata="${prmUrl}"`,
          },
        }),
      );
    }

    // Stateless: a fresh server + transport per request.
    const server = createServer({ alpaca: deps.alpaca, store: deps.store, getCfg });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return withCors(await transport.handleRequest(req));
  };
}
