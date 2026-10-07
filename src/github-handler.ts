import {
  AuthorizationError,
  CimdFetchError,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import type { AuthProps, Env } from "./env";

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const html = (body: string, headers: Headers, status = 200) => {
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(body, { status, headers });
};
const plain = (msg: string, status: number) =>
  new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

const b64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const s256 = async (v: string) => b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));

function consentPage(d: ConsentDescription, handle: string) {
  const origin = d.clientDomain
    ? `Published by <strong>${esc(d.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize ${esc(d.clientName)}</title>
<style>body{font:16px system-ui;max-width:30rem;margin:12vh auto;padding:0 1rem;color:#111}
button{font:inherit;padding:.6rem 1.2rem;border-radius:.5rem;border:1px solid #999;margin-right:.5rem;cursor:pointer}
button[value=approve]{background:#111;color:#fff}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}button{color:#eee;background:#222}button[value=approve]{background:#eee;color:#111}}</style>
<h1>Allow ${esc(d.clientName)} to trade your paper account?</h1>
<p>${origin} Access will be sent to <strong>${esc(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>" : ""}
<p>You will be asked to sign in with GitHub next. Only the allowlisted account can complete login.</p>
<form method="post"><input type="hidden" name="handle" value="${esc(handle)}">
<button name="decision" value="approve">Continue</button><button name="decision" value="deny">Deny</button></form>`;
}

export const githubHandler = {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/authorize" && req.method === "GET") return await showConsent(req, env);
      if (url.pathname === "/authorize" && req.method === "POST") return await handleConsent(req, env);
      if (url.pathname === "/callback" && req.method === "GET") return await handleCallback(req, env);
      if (url.pathname === "/" && req.method === "GET") return plain("portfolio-mcp: paper-trading MCP server. Connect at /mcp.\n", 200);
      return plain("Not found", 404);
    } catch (e) {
      if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
      if (e instanceof AuthorizationError) return plain(e.description, 400);
      if (e instanceof CimdFetchError) return plain("This app could not be verified.", 400);
      throw e;
    }
  },
};

async function showConsent(req: Request, env: Env) {
  const oauth = env.OAUTH_PROVIDER;
  const request = await oauth.parseAuthRequest(req);
  const details = await oauth.describeConsent(request);
  const consent = await oauth.beginConsent(request);
  return html(consentPage(details, consent.handle), consent.headers);
}

async function handleConsent(req: Request, env: Env) {
  const oauth = env.OAUTH_PROVIDER;
  const form = await req.formData();
  const handle = String(form.get("handle"));
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(req, handle);
    denied.headers.set("Location", denied.redirectTo);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(req, handle);
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const { state, headers } = await oauth.beginUpstream(approved.request, {
    data: { verifier },
    headers: approved.headers,
  });
  const gh = new URL("https://github.com/login/oauth/authorize");
  gh.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  gh.searchParams.set("redirect_uri", `${env.PUBLIC_URL}/callback`);
  gh.searchParams.set("state", state);
  gh.searchParams.set("code_challenge", await s256(verifier));
  gh.searchParams.set("code_challenge_method", "S256");
  headers.set("Location", gh.toString());
  return new Response(null, { status: 302, headers });
}

async function handleCallback(req: Request, env: Env) {
  const oauth = env.OAUTH_PROVIDER;
  const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(req);
  const params = new URL(req.url).searchParams;
  const code = params.get("code");
  if (params.get("error") || !code) {
    return plain("GitHub sign-in was cancelled or failed.", 400);
  }

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${env.PUBLIC_URL}/callback`,
      code_verifier: data.verifier,
    }),
  });
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) return plain("GitHub token exchange failed.", 502);

  const userRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token.access_token}`, "User-Agent": "portfolio-mcp", Accept: "application/vnd.github+json" },
  });
  if (!userRes.ok) return plain("Could not read GitHub profile.", 502);
  const user = (await userRes.json()) as { login: string; id: number };

  // The only identity check that matters: single-user allowlist.
  const allowed = env.ALLOWED_GITHUB_LOGIN.trim().toLowerCase();
  if (!allowed || user.login.toLowerCase() !== allowed) {
    console.warn("login rejected for GitHub user", user.login);
    return plain("Forbidden: this GitHub account is not allowed.", 403);
  }

  const props: AuthProps = { login: user.login, githubId: user.id };
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: String(user.id),
    metadata: { login: user.login },
    scope: original.scope,
    props,
  });
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}
