// Plain-English explanations attached to each recorded HTTP exchange.

import type { TraceEvent } from "./inspector.js";

type Rule = { test: (e: TraceEvent, path: string, q: URLSearchParams) => boolean; note: (e: TraceEvent, q: URLSearchParams) => string };

const body = (e: TraceEvent) => new URLSearchParams(e.request.bodyType === "form" ? e.request.body ?? "" : "");
const respJson = (e: TraceEvent): Record<string, unknown> => {
  try {
    return e.response.bodyType === "json" ? JSON.parse(e.response.body ?? "{}") : {};
  } catch {
    return {};
  }
};
const errorOf = (e: TraceEvent) => {
  const j = respJson(e);
  return typeof j.error === "string" ? `${j.error}${j.error_description ? `: ${j.error_description}` : ""}` : "";
};

const rules: Rule[] = [
  {
    test: (_e, p) => p === "/client/start",
    note: () =>
      "The Client App starts the flow by redirecting the browser (302 + Location) to the Authorization Server's /authorize endpoint. " +
      "Everything travels in the URL: client_id, redirect_uri, scope, state (CSRF protection), nonce (binds the ID token to this login) " +
      "and code_challenge (PKCE: a SHA-256 hash of a secret code_verifier that never leaves the client until the token request).",
  },
  {
    test: (_e, p) => p === "/auth/authorize",
    note: (e) =>
      e.response.status >= 400
        ? "The Authorization Server rejected the request. A bad client_id or redirect_uri is shown to the user as an error page and is never redirected: redirecting to an unregistered URL would hand codes to an attacker."
        : (e.response.headers.location ?? "").includes("error=")
          ? "The request was understood but refused, so the error goes back to the client's redirect_uri as ?error=… (together with the original state)."
          : "The Authorization Server checks the client_id, the exact redirect_uri, response_type=code and the PKCE challenge, saves the request, and sends the user to log in (or straight to consent if a session already exists).",
  },
  {
    test: (e, p) => p === "/auth/login" && e.request.method === "GET",
    note: () => "The login page is served by the Authorization Server, not by the client. The client never sees the user's password.",
  },
  {
    test: (e, p) => p === "/auth/login" && e.request.method === "POST",
    note: (e) =>
      e.response.status === 302
        ? "Credentials checked. The Authorization Server sets its own session cookie (as_session) so the user won't have to log in again, then moves on to consent."
        : "Wrong username or password. The login page is shown again.",
  },
  {
    test: (e, p) => p === "/auth/consent" && e.request.method === "GET",
    note: () => "The consent screen lists the scopes the client asked for. The user decides whether this client may act on their behalf.",
  },
  {
    test: (e, p) => p === "/auth/consent" && e.request.method === "POST",
    note: (e) =>
      (e.response.headers.location ?? "").includes("code=")
        ? "Consent given. The Authorization Server creates a short-lived, single-use authorization code and redirects the browser back to the client's redirect_uri with ?code=…&state=…&iss=…. The code alone is useless without the client's secret and the PKCE code_verifier."
        : "Consent denied. The client gets ?error=access_denied.",
  },
  {
    test: (_e, p) => p === "/client/callback",
    note: (_e, q) =>
      q.get("error")
        ? `The browser lands back on the client with an error (${q.get("error")}). The client must still check state before trusting it.`
        : "The browser delivers the authorization code to the client's redirect_uri. The client first checks that state matches the value it stored. A mismatch means the response wasn't started by this user (CSRF / injected code).",
  },
  {
    test: (e, p) => p === "/auth/token" && body(e).get("grant_type") === "authorization_code",
    note: (e) =>
      e.response.status === 200
        ? "Back channel: the client exchanges the code directly with the Authorization Server, authenticating with its client_secret (HTTP Basic) and proving it started the flow with the PKCE code_verifier. The response carries access_token, id_token and refresh_token, with Cache-Control: no-store so tokens are never cached."
        : `Token request rejected (${errorOf(e)}). Codes are single-use, expire after 60 s, and need the matching code_verifier and redirect_uri.`,
  },
  {
    test: (e, p) => p === "/auth/token" && body(e).get("grant_type") === "refresh_token",
    note: (e) =>
      e.response.status === 200
        ? "The client trades its refresh token for a new access token without involving the user. Refresh token ROTATION: a new refresh_token is returned and the old one is now invalid."
        : `Refresh rejected (${errorOf(e)}). Presenting an already-used refresh token looks like token theft, so the whole token family is revoked.`,
  },
  {
    test: (e, p) => p === "/auth/token" && body(e).get("grant_type") === "client_credentials",
    note: (e) =>
      e.response.status === 200
        ? "Client Credentials: a machine authenticates as itself. There's no user, no browser, no redirect, and no refresh token (it can simply ask again)."
        : `Rejected (${errorOf(e)}).`,
  },
  {
    test: (_e, p) => p === "/auth/jwks",
    note: () =>
      "The JSON Web Key Set: the Authorization Server's PUBLIC signing keys. Anyone can verify a token's signature with it, but only the Authorization Server can create one. Callers cache it (here for 60 s), so it isn't fetched on every request.",
  },
  {
    test: (_e, p) => p === "/auth/userinfo",
    note: (e) =>
      e.response.status === 200
        ? "OpenID Connect UserInfo: the access token (Bearer) is presented and the server returns claims about the user, limited by the granted scopes (profile, email)."
        : "UserInfo refused the token. See the WWW-Authenticate header.",
  },
  {
    test: (_e, p) => p.startsWith("/auth/.well-known/"),
    note: () => "Discovery document: tells clients where every endpoint is and which features the server supports.",
  },
  {
    test: (_e, p) => p.startsWith("/api/"),
    note: (e) =>
      e.response.status === 200
        ? "The Resource API verified the Bearer token itself (signature via JWKS, iss, aud, exp) and checked that it has the required scope. It never talks to the user."
        : e.response.status === 401
          ? "401: the token is missing, expired or invalid. The WWW-Authenticate header says why (error=\"invalid_token\"). A client should refresh and retry."
          : e.response.status === 403
            ? "403: the token is valid but lacks the required scope (error=\"insufficient_scope\"). Refreshing won't help; the client needs a token with more scope."
            : "API response.",
  },
];

export function explain(e: TraceEvent): string | undefined {
  const u = new URL(e.request.url);
  const rule = rules.find((r) => r.test(e, u.pathname, u.searchParams));
  return rule?.note(e, u.searchParams);
}
