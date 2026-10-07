import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Alpaca } from "./alpaca.ts";
import type { GuardConfig } from "./guardrails.ts";
import type { Store } from "./store.ts";
import { createServer } from "./tools.ts";

export interface AppDeps {
  store: Store;
  alpaca: Alpaca;
  cfg: GuardConfig;
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

  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
    const { pathname } = new URL(req.url);

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
    const server = createServer({ alpaca: deps.alpaca, store: deps.store, cfg: deps.cfg });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return withCors(await transport.handleRequest(req));
  };
}
