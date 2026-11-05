// The Resource API. It trusts nobody: every request needs a Bearer access token,
// which it verifies itself with the Authorization Server's public keys (JWKS).
//   GET /api/profile   needs scope api:read   (user data, via the web app)
//   GET /api/reports   needs scope reports:read (machine-to-machine)

import { Router, type NextFunction, type Request, type Response } from "express";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import { API_AUDIENCE, findUserBySub, ISSUER } from "../shared/config.js";
import { sidOf, traceIncoming, tracedFetch } from "../shared/inspector.js";

const JWKS_CACHE_MS = 60_000;
let jwksCache: { jwks: JSONWebKeySet; at: number } | undefined;

/** Fetch the JWKS over HTTP (a recorded back-channel call), cached for 60 s. */
async function getJwks(sid: string, force = false) {
  if (!force && jwksCache && Date.now() - jwksCache.at < JWKS_CACHE_MS) return jwksCache.jwks;
  const r = await tracedFetch({ sid, from: "api", to: "auth", url: `${ISSUER}/jwks` });
  const jwks = r.json<JSONWebKeySet>();
  if (r.status !== 200 || !jwks?.keys) throw new Error(`JWKS fetch failed (${r.status})`);
  jwksCache = { jwks, at: Date.now() };
  return jwks;
}

type Claims = JWTPayload & { scope?: string; client_id?: string };

function bearerError(res: Response, status: 401 | 403, error: string, description: string, scope?: string) {
  const parts = [`Bearer realm="api"`, `error="${error}"`, `error_description="${description.replace(/"/g, "'")}"`];
  if (scope) parts.push(`scope="${scope}"`);
  return res.status(status).set("WWW-Authenticate", parts.join(", ")).json({ error, error_description: description });
}

function requireScope(scope: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.get("authorization") ?? "";
    if (!header.startsWith("Bearer ")) {
      return res.status(401).set("WWW-Authenticate", 'Bearer realm="api"').json({ error: "invalid_request", error_description: "Missing Bearer token" });
    }
    const token = header.slice(7);
    const verify = async (force: boolean) =>
      (await jwtVerify(token, createLocalJWKSet(await getJwks(sidOf(res), force)), { issuer: ISSUER, audience: API_AUDIENCE, typ: "at+jwt" })).payload as Claims;
    let claims: Claims;
    try {
      try {
        claims = await verify(false);
      } catch (e) {
        // Unknown key id: the server may have rotated keys. Refresh the JWKS once.
        if ((e as { code?: string }).code !== "ERR_JWKS_NO_MATCHING_KEY") throw e;
        claims = await verify(true);
      }
    } catch (e) {
      const err = e as { code?: string; message: string };
      const msg = err.code === "ERR_JWT_EXPIRED" ? "The access token expired" : err.message;
      return bearerError(res, 401, "invalid_token", msg);
    }
    const granted = (claims.scope ?? "").split(" ");
    if (!granted.includes(scope)) return bearerError(res, 403, "insufficient_scope", `This endpoint needs scope ${scope}`, scope);
    res.locals.claims = claims;
    next();
  };
}

export const resourceServer = Router();
resourceServer.use(traceIncoming("api"));

resourceServer.get("/profile", requireScope("api:read"), (_req, res) => {
  const claims = res.locals.claims as Claims;
  const user = findUserBySub(claims.sub);
  res.json({
    message: `Hello ${user?.name ?? claims.sub}! This data came from the Resource API.`,
    token_seen_by_api: { sub: claims.sub, client_id: claims.client_id, scope: claims.scope, exp: claims.exp },
    orders: [
      { id: "A-1001", item: "Oat latte", total: 4.6 },
      { id: "A-1002", item: "Cold brew", total: 3.9 },
    ],
  });
});

resourceServer.get("/reports", requireScope("reports:read"), (_req, res) => {
  const claims = res.locals.claims as Claims;
  res.json({
    caller: claims.sub,
    note: "There's no user here: sub is the client_id of the calling service.",
    report: { period: "2026-Q3", revenue: 128400, orders: 9213 },
  });
});

resourceServer.use((_req, res) => res.status(404).json({ error: "not_found" }));
