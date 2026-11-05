// RS256 signing key + token minting for the Authorization Server.
//
// The key must be identical on every serverless instance, so it comes from
// OAUTH_PRIVATE_JWK, or is generated once and stored in the shared store.

import { createLocalJWKSet, exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT, type JWK, type JWTPayload } from "jose";
import { API_AUDIENCE, ISSUER, TTL, type DemoUser } from "../shared/config.js";
import { kv } from "../shared/store.js";
import { randomId } from "../shared/util.js";

interface KeyMaterial {
  privateKey: CryptoKey | Uint8Array;
  publicJwk: JWK;
  kid: string;
}

let loading: Promise<KeyMaterial> | undefined;

async function loadKey(): Promise<KeyMaterial> {
  let jwk: JWK | null = process.env.OAUTH_PRIVATE_JWK ? (JSON.parse(process.env.OAUTH_PRIVATE_JWK) as JWK) : await kv.get<JWK>("signing-key");
  if (!jwk) {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const generated: JWK = { ...(await exportJWK(privateKey)), kid: `key-${randomId(6)}`, alg: "RS256", use: "sig" };
    await kv.setIfAbsent("signing-key", generated); // first instance wins
    jwk = (await kv.get<JWK>("signing-key")) ?? generated;
  }
  const kid = jwk.kid ?? "default";
  const privateKey = await importJWK({ ...jwk, kid }, "RS256");
  const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, ...pub } = jwk;
  return { privateKey, publicJwk: { ...pub, kid, alg: "RS256", use: "sig" }, kid };
}

export const signingKey = () => (loading ??= loadKey().catch((e) => ((loading = undefined), Promise.reject(e))));

export async function publicJwks() {
  return { keys: [(await signingKey()).publicJwk] };
}

/** RFC 9068 JWT access token. */
export async function signAccessToken(opts: { sub: string; client_id: string; scope: string[] }) {
  const { privateKey, kid } = await signingKey();
  const aud = opts.scope.includes("openid") ? [API_AUDIENCE, ISSUER] : API_AUDIENCE;
  return new SignJWT({ client_id: opts.client_id, scope: opts.scope.join(" ") })
    .setProtectedHeader({ alg: "RS256", kid, typ: "at+jwt" })
    .setIssuer(ISSUER)
    .setSubject(opts.sub)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(`${TTL.accessToken}s`)
    .setJti(randomId(12))
    .sign(privateKey);
}

/** OpenID Connect ID token: who logged in, for the client (aud = client_id). */
export async function signIdToken(opts: { user: DemoUser; client_id: string; scope: string[]; nonce?: string; auth_time: number }) {
  const { privateKey, kid } = await signingKey();
  const claims: JWTPayload = { auth_time: opts.auth_time };
  if (opts.nonce) claims.nonce = opts.nonce;
  if (opts.scope.includes("profile")) Object.assign(claims, { name: opts.user.name, preferred_username: opts.user.username });
  if (opts.scope.includes("email")) Object.assign(claims, { email: opts.user.email, email_verified: true });
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
    .setIssuer(ISSUER)
    .setSubject(opts.user.sub)
    .setAudience(opts.client_id)
    .setIssuedAt()
    .setExpirationTime(`${TTL.idToken}s`)
    .sign(privateKey);
}

/** Used by /auth/userinfo. The Authorization Server can check its own tokens locally. */
export async function verifyOwnAccessToken(token: string) {
  const jwks = createLocalJWKSet(await publicJwks());
  const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER, audience: ISSUER, typ: "at+jwt" });
  return payload as JWTPayload & { scope?: string; client_id?: string };
}
