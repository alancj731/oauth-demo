// The Client App (relying party). Each POST runs exactly one protocol step and
// redirects back to the step page (Post/Redirect/Get), so the presenter controls
// the pace. Back-channel calls go through tracedFetch() and land in the Inspector.

import { createHash, randomBytes } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { compactVerify, createLocalJWKSet, decodeProtectedHeader, type JSONWebKeySet } from "jose";
import { APP_ORIGIN, ISSUER, SERVICE_CLIENT, WEB_CLIENT } from "../shared/config.js";
import { sidOf, traceIncoming, tracedFetch, type HttpRequestRecord } from "../shared/inspector.js";
import { randomId } from "../shared/util.js";
import { loadSession, saveSession, type Check, type ClientSession, type Tokens } from "./session.js";
import { authcodeView, failuresView, homeView, m2mView, refreshView } from "./views.js";

export const DEFAULT_SCOPE = "openid profile email offline_access api:read";
export const REDIRECT_URI = `${APP_ORIGIN}/client/callback`;
const TOKEN_URL = `${ISSUER}/token`;

const basicAuth = (id: string, secret: string) =>
  "Basic " + Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64");

/** Build the /authorize URL from the PKCE material. */
export function buildAuthUrl(p: NonNullable<ClientSession["pkce"]>) {
  const url = new URL(`${ISSUER}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: WEB_CLIENT.client_id,
    redirect_uri: REDIRECT_URI,
    scope: p.scope,
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

function newPkce(scope = DEFAULT_SCOPE, variant?: string): NonNullable<ClientSession["pkce"]> {
  const verifier = randomBytes(32).toString("base64url"); // 43 chars, RFC 7636 §4.1
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: randomId(12),
    nonce: randomId(12),
    scope,
    variant,
  };
}

function tokenRequestPreview(s: ClientSession, verifier: string): HttpRequestRecord {
  return {
    method: "POST",
    url: TOKEN_URL,
    headers: {
      host: new URL(TOKEN_URL).host,
      authorization: basicAuth(WEB_CLIENT.client_id, WEB_CLIENT.client_secret),
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: s.callback?.params.code ?? "",
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }).toString(),
    bodyType: "form",
  };
}

function storeTokens(s: ClientSession, body: Record<string, unknown> | null): Tokens | undefined {
  if (!body?.access_token) return undefined;
  return {
    access_token: String(body.access_token),
    token_type: String(body.token_type ?? "Bearer"),
    expires_at: Date.now() + Number(body.expires_in ?? 0) * 1000,
    scope: String(body.scope ?? ""),
    id_token: body.id_token ? String(body.id_token) : s.tokens?.id_token,
    refresh_token: body.refresh_token ? String(body.refresh_token) : s.tokens?.refresh_token,
  };
}

type Handler = (req: Request, res: Response, ctx: { id: string; s: ClientSession; sid: string }) => Promise<string | void>;

/** Load session → run step → save → 303 back to the page (anchor = step id). */
const step = (fn: Handler) => async (req: Request, res: Response) => {
  const { id, s } = await loadSession(req, res);
  const back = await fn(req, res, { id, s, sid: sidOf(res) });
  await saveSession(id, s);
  if (!res.headersSent) res.redirect(303, back ?? "/client");
};

export const clientApp = Router();

// ---------------------------------------------------------------- pages
const render = (view: (s: ClientSession) => string) => async (req: Request, res: Response) => {
  const { s } = await loadSession(req, res);
  res.set("Cache-Control", "no-store").send(view(s));
};
clientApp.get("/", render(homeView));
clientApp.get("/authcode", render(authcodeView));
clientApp.get("/refresh", render(refreshView));
clientApp.get("/m2m", render(m2mView));
clientApp.get("/failures", render(failuresView));
clientApp.get("/session.json", async (req, res) => {
  const { s } = await loadSession(req, res);
  res.set("Cache-Control", "no-store").json({
    _about: "This is the Client App's server-side session. Tokens live here (the backend), never in browser JavaScript.",
    pkce: s.pkce,
    callback: s.callback,
    tokens: s.tokens,
    m2m_access_token: s.m2m?.access_token,
  });
});

clientApp.post("/reset", step(async (_req, _res, { s }) => {
  for (const k of Object.keys(s)) delete (s as Record<string, unknown>)[k];
  return "/client";
}));

// ---------------------------------------------------------------- flow 1: auth code + PKCE + OIDC
clientApp.post("/authcode/prepare", step(async (_req, _res, { s }) => {
  const keep = { m2m: s.m2m, failures: s.failures };
  for (const k of Object.keys(s)) delete (s as Record<string, unknown>)[k];
  Object.assign(s, keep);
  s.pkce = newPkce();
  s.authUrl = buildAuthUrl(s.pkce);
  return "/client/authcode#step-pkce";
}));

/** Front channel: the client sends the browser to the Authorization Server. */
clientApp.get("/start", traceIncoming("client"), async (req, res) => {
  const { id, s } = await loadSession(req, res);
  if (req.query.variant === "bad-scope") {
    s.pkce = newPkce("openid admin:all", "bad-scope");
    s.authUrl = buildAuthUrl(s.pkce);
  }
  if (!s.pkce || !s.authUrl) {
    s.pkce = newPkce();
    s.authUrl = buildAuthUrl(s.pkce);
  }
  delete s.callback;
  delete s.tokenPreview;
  await saveSession(id, s);
  res.redirect(302, s.authUrl);
});

/** Front channel: the browser comes back with ?code&state (or ?error). */
clientApp.get("/callback", traceIncoming("client"), async (req, res) => {
  const { id, s } = await loadSession(req, res);
  const params = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v)]));
  const stateOk = !!s.pkce && params.state === s.pkce.state;
  const issOk = params.iss === ISSUER;
  s.callback = {
    params,
    stateOk,
    issOk,
    error: !stateOk
      ? "state mismatch: this response was not started by this browser session. Rejected (CSRF / code injection protection)."
      : !issOk
        ? "iss does not match the expected Authorization Server (mix-up attack protection)."
        : params.error
          ? `${params.error}: ${params.error_description ?? ""}`
          : undefined,
  };
  if (!stateOk) delete s.callback.params.code; // never use a code from an unverified response
  if (s.callback.error) delete s.tokenPreview;
  else s.tokenPreview = { request: tokenRequestPreview(s, s.pkce!.verifier) };
  await saveSession(id, s);
  res.redirect(302, "/client/authcode#step-callback");
});

clientApp.post("/authcode/exchange", step(async (req, _res, { s, sid }) => {
  const code = s.callback?.params.code;
  if (!code || !s.pkce || s.callback?.error) return "/client/authcode#step-callback";
  const wrong = req.body?.wrong === "1";
  const verifier = wrong ? randomBytes(32).toString("base64url") : s.pkce.verifier;
  const r = await tracedFetch({
    sid,
    from: "client",
    to: "auth",
    url: TOKEN_URL,
    headers: { authorization: basicAuth(WEB_CLIENT.client_id, WEB_CLIENT.client_secret) },
    form: { grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier },
  });
  if (wrong) {
    s.wrongVerifier = r.event;
    return "/client/authcode#step-token";
  }
  s.exchange = r.event;
  const tokens = storeTokens(s, r.json());
  if (tokens) {
    s.tokens = tokens;
    s.usedCode = code;
    delete s.idCheck;
    delete s.userinfo;
    delete s.api;
    delete s.refresh;
  }
  return "/client/authcode#step-token";
}));

clientApp.post("/authcode/verify", step(async (_req, _res, { s, sid }) => {
  const idToken = s.tokens?.id_token;
  if (!idToken || !s.pkce) return "/client/authcode#step-token";
  const r = await tracedFetch({ sid, from: "client", to: "auth", url: `${ISSUER}/jwks` });
  const checks: Check[] = [];
  const header = decodeProtectedHeader(idToken);
  let payload: Record<string, unknown> = {};
  try {
    const verified = await compactVerify(idToken, createLocalJWKSet(r.json<JSONWebKeySet>() ?? { keys: [] }));
    payload = JSON.parse(new TextDecoder().decode(verified.payload));
    checks.push({ name: "signature", ok: true, detail: `Valid ${header.alg} signature by key "${header.kid}" from ${ISSUER}/jwks` });
  } catch (e) {
    checks.push({ name: "signature", ok: false, detail: (e as Error).message });
    payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
  }
  const aud = payload.aud;
  const exp = Number(payload.exp ?? 0);
  checks.push(
    { name: "iss", ok: payload.iss === ISSUER, detail: `"${payload.iss}" must equal "${ISSUER}"` },
    { name: "aud", ok: aud === WEB_CLIENT.client_id || (Array.isArray(aud) && aud.includes(WEB_CLIENT.client_id)), detail: `"${aud}" must contain our client_id "${WEB_CLIENT.client_id}"` },
    { name: "exp", ok: exp * 1000 > Date.now(), detail: `expires ${new Date(exp * 1000).toISOString()}` },
    { name: "nonce", ok: payload.nonce === s.pkce.nonce, detail: `"${payload.nonce}" must equal the nonce we sent ("${s.pkce.nonce}"), which proves this token belongs to this login` },
  );
  s.idCheck = { checks, jwks: r.event };
  return "/client/authcode#step-verify";
}));

clientApp.post("/authcode/userinfo", step(async (_req, _res, { s, sid }) => {
  if (!s.tokens) return "/client/authcode";
  const r = await tracedFetch({ sid, from: "client", to: "auth", url: `${ISSUER}/userinfo`, headers: { authorization: `Bearer ${s.tokens.access_token}` } });
  s.userinfo = r.event;
  return "/client/authcode#step-userinfo";
}));

clientApp.post("/authcode/api", step(async (_req, _res, { s, sid }) => {
  if (!s.tokens) return "/client/authcode";
  const r = await tracedFetch({ sid, from: "client", to: "api", url: `${APP_ORIGIN}/api/profile`, headers: { authorization: `Bearer ${s.tokens.access_token}` } });
  s.api = r.event;
  return "/client/authcode#step-api";
}));

// ---------------------------------------------------------------- flow 2: refresh
const refreshLog = (s: ClientSession) => (s.refresh ??= { calls: [] });

clientApp.post("/refresh/call-api", step(async (_req, _res, { s, sid }) => {
  if (!s.tokens) return "/client/refresh";
  const r = await tracedFetch({ sid, from: "client", to: "api", url: `${APP_ORIGIN}/api/profile`, headers: { authorization: `Bearer ${s.tokens.access_token}` } });
  refreshLog(s).calls.push({ label: `Call API with access token ${r.status === 200 ? "(still valid)" : "(rejected)"}`, event: r.event });
  return "/client/refresh#log";
}));

async function useRefreshToken(s: ClientSession, sid: string, token: string, label: string) {
  const r = await tracedFetch({
    sid,
    from: "client",
    to: "auth",
    url: TOKEN_URL,
    headers: { authorization: basicAuth(WEB_CLIENT.client_id, WEB_CLIENT.client_secret) },
    form: { grant_type: "refresh_token", refresh_token: token },
  });
  refreshLog(s).calls.push({ label, event: r.event });
  return r;
}

clientApp.post("/refresh/refresh", step(async (_req, _res, { s, sid }) => {
  const old = s.tokens?.refresh_token;
  if (!old) return "/client/refresh";
  const r = await useRefreshToken(s, sid, old, "Refresh: trade refresh token for new tokens");
  const tokens = storeTokens(s, r.json());
  if (tokens && r.status === 200) {
    s.tokens = tokens;
    refreshLog(s).oldRefreshToken = old;
  }
  return "/client/refresh#log";
}));

clientApp.post("/refresh/replay", step(async (_req, _res, { s, sid }) => {
  const old = s.refresh?.oldRefreshToken;
  if (!old) return "/client/refresh";
  await useRefreshToken(s, sid, old, "Attack: replay the OLD (already rotated) refresh token");
  return "/client/refresh#log";
}));

clientApp.post("/refresh/after-replay", step(async (_req, _res, { s, sid }) => {
  const current = s.tokens?.refresh_token;
  if (!current) return "/client/refresh";
  await useRefreshToken(s, sid, current, "Try the NEWEST refresh token after the reuse was detected");
  return "/client/refresh#log";
}));

clientApp.post("/refresh/clear", step(async (_req, _res, { s }) => {
  if (s.refresh) s.refresh.calls = [];
  return "/client/refresh";
}));

// ---------------------------------------------------------------- flow 3: client credentials
clientApp.post("/m2m/token", step(async (_req, _res, { s, sid }) => {
  const r = await tracedFetch({
    sid,
    from: "client",
    to: "auth",
    url: TOKEN_URL,
    headers: { authorization: basicAuth(SERVICE_CLIENT.client_id, SERVICE_CLIENT.client_secret) },
    form: { grant_type: "client_credentials", scope: "reports:read" },
  });
  const body = r.json();
  s.m2m = { token: r.event, access_token: body?.access_token ? String(body.access_token) : undefined };
  return "/client/m2m#step-m2m-token";
}));

for (const [path, key, anchor] of [["reports", "reports", "step-m2m-api"], ["profile", "profile", "step-m2m-scope"]] as const) {
  clientApp.post(`/m2m/${path}`, step(async (_req, _res, { s, sid }) => {
    if (!s.m2m?.access_token) return "/client/m2m";
    const r = await tracedFetch({ sid, from: "client", to: "api", url: `${APP_ORIGIN}/api/${path}`, headers: { authorization: `Bearer ${s.m2m.access_token}` } });
    s.m2m[key] = r.event;
    return `/client/m2m#${anchor}`;
  }));
}

// ---------------------------------------------------------------- failure lab
const failure = (key: string, run: (s: ClientSession, sid: string) => Promise<{ event: import("../shared/inspector.js").TraceEvent } | undefined>) =>
  step(async (_req, _res, { s, sid }) => {
    const r = await run(s, sid);
    if (r) (s.failures ??= {})[key] = r.event;
    return `/client/failures#fail-${key}`;
  });

clientApp.post("/failures/replay-code", failure("replay-code", async (s, sid) => {
  if (!s.usedCode) return undefined;
  return tracedFetch({
    sid, from: "client", to: "auth", url: TOKEN_URL,
    headers: { authorization: basicAuth(WEB_CLIENT.client_id, WEB_CLIENT.client_secret) },
    form: { grant_type: "authorization_code", code: s.usedCode, redirect_uri: REDIRECT_URI, code_verifier: s.pkce?.verifier ?? "" },
  });
}));

clientApp.post("/failures/bad-secret", failure("bad-secret", (_s, sid) =>
  tracedFetch({
    sid, from: "client", to: "auth", url: TOKEN_URL,
    headers: { authorization: basicAuth(SERVICE_CLIENT.client_id, "not-the-secret") },
    form: { grant_type: "client_credentials", scope: "reports:read" },
  }),
));

clientApp.post("/failures/no-token", failure("no-token", (_s, sid) =>
  tracedFetch({ sid, from: "client", to: "api", url: `${APP_ORIGIN}/api/profile` }),
));

clientApp.post("/failures/forged-token", failure("forged-token", async (s, sid) => {
  // Take a real token and change the payload (e.g. add a scope) without re-signing.
  const real = s.tokens?.access_token ?? s.m2m?.access_token;
  if (!real) return undefined;
  const [h, p, sig] = real.split(".");
  const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  claims.scope = `${claims.scope} admin:all`;
  const forged = [h, Buffer.from(JSON.stringify(claims)).toString("base64url"), sig].join(".");
  return tracedFetch({ sid, from: "client", to: "api", url: `${APP_ORIGIN}/api/profile`, headers: { authorization: `Bearer ${forged}` } });
}));
