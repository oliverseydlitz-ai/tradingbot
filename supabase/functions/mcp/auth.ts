export interface SupabaseUserLike {
  identities?: { provider: string; identity_data?: Record<string, unknown> | null }[] | null;
}

/** Returns the lowercased GitHub login if (and only if) it equals the allowlisted login. */
export function allowedGithubLogin(user: SupabaseUserLike, allowedLogin: string): string | null {
  const allowed = allowedLogin.trim().toLowerCase();
  if (!allowed) return null;
  const gh = user.identities?.find((i) => i.provider === "github");
  const login = String(gh?.identity_data?.user_name ?? "").toLowerCase();
  return login && login === allowed ? login : null;
}
