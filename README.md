# OAuth Flow Lab

A hands-on demo of **OAuth 2.0 + OpenID Connect**. Four parties run inside one app, you drive every step by hand, and **every HTTP request between them is recorded**, including server-to-server calls that browser devtools can't see. Each request is explained in plain English.

| Party | Path | Role |
|---|---|---|
| Browser | – | Carries the front-channel redirects |
| Client App | `/client` | The relying party: a guided, step-by-step UI |
| Authorization Server | `/auth` | Login, consent, tokens, JWKS, userinfo, discovery |
| Resource API | `/api` | Protected API that checks JWTs itself (via JWKS) and checks scopes |
| Inspector | `/inspector` | Live sequence diagram + raw HTTP for every exchange |

Flows: **Authorization Code + PKCE + OIDC**, **Refresh token (with rotation + reuse detection)**, **Client Credentials**, plus a **Failure lab** (forged state, unregistered redirect_uri, unknown scope, wrong PKCE verifier, replayed code, wrong secret, missing token, tampered token, expired token, missing scope).

The OAuth logic is written by hand (no `oidc-provider`, no `passport`) so the code reads as teaching material. Start with `src/auth-server/index.ts`.

## Run locally

```bash
npm install
npm run dev          # http://localhost:3000
```

Open **/client** and **/inspector** in two windows side by side. No accounts or env vars are needed: state is kept in memory locally.

Demo logins: `alice / alice123`, `bob / bob123`. Clients: `demo-web-app / web-secret-123`, `reports-service / svc-secret-456`.

```bash
npm run smoke                        # headless end-to-end test of every flow + failure case
npm run smoke -- https://<app>.vercel.app
npm run typecheck
```

## Demo script (what to say at each step)

1. **Generate PKCE, state, nonce.** "The client creates one-time secrets. Only the *hash* of the verifier leaves now."
2. **Redirect to /authorize.** Point at the URL: everything in it is public, so nothing in it is secret. In the Inspector it's a dashed (front-channel) arrow.
3. **Login + consent.** The header changes to *Authorization Server*: "The client never sees the password."
4. **Callback.** The code arrives in the URL. Show the **state check**. Then try the *Forged callback* card in the Failure lab.
5. **Token exchange.** The first **solid** (back-channel) arrow. Show the Basic auth header and the `code_verifier`. Try *"Send with a wrong code_verifier"* first, which fails with `invalid_grant`.
6. **Validate the ID token.** JWKS fetch, signature, `iss`/`aud`/`exp`/`nonce`.
7. **/userinfo and /api/profile.** In the Inspector the API's own JWKS request sits *inside* the client→API call.
8. **Refresh.** Wait for the 60 s countdown → `401 invalid_token`, then refresh → new tokens (rotation), then replay the old refresh token → the whole family is revoked.
9. **Client Credentials.** No user, no browser: `200` on `/api/reports`, `403 insufficient_scope` on `/api/profile`.

## Deploy free on Vercel (Hobby)

In short: `vercel link`, add **Upstash Redis** from the project's Storage tab, then `vercel --prod`, and demo on the production domain. See **[DEPLOY.md](DEPLOY.md)** for step-by-step instructions, environment variables, custom domains, checking the deployment, and troubleshooting.

## How the traffic capture works

- `traceIncoming(party)` (in `src/shared/inspector.ts`) wraps each party's router and records what the browser sends to it, plus the response. The event is stored **before** the response is finished, because serverless functions can freeze right after responding.
- `tracedFetch()` is used for every back-channel call. The caller records the request and response, and the callee skips its own trace (`x-lab-trace` header), so every hop appears exactly once.
- Events are grouped per visitor by a `lab_sid` cookie, so on a public deployment each visitor sees only their own traffic. Platform noise headers (`x-vercel-*`, `sec-*`, …) and the demo's own cookie are removed from the record.
- `src/shared/notes.ts` attaches a plain-English explanation to each exchange.

## Layout

```
src/app.ts                    Express app (Vercel entry), mounts the four routers
src/dev.ts                    local server
src/shared/                   config (clients, users, TTLs), store (Upstash | memory), inspector, notes, layout
src/auth-server/              authorize / login / consent / token / userinfo / jwks / discovery, keys + token minting
src/resource-server/          /api/profile, /api/reports with JWT + scope checks
src/client-app/               guided flows (one POST per protocol step), session, views
src/inspector/                events API + page
public/                       theme.css (DESIGN.md tokens), http-view.js (shared renderer), app.js, inspector.js
scripts/smoke.ts              end-to-end test
```

The visual style follows `DESIGN.md`: warm cream canvas, four-tier greens, 50px pill buttons with a `scale(.95)` press, 12px whisper-shadow cards, House-Green header/footer bands, Inter as the SoDoSans substitute, and a floating "next step" button.

> Demo only. Users, clients and secrets are fake and intentionally visible. Don't reuse this as a production authorization server.
