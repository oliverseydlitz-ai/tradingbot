import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import type { AuthProps, Env } from "./env";
import { githubHandler } from "./github-handler";
import { createServer } from "./tools";

const mcpApi = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Defence in depth: OAuthProvider has already validated the token; re-check the identity.
    const props = (ctx as unknown as { props?: AuthProps }).props;
    if (!props || props.login.toLowerCase() !== env.ALLOWED_GITHUB_LOGIN.trim().toLowerCase()) {
      return new Response("Forbidden", { status: 403 });
    }
    return createMcpHandler(() => createServer(env), { route: "/mcp" })(request, env, ctx);
  },
};

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: mcpApi,
      defaultHandler: githubHandler,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      scopesSupported: ["mcp"],
      resourceMetadata: {
        resource: `${env.PUBLIC_URL}/mcp`,
        authorization_servers: [env.PUBLIC_URL],
      },
      clientIdMetadataDocumentEnabled: true,
    });
    return provider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
