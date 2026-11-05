// The Authorization Server, written out by hand so every rule is visible.
//   GET  /auth/.well-known/openid-configuration   discovery
//   GET  /auth/jwks                               public signing keys
//   GET  /auth/authorize                          start of the browser flow
//   GET  /auth/login, POST /auth/login            user authentication
//   GET  /auth/consent, POST /auth/consent        user consent → authorization code
//   POST /auth/token                              code / refresh_token / client_credentials
//   GET  /auth/userinfo                           OIDC claims for an access token
//   GET  /auth/logout                             end the Authorization Server session

import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { CLIENTS, findClient, findUser, findUserBySub, ISSUER, IS_HTTPS, TTL, type OAuthClient } from "../shared/config.js";
import { traceIncoming } from "../shared/inspector.js";
import { kv } from "../shared/store.js";
import { randomId } from "../shared/util.js";
import { publicJwks, signAccessToken, signIdToken, verifyOwnAccessToken } from "./keys.js";
import { consentView, errorView, loginView } from "./views.js";

interface AuthRequest {
  client_id: string;
  redirect_uri: string;
  scope: string[];
  state?: string;
  nonce?: string;
  code_challenge: string;
  code_challenge_method: "S256";
}
interface AuthSession { sub: string; auth_time: number }
interface AuthCode extends AuthRequest { sub: string; auth_time: number }
interface RefreshRecord { sub: string; client_id: string; scope: string[]; family: string; used: boolean; auth_time: number }

const str = (v: unknown) => (typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : undefined);
const now = () => Math.floor(Date.now() / 1000);
const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export const authServer = Router();
authServer.use(traceIncoming("auth"));

// ---------------------------------------------------------------- discovery + keys
authServer.get("/.well-known/openid-configuration", (_req, res) => {
  res.json({
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    userinfo_endpoint: `${ISSUER}/userinfo`,
    jwks_uri: `${ISSUER}/jwks`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    scopes_supported: [...new Set(CLIENTS.flatMap((c) => c.scopes))],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    authorization_response_iss_parameter_supported: true,
    claims_supported: ["sub", "name", "preferred_username", "email", "email_verified", "auth_time", "nonce"],
  });
});

authServer.get("/jwks", async (_req, res) => {
  res.set("Cache-Control", "public, max-age=60").json(await publicJwks());
});

// ---------------------------------------------------------------- sessions
async function currentSession(req: Request): Promise<AuthSession | null> {
  const id = req.cookies?.as_session as string | undefined;
  return id ? kv.get<AuthSession>(`as_session:${id}`) : null;
}

function redirectWith(res: Response, redirectUri: string, params: Record<string, string | undefined>) {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  url.searchParams.set("iss", ISSUER); // RFC 9207: tells the client which server answered
  res.redirect(302, url.toString());
}

// ---------------------------------------------------------------- /authorize
authServer.get("/authorize", async (req, res) => {
  const q = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, str(v)]));
  const client = findClient(q.client_id);
  if (!client) {
    return res.status(400).send(errorView({ error: "invalid_client", description: `Unknown client_id "${q.client_id ?? ""}".` }));
  }
  if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) {
    return res.status(400).send(
      errorView({
        error: "invalid_request",
        description: `redirect_uri "${q.redirect_uri ?? ""}" is not registered for ${client.client_id}. It must match a registered URI exactly.`,
      }),
    );
  }
  // From here on errors are returned to the (verified) redirect_uri.
  const fail = (error: string, error_description: string) => redirectWith(res, q.redirect_uri!, { error, error_description, state: q.state });

  if (q.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
  if (!client.grant_types.includes("authorization_code")) return fail("unauthorized_client", "This client may not use the authorization code flow.");
  const scope = (q.scope ?? "").split(" ").filter(Boolean);
  const unknown = scope.filter((s) => !client.scopes.includes(s));
  if (!scope.length || unknown.length) return fail("invalid_scope", unknown.length ? `Scope not allowed: ${unknown.join(" ")}` : "No scope requested.");
  if (!q.code_challenge) return fail("invalid_request", "PKCE code_challenge is required.");
  if (q.code_challenge_method !== "S256") return fail("invalid_request", "code_challenge_method must be S256.");

  const reqId = randomId(12);
  const authReq: AuthRequest = {
    client_id: client.client_id,
    redirect_uri: q.redirect_uri,
    scope,
    state: q.state,
    nonce: q.nonce,
    code_challenge: q.code_challenge,
    code_challenge_method: "S256",
  };
  await kv.set(`authreq:${reqId}`, authReq, TTL.authRequest);
  const session = await currentSession(req);
  res.redirect(302, `/auth/${session ? "consent" : "login"}?req=${reqId}`);
});

async function loadAuthRequest(reqId: string | undefined) {
  if (!reqId) return null;
  const authReq = await kv.get<AuthRequest>(`authreq:${reqId}`);
  const client = authReq && findClient(authReq.client_id);
  return authReq && client ? { authReq, client } : null;
}

const expired = (res: Response) =>
  res.status(400).send(errorView({ error: "request_expired", description: "This sign-in request expired or was already used. Start again from the Client App." }));

// ---------------------------------------------------------------- login
authServer.get("/login", async (req, res) => {
  const reqId = str(req.query.req);
  const loaded = await loadAuthRequest(reqId);
  if (!loaded) return expired(res);
  res.send(loginView({ reqId: reqId!, client: loaded.client }));
});

authServer.post("/login", async (req, res) => {
  const { req: reqId, username, password } = req.body as Record<string, string | undefined>;
  const loaded = await loadAuthRequest(reqId);
  if (!loaded) return expired(res);
  const user = findUser(username);
  if (!user || !password || !safeEqual(password, user.password)) {
    return res.status(401).send(loginView({ reqId: reqId!, client: loaded.client, username, error: "Wrong username or password." }));
  }
  const sessionId = randomId(16);
  await kv.set(`as_session:${sessionId}`, { sub: user.sub, auth_time: now() } satisfies AuthSession, TTL.session);
  res.cookie("as_session", sessionId, { httpOnly: true, sameSite: "lax", secure: IS_HTTPS, path: "/auth", maxAge: TTL.session * 1000 });
  res.redirect(302, `/auth/consent?req=${reqId}`);
});

authServer.get("/logout", async (req, res) => {
  const id = req.cookies?.as_session as string | undefined;
  if (id) await kv.del(`as_session:${id}`);
  res.clearCookie("as_session", { path: "/auth" });
  const ret = str(req.query.return);
  res.redirect(302, ret && ret.startsWith("/") && !ret.startsWith("//") ? ret : "/client");
});

// ---------------------------------------------------------------- consent → code
authServer.get("/consent", async (req, res) => {
  const reqId = str(req.query.req);
  const loaded = await loadAuthRequest(reqId);
  if (!loaded) return expired(res);
  const session = await currentSession(req);
  const user = findUserBySub(session?.sub);
  if (!session || !user) return res.redirect(302, `/auth/login?req=${reqId}`);
  res.send(consentView({ reqId: reqId!, client: loaded.client, userName: user.name, scopes: loaded.authReq.scope }));
});

authServer.post("/consent", async (req, res) => {
  const { req: reqId, decision } = req.body as Record<string, string | undefined>;
  const session = await currentSession(req);
  if (!session) return res.redirect(302, `/auth/login?req=${reqId}`);
  const authReq = reqId ? await kv.getdel<AuthRequest>(`authreq:${reqId}`) : null; // single use
  if (!authReq) return expired(res);
  if (decision !== "allow") {
    return redirectWith(res, authReq.redirect_uri, { error: "access_denied", error_description: "The user denied the request.", state: authReq.state });
  }
  const code = randomId(24);
  await kv.set(`authcode:${code}`, { ...authReq, sub: session.sub, auth_time: session.auth_time } satisfies AuthCode, TTL.authCode);
  redirectWith(res, authReq.redirect_uri, { code, state: authReq.state });
});

// ---------------------------------------------------------------- /token
function tokenError(res: Response, status: number, error: string, error_description: string) {
  return res.status(status).json({ error, error_description });
}

/** Client authentication: HTTP Basic (client_secret_basic) or form fields (client_secret_post). */
function authenticateClient(req: Request): { client?: OAuthClient; basic: boolean } {
  const header = req.get("authorization");
  let id: string | undefined, secret: string | undefined;
  const basic = !!header?.startsWith("Basic ");
  if (basic) {
    const decoded = Buffer.from(header!.slice(6), "base64").toString("utf8");
    const i = decoded.indexOf(":");
    id = decodeURIComponent(decoded.slice(0, i));
    secret = decodeURIComponent(decoded.slice(i + 1));
  } else {
    id = str(req.body?.client_id);
    secret = str(req.body?.client_secret);
  }
  const client = findClient(id);
  return { client: client && secret && safeEqual(secret, client.client_secret) ? client : undefined, basic };
}

async function issueTokens(opts: { client: OAuthClient; sub: string; scope: string[]; nonce?: string; auth_time?: number; family?: string }) {
  const body: Record<string, unknown> = {
    access_token: await signAccessToken({ sub: opts.sub, client_id: opts.client.client_id, scope: opts.scope }),
    token_type: "Bearer",
    expires_in: TTL.accessToken,
    scope: opts.scope.join(" "),
  };
  const user = findUserBySub(opts.sub);
  if (user && opts.scope.includes("openid")) {
    body.id_token = await signIdToken({ user, client_id: opts.client.client_id, scope: opts.scope, nonce: opts.nonce, auth_time: opts.auth_time ?? now() });
  }
  if (user && opts.scope.includes("offline_access") && opts.client.grant_types.includes("refresh_token")) {
    const refresh = randomId(32);
    const rec: RefreshRecord = { sub: opts.sub, client_id: opts.client.client_id, scope: opts.scope, family: opts.family ?? randomId(8), used: false, auth_time: opts.auth_time ?? now() };
    await kv.set(`refresh:${refresh}`, rec, TTL.refreshToken);
    body.refresh_token = refresh;
  }
  return body;
}

authServer.post("/token", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const { client, basic } = authenticateClient(req);
  if (!client) {
    if (basic) res.set("WWW-Authenticate", 'Basic realm="token"');
    return tokenError(res, 401, "invalid_client", "Client authentication failed (wrong client_id or client_secret).");
  }
  const grant = str(req.body?.grant_type);
  if (!grant || !client.grant_types.includes(grant as never)) {
    return tokenError(res, 400, grant ? "unauthorized_client" : "invalid_request", `grant_type "${grant ?? ""}" not allowed for this client.`);
  }

  if (grant === "authorization_code") {
    const code = str(req.body.code) ?? "";
    const verifier = str(req.body.code_verifier) ?? "";
    const rec = await kv.get<AuthCode>(`authcode:${code}`);
    if (!rec) return tokenError(res, 400, "invalid_grant", "Authorization code is invalid, expired or already used.");
    if (rec.client_id !== client.client_id) return tokenError(res, 400, "invalid_grant", "Code was issued to a different client.");
    if (str(req.body.redirect_uri) !== rec.redirect_uri) return tokenError(res, 400, "invalid_grant", "redirect_uri does not match the one used in /authorize.");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (!verifier || challenge !== rec.code_challenge) {
      return tokenError(res, 400, "invalid_grant", "PKCE check failed: BASE64URL(SHA256(code_verifier)) does not equal the code_challenge.");
    }
    // Consume the code atomically: a second exchange of the same code must fail.
    if (!(await kv.getdel(`authcode:${code}`))) return tokenError(res, 400, "invalid_grant", "Authorization code was already used.");
    return res.json(await issueTokens({ client, sub: rec.sub, scope: rec.scope, nonce: rec.nonce, auth_time: rec.auth_time }));
  }

  if (grant === "refresh_token") {
    const token = str(req.body.refresh_token) ?? "";
    const rec = await kv.get<RefreshRecord>(`refresh:${token}`);
    if (!rec || rec.client_id !== client.client_id) return tokenError(res, 400, "invalid_grant", "Refresh token is invalid or expired.");
    if (await kv.get(`rtfamily:${rec.family}:revoked`)) return tokenError(res, 400, "invalid_grant", "This refresh token family was revoked after a reuse was detected.");
    if (rec.used) {
      await kv.set(`rtfamily:${rec.family}:revoked`, true, TTL.refreshToken);
      return tokenError(res, 400, "invalid_grant", "Refresh token reuse detected. The whole token family is now revoked; the user must sign in again.");
    }
    await kv.set(`refresh:${token}`, { ...rec, used: true }, TTL.refreshToken); // rotation
    return res.json(await issueTokens({ client, sub: rec.sub, scope: rec.scope, auth_time: rec.auth_time, family: rec.family }));
  }

  // client_credentials
  const requested = (str(req.body.scope) ?? client.scopes.join(" ")).split(" ").filter(Boolean);
  const notAllowed = requested.filter((s) => !client.scopes.includes(s));
  if (notAllowed.length) return tokenError(res, 400, "invalid_scope", `Scope not allowed: ${notAllowed.join(" ")}`);
  return res.json(await issueTokens({ client, sub: client.client_id, scope: requested }));
});

// ---------------------------------------------------------------- /userinfo
authServer.get("/userinfo", async (req, res) => {
  const header = req.get("authorization") ?? "";
  const bearerError = (status: number, error: string, desc: string) =>
    res.status(status).set("WWW-Authenticate", `Bearer error="${error}", error_description="${desc}"`).json({ error, error_description: desc });
  if (!header.startsWith("Bearer ")) return bearerError(401, "invalid_request", "Missing Bearer token");
  try {
    const claims = await verifyOwnAccessToken(header.slice(7));
    const scope = (claims.scope ?? "").split(" ");
    if (!scope.includes("openid")) return bearerError(403, "insufficient_scope", "openid scope required");
    const user = findUserBySub(claims.sub);
    if (!user) return bearerError(401, "invalid_token", "Unknown subject");
    const info: Record<string, unknown> = { sub: user.sub };
    if (scope.includes("profile")) Object.assign(info, { name: user.name, preferred_username: user.username });
    if (scope.includes("email")) Object.assign(info, { email: user.email, email_verified: true });
    res.json(info);
  } catch (e) {
    bearerError(401, "invalid_token", (e as Error).message.replace(/"/g, "'"));
  }
});
