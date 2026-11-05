// Server-rendered pages for the Client App. HTTP exchanges and JWTs are embedded
// as JSON and drawn by /http-view.js, the same renderer the Inspector uses.

import { APP_ORIGIN, ISSUER, SERVICE_CLIENT, TTL, USERS, WEB_CLIENT } from "../shared/config.js";
import type { HttpRequestRecord, TraceEvent } from "../shared/inspector.js";
import { page, type PartyKey } from "../shared/layout.js";
import { html, jsonForScript, type Raw } from "../shared/util.js";
import type { ClientSession } from "./session.js";

// ---------------------------------------------------------------- building blocks
const exchange = (ev: TraceEvent | undefined, title?: string) =>
  ev ? html`<div class="exchange-mount" data-title="${title ?? ""}"><script type="application/json">${jsonForScript(ev)}</script></div>` : "";

const preview = (request: HttpRequestRecord, title: string) =>
  html`<div class="exchange-mount" data-title="${title}" data-preview="1"><script type="application/json">${jsonForScript({ request })}</script></div>`;

const jwtBox = (token: string | undefined, label: string) =>
  token ? html`<div class="jwt-mount" data-label="${label}" data-token="${token}"></div>` : "";

const kvTable = (rows: [string, unknown, string?][]) => html`
<table class="kv"><tbody>
${rows.map(([k, v, why]) => html`<tr><th scope="row">${k}</th><td><span class="mono">${String(v ?? "")}</span>${why ? html`<span class="why">${why}</span>` : ""}</td></tr>`)}
</tbody></table>`;

type Status = "done" | "current" | "todo" | "failed";

const stepCard = (o: { id: string; title: string; who: string; status: Status; body: Raw | string; actions?: Raw | string }) => html`
<section class="step ${o.status}" id="${o.id}" aria-label="${o.title}">
  <div class="step-head"><h3>${o.title}</h3><span class="step-who">${o.who}</span></div>
  <div class="step-body">${o.body}</div>
  ${o.actions ? html`<div class="step-actions">${o.actions}</div>` : ""}
</section>`;

/** Assigns done/current/todo: the first step that isn't done is "current". */
function statuses(done: boolean[], failed: boolean[] = []): Status[] {
  let currentSet = false;
  return done.map((d, i) => {
    if (failed[i]) {
      currentSet = true;
      return "failed";
    }
    if (d) return "done";
    if (!currentSet) {
      currentSet = true;
      return "current";
    }
    return "todo";
  });
}

const postButton = (action: string, label: string, opts: { primary?: boolean; variant?: string; fields?: Record<string, string>; disabled?: boolean } = {}) => html`
<form class="inline" method="post" action="${action}">
  ${Object.entries(opts.fields ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
  <button class="btn ${opts.variant ?? ""}" type="submit" ${opts.primary ? "data-primary" : ""} ${opts.disabled ? "disabled" : ""}>${label}</button>
</form>`;

const FLOWS: { key: string; href: string; label: string }[] = [
  { key: "authcode", href: "/client/authcode", label: "1 · Auth Code + PKCE + OIDC" },
  { key: "refresh", href: "/client/refresh", label: "2 · Refresh token" },
  { key: "m2m", href: "/client/m2m", label: "3 · Client Credentials" },
  { key: "failures", href: "/client/failures", label: "Failure lab" },
];

const flowNav = (active: string) => html`
<nav class="row section" aria-label="Flows" style="margin-bottom:var(--space-4)">
  ${FLOWS.map((f) => html`<a class="btn ${f.key === active ? "" : "btn-outline"}" href="${f.href}" ${f.key === active ? "aria-current=page" : ""}>${f.label}</a>`)}
  <span style="flex:1"></span>
  <a class="btn btn-dark-outline" href="/client/session.json" target="_blank">Client session JSON</a>
  ${postButton("/client/reset", "Reset", { variant: "btn-dark-outline" })}
</nav>`;

const inspectorTip = html`<div class="alert alert-info"><p><strong>Tip:</strong> open the <a href="/inspector" target="oauth-inspector">Inspector</a> in a second window next to this one. Every request below, including the redirects through your browser, shows up there live as a sequence diagram.</p></div>`;

const clientPage = (title: string, active: string, body: Raw, fab = false) =>
  page({ title, party: "client", body: html`${flowNav(active)}${body}`, scripts: ["/http-view.js", "/app.js"], fab });

// ---------------------------------------------------------------- home
export function homeView(_s: ClientSession, party: PartyKey = "client") {
  const parties = [
    { lane: "browser", name: "Browser", path: "you", text: "Carries the front-channel redirects and holds cookies. Never sees the client secret or the code_verifier." },
    { lane: "client", name: "Client App", path: "/client", text: `The app that wants access ("${WEB_CLIENT.name}"). It keeps tokens on its server, in its own session.` },
    { lane: "auth", name: "Authorization Server", path: "/auth", text: "Logs the user in, asks for consent, and issues signed tokens. Publishes its public keys at /auth/jwks." },
    { lane: "api", name: "Resource API", path: "/api", text: "Holds the protected data. Accepts only valid Bearer tokens that carry the right scope." },
  ];
  const flows = [
    { href: "/client/authcode", title: "Authorization Code + PKCE + OpenID Connect", text: "The main flow: redirect, login, consent, code, back-channel token exchange, ID token validation, /userinfo and an API call." },
    { href: "/client/refresh", title: "Refresh tokens", text: `Access tokens live ${TTL.accessToken} s. Watch one expire, get a 401, refresh it with rotation, then try a replay attack.` },
    { href: "/client/m2m", title: "Client Credentials", text: "Machine-to-machine: a service gets a token for itself. No user, no browser." },
    { href: "/client/failures", title: "Failure lab", text: "Forged state, an unregistered redirect_uri, a replayed code, a wrong secret, a tampered token… see the real error responses." },
  ];
  return page({
    title: party === "home" ? "Home" : "Client App",
    party,
    scripts: ["/app.js"],
    body: html`
<section class="feature-band">
  <p class="eyebrow" style="color:var(--text-white-soft)">OAuth 2.0 · OpenID Connect · PKCE</p>
  <h1 class="hero-title">See OAuth, one request at a time.</h1>
  <p class="lead">Four parties run in this app. You drive each step by hand, and every HTTP request between them (headers, bodies, redirects, tokens) is recorded and explained.</p>
  <div class="row">
    <a class="btn btn-lg btn-on-dark" href="/client/authcode">Start the guided flow</a>
    <a class="btn btn-lg btn-outline-on-dark" href="/inspector" target="oauth-inspector">Open the Inspector ↗</a>
  </div>
</section>

<section class="section">
  <h2>The four parties</h2>
  <div class="grid grid-4">
    ${parties.map((p) => html`<div class="card party-card lane-${p.lane}"><span class="party-tag">${p.name}</span><p class="mono small" style="margin-bottom:var(--space-2)">${p.path}</p><p class="small soft" style="margin:0">${p.text}</p></div>`)}
  </div>
</section>

<section class="section">
  <h2>Pick a flow</h2>
  <div class="grid grid-2">
    ${flows.map((f) => html`<a class="card card-link" href="${f.href}"><h3>${f.title}</h3><p class="small soft" style="margin:0">${f.text}</p></a>`)}
  </div>
</section>

<section class="section">
  <h2>Demo accounts</h2>
  <div class="card">
    ${kvTable([
      ...USERS.map((u) => [`user ${u.username}`, `${u.username} / ${u.password}`, `${u.name} · ${u.email}`] as [string, string, string]),
      [WEB_CLIENT.client_id, WEB_CLIENT.client_secret, `Confidential web client · redirect_uri ${WEB_CLIENT.redirect_uris[0]}`],
      [SERVICE_CLIENT.client_id, SERVICE_CLIENT.client_secret, "Machine-to-machine client (client_credentials, scope reports:read)"],
      ["issuer", ISSUER, `Discovery: ${ISSUER}/.well-known/openid-configuration`],
    ])}
  </div>
</section>`,
  });
}

// ---------------------------------------------------------------- flow 1
export function authcodeView(s: ClientSession) {
  const p = s.pkce;
  const cb = s.callback;
  const tokenOk = s.exchange?.response.status === 200 && !!s.tokens;
  const st = statuses(
    [!!p, !!cb, !!cb, !!cb && !cb.error, tokenOk, !!s.idCheck, !!s.userinfo, !!s.api],
    [false, false, false, !!cb?.error, !!s.exchange && !tokenOk, !!s.idCheck?.checks.some((c) => !c.ok), false, false],
  );

  const authParams: [string, string, string][] = p
    ? [
        ["response_type", "code", "We want an authorization code in the redirect, not tokens"],
        ["client_id", WEB_CLIENT.client_id, "Public identifier of this app"],
        ["redirect_uri", `${APP_ORIGIN}/client/callback`, "Where to send the user back. Must exactly match a registered URI"],
        ["scope", p.scope, "What we ask for. openid → ID token, offline_access → refresh token"],
        ["state", p.state, "Random. Must come back unchanged → CSRF protection"],
        ["nonce", p.nonce, "Random. Embedded in the ID token → ties the token to this login"],
        ["code_challenge", p.challenge, "SHA-256 hash of the code_verifier (PKCE)"],
        ["code_challenge_method", "S256", "How the challenge was computed"],
      ]
    : [];

  const body = html`
${inspectorTip}
${p?.variant === "bad-scope" ? html`<div class="alert alert-warn"><p>This run asks for the unknown scope <code>admin:all</code> (from the Failure lab). Expect an <code>invalid_scope</code> error at step 4.</p></div>` : ""}
<div class="steps">
${stepCard({
  id: "step-pkce",
  title: "Generate PKCE, state and nonce",
  who: "Client App · server side",
  status: st[0],
  body: p
    ? html`<p class="small">The client creates three random values and stores them in its session. The <strong>code_verifier</strong> stays secret; only its hash (the <strong>code_challenge</strong>) goes out now.</p>
      ${kvTable([
        ["code_verifier", p.verifier, "43 random characters. Kept secret on the client server until step 5"],
        ["code_challenge", p.challenge, "= BASE64URL( SHA256( code_verifier ) )"],
        ["state", p.state, "Anti-CSRF value, checked in step 4"],
        ["nonce", p.nonce, "Checked inside the ID token in step 6"],
      ])}`
    : html`<p class="small">Before redirecting anywhere, the client prepares one-time secrets for this login attempt: a PKCE <code>code_verifier</code> with its hashed <code>code_challenge</code>, a <code>state</code> and a <code>nonce</code>.</p>`,
  actions: postButton("/client/authcode/prepare", p ? "Regenerate (start over)" : "Generate values", { primary: !p, variant: p ? "btn-outline" : "" }),
})}
${stepCard({
  id: "step-authorize",
  title: "Send the browser to /authorize",
  who: "Client → Browser → Authorization Server · front channel",
  status: st[1],
  body: p
    ? html`<p class="small">The client answers with <code>302 Found</code> and this <code>Location</code>. Everything here is visible to the user and the browser, so nothing in it is secret.</p>
      <pre class="code">${s.authUrl ?? ""}</pre>
      ${kvTable(authParams)}`
    : html`<p class="small soft">Generate the values first.</p>`,
  actions: p ? html`<a class="btn" href="/client/start" ${st[1] === "current" ? "data-primary" : ""}>Redirect to the Authorization Server →</a>` : "",
})}
${stepCard({
  id: "step-login",
  title: "User signs in and gives consent",
  who: "Browser ↔ Authorization Server",
  status: st[2],
  body: html`<p class="small">This happens on the Authorization Server's own pages (the header turns into <em>"You are on: Authorization Server"</em>). The client never sees the password. Demo users: ${USERS.map((u, i) => html`${i ? ", " : ""}<code>${u.username} / ${u.password}</code>`)}.</p>
    <p class="small soft" style="margin:0">Behind the scenes: <code>GET /auth/authorize</code> → <code>302 /auth/login</code> → <code>POST /auth/login</code> (sets the <code>as_session</code> cookie) → <code>GET /auth/consent</code> → <code>POST /auth/consent</code> → <code>302</code> back to the client with a code.</p>`,
})}
${stepCard({
  id: "step-callback",
  title: "Receive the authorization code",
  who: "Authorization Server → Browser → Client · front channel",
  status: st[3],
  body: cb
    ? html`${cb.error ? html`<div class="alert alert-err"><p><strong>Rejected.</strong> ${cb.error}</p></div>` : html`<div class="alert alert-ok"><p>Code received and the response checks out.</p></div>`}
      <p class="small">The browser arrived at <code>/client/callback</code> with:</p>
      ${kvTable(Object.entries(cb.params).map(([k, v]) => [k, v, k === "code" ? `Single-use, valid ${TTL.authCode} s. Useless without the client secret + code_verifier` : k === "iss" ? "RFC 9207: which server issued this response" : undefined] as [string, string, string?]))}
      <table class="kv"><tbody>
        <tr><th>state check</th><td class="${cb.stateOk ? "check-ok" : "check-err"}">${cb.stateOk ? "matches the value in our session" : `expected "${p?.state ?? "(no flow started)"}"`}</td></tr>
        <tr><th>iss check</th><td class="${cb.issOk ? "check-ok" : "check-err"}">${cb.issOk ? ISSUER : `expected ${ISSUER}`}</td></tr>
      </tbody></table>`
    : html`<p class="small soft">After consent, the Authorization Server redirects the browser back here with <code>?code=…&amp;state=…&amp;iss=…</code>.</p>`,
  actions: cb?.error ? postButton("/client/authcode/prepare", "Start over", { primary: true }) : "",
})}
${stepCard({
  id: "step-token",
  title: "Exchange the code for tokens",
  who: "Client → Authorization Server · back channel",
  status: st[4],
  body: html`
    ${!s.exchange && s.tokenPreview ? html`<p class="small">Server-to-server, so the browser never sees this request. The client proves who it is with <strong>HTTP Basic</strong> (<code>base64(client_id:client_secret)</code>), and proves it started this flow by revealing the <strong>code_verifier</strong>. The server hashes it and compares the result with the code_challenge from step 2.</p>${preview(s.tokenPreview.request, "About to send")}` : ""}
    ${!s.tokenPreview && !s.exchange ? html`<p class="small soft">Needs a valid code from step 4.</p>` : ""}
    ${s.wrongVerifier ? exchange(s.wrongVerifier, "Attempt with a WRONG code_verifier") : ""}
    ${s.exchange ? exchange(s.exchange, "Token request") : ""}
    ${tokenOk ? html`
      <h3>What the client received</h3>
      ${jwtBox(s.tokens!.access_token, "access_token (JWT, meant for the API; the client should treat it as opaque)")}
      ${jwtBox(s.tokens!.id_token, "id_token (JWT, meant for the client: who logged in)")}
      ${s.tokens!.refresh_token ? html`<div><p class="jwt-part-title">refresh_token (opaque random string, not a JWT)</p><div class="jwt-raw">${s.tokens!.refresh_token}</div></div>` : ""}` : ""}`,
  actions:
    s.tokenPreview && !tokenOk
      ? html`${postButton("/client/authcode/exchange", "Send token request", { primary: st[4] === "current" || st[4] === "failed" })}
        ${postButton("/client/authcode/exchange", "Send with a wrong code_verifier", { variant: "btn-danger", fields: { wrong: "1" } })}`
      : "",
})}
${stepCard({
  id: "step-verify",
  title: "Validate the ID token",
  who: "Client (+ fetch JWKS from the Authorization Server)",
  status: st[5],
  body: s.idCheck
    ? html`${exchange(s.idCheck.jwks, "Fetch the public keys")}
      <table class="kv"><tbody>${s.idCheck.checks.map((c) => html`<tr><th>${c.name}</th><td class="${c.ok ? "check-ok" : "check-err"}">${c.detail}</td></tr>`)}</tbody></table>`
    : html`<p class="small">Never trust a token just because it arrived. The client downloads the server's public keys (JWKS), checks the RS256 signature, then checks <code>iss</code>, <code>aud</code>, <code>exp</code> and that <code>nonce</code> equals the value it generated in step 1.</p>`,
  actions: tokenOk && s.tokens?.id_token ? postButton("/client/authcode/verify", s.idCheck ? "Verify again" : "Fetch JWKS & verify", { primary: st[5] === "current", variant: s.idCheck ? "btn-outline" : "" }) : "",
})}
${stepCard({
  id: "step-userinfo",
  title: "Ask /userinfo who the user is",
  who: "Client → Authorization Server · Bearer token",
  status: st[6],
  body: s.userinfo ? exchange(s.userinfo, "UserInfo request") : html`<p class="small">OpenID Connect's UserInfo endpoint returns claims about the user for the scopes granted (<code>profile</code>, <code>email</code>). The access token goes in <code>Authorization: Bearer …</code>.</p>`,
  actions: tokenOk ? postButton("/client/authcode/userinfo", s.userinfo ? "Call again" : "Call /userinfo", { primary: st[6] === "current", variant: s.userinfo ? "btn-outline" : "" }) : "",
})}
${stepCard({
  id: "step-api",
  title: "Call the Resource API",
  who: "Client → Resource API (→ Authorization Server for JWKS)",
  status: st[7],
  body: html`${s.api ? exchange(s.api, "API request") : html`<p class="small">The API checks the token on its own: signature (using the JWKS, fetched once and cached for 60 s), <code>iss</code>, <code>aud = ${APP_ORIGIN}/api</code>, <code>exp</code>, and the <code>api:read</code> scope. In the Inspector you'll see the API's own JWKS request nested inside this call.</p>`}
    ${s.api ? html`<div class="alert alert-ok"><p>Flow complete. Next: <a href="/client/refresh">watch this access token expire and refresh it →</a></p></div>` : ""}`,
  actions: tokenOk ? postButton("/client/authcode/api", s.api ? "Call again" : "GET /api/profile", { primary: st[7] === "current", variant: s.api ? "btn-outline" : "" }) : "",
})}
</div>`;
  return clientPage("Authorization Code + PKCE", "authcode", body, true);
}

// ---------------------------------------------------------------- flow 2
export function refreshView(s: ClientSession) {
  const t = s.tokens;
  if (!t?.refresh_token) {
    return clientPage("Refresh token", "refresh", html`
<div class="card"><h1>Refresh tokens</h1>
<p>This flow needs the tokens from flow 1 (with the <code>offline_access</code> scope).</p>
<a class="btn" href="/client/authcode">Run the Authorization Code flow first →</a></div>`);
  }
  const log = s.refresh?.calls ?? [];
  const replayed = log.some((c) => c.label.startsWith("Attack"));
  const body = html`
${inspectorTip}
<div class="grid grid-2 section">
  <div class="card">
    <h3>Current access token</h3>
    <p class="small">Expires in <span class="countdown" data-expires="${t.expires_at}"></span> (lifetime ${TTL.accessToken} s, kept short on purpose).</p>
    ${jwtBox(t.access_token, "access_token")}
  </div>
  <div class="card">
    <h3>Current refresh token</h3>
    <p class="small">Opaque, long-lived (${TTL.refreshToken / 60} min), only ever sent to the Authorization Server. Each use <strong>rotates</strong> it: you get a new one and the old one dies.</p>
    <div class="jwt-raw">${t.refresh_token}</div>
    ${s.refresh?.oldRefreshToken ? html`<p class="small soft" style="margin:var(--space-2) 0 0">Previous (rotated-out) token: <span class="token-text">${s.refresh.oldRefreshToken}</span></p>` : ""}
  </div>
</div>

<div class="steps section">
${stepCard({ id: "r1", title: "Call the API with the access token", who: "Client → Resource API", status: "current", body: html`<p class="small">Before the countdown hits 0 → <code>200</code>. After it → <code>401</code> with <code>WWW-Authenticate: Bearer error="invalid_token", error_description="The access token expired"</code>.</p>`, actions: postButton("/client/refresh/call-api", "GET /api/profile", { primary: true }) })}
${stepCard({ id: "r2", title: "Use the refresh token", who: "Client → Authorization Server · back channel", status: "current", body: html`<p class="small"><code>grant_type=refresh_token</code> with client authentication. No user interaction and no browser. The response contains a new access token <em>and</em> a new refresh token.</p>`, actions: postButton("/client/refresh/refresh", "Refresh tokens") })}
${stepCard({
  id: "r3",
  title: "Attack: replay the old refresh token",
  who: "Attacker (pretending to be the client) → Authorization Server",
  status: s.refresh?.oldRefreshToken ? "current" : "todo",
  body: html`<p class="small">Pretend an attacker stole the refresh token we just rotated out. Presenting a used token is a sign of theft, so the server revokes the <strong>whole token family</strong>. Then try our newest refresh token: it's dead too, and the user has to sign in again.</p>`,
  actions: s.refresh?.oldRefreshToken
    ? html`${postButton("/client/refresh/replay", "Replay old refresh token", { variant: "btn-danger" })}${replayed ? postButton("/client/refresh/after-replay", "Now try the newest refresh token", { variant: "btn-danger" }) : ""}`
    : html`<span class="small soft">Refresh once first.</span>`,
})}
</div>

<section id="log" class="section">
  <div class="spread"><h2>Log</h2>${log.length ? postButton("/client/refresh/clear", "Clear log", { variant: "btn-dark-outline" }) : ""}</div>
  ${log.length ? html`<div class="stack">${[...log].reverse().map((c) => html`<div class="card card-tight">${exchange(c.event, c.label)}</div>`)}</div>` : html`<p class="soft small">Nothing yet. Every call above is listed here, newest first.</p>`}
</section>`;
  return clientPage("Refresh token", "refresh", body);
}

// ---------------------------------------------------------------- flow 3
export function m2mView(s: ClientSession) {
  const m = s.m2m;
  const tokenOk = m?.token?.response.status === 200 && !!m.access_token;
  const st = statuses([tokenOk, !!m?.reports, !!m?.profile]);
  const basic = Buffer.from(`${SERVICE_CLIENT.client_id}:${SERVICE_CLIENT.client_secret}`).toString("base64");
  const body = html`
${inspectorTip}
<div class="steps">
${stepCard({
  id: "step-m2m-token",
  title: "Get a token for the service itself",
  who: `${SERVICE_CLIENT.client_id} → Authorization Server · back channel`,
  status: st[0],
  body: html`<p class="small">No user and no browser: the service authenticates with its own credentials and asks for a scope.</p>
    ${kvTable([
      ["client_id:client_secret", `${SERVICE_CLIENT.client_id}:${SERVICE_CLIENT.client_secret}`],
      ["Authorization", `Basic ${basic}`, "base64 of the line above. Encoding, NOT encryption: only TLS keeps it secret"],
      ["body", "grant_type=client_credentials&scope=reports:read"],
    ])}
    ${exchange(m?.token, "Token request")}
    ${tokenOk ? jwtBox(m!.access_token, "access_token (sub = the client itself)") : ""}`,
  actions: postButton("/client/m2m/token", tokenOk ? "Request a new token" : "Request token", { primary: st[0] === "current", variant: tokenOk ? "btn-outline" : "" }),
})}
${stepCard({
  id: "step-m2m-api",
  title: "Call /api/reports",
  who: "Service → Resource API",
  status: st[1],
  body: html`${m?.reports ? exchange(m.reports, "API request") : html`<p class="small">Needs scope <code>reports:read</code>, which this token has.</p>`}`,
  actions: tokenOk ? postButton("/client/m2m/reports", "GET /api/reports", { primary: st[1] === "current" }) : "",
})}
${stepCard({
  id: "step-m2m-scope",
  title: "Try an endpoint it has no scope for",
  who: "Service → Resource API",
  status: st[2],
  body: html`${m?.profile ? exchange(m.profile, "API request") : html`<p class="small"><code>/api/profile</code> needs <code>api:read</code>. The token is valid, so this isn't a 401. It's a <code>403 insufficient_scope</code>.</p>`}`,
  actions: tokenOk ? postButton("/client/m2m/profile", "GET /api/profile", { primary: st[2] === "current" }) : "",
})}
</div>`;
  return clientPage("Client Credentials", "m2m", body, true);
}

// ---------------------------------------------------------------- failure lab
export function failuresView(s: ClientSession) {
  const f = s.failures ?? {};
  const badRedirect = `${ISSUER}/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: WEB_CLIENT.client_id,
    redirect_uri: "https://evil.example/steal",
    scope: "openid",
    state: "x",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
  })}`;
  const card = (key: string, title: string, text: Raw | string, action: Raw | string) => html`
<div class="card" id="fail-${key}">
  <h3>${title}</h3>
  <p class="small">${text}</p>
  <div class="row">${action}</div>
  ${f[key] ? html`<div style="margin-top:var(--space-3)">${exchange(f[key], "Result")}</div>` : ""}
</div>`;
  const body = html`
${inspectorTip}
<div class="grid grid-2 failure-grid">
${card("csrf", "Forged callback (CSRF / code injection)", html`An attacker sends you a link to the client's callback with their own code. The <code>state</code> doesn't match what this browser session started, so the client refuses. You'll land on step 4.`,
  html`<a class="btn btn-danger" href="/client/callback?code=attacker-code-123&state=forged-state">Open forged callback</a>`)}
${card("redirect", "Unregistered redirect_uri", html`The Authorization Server must never redirect to a URL that isn't registered, or codes would leak to the attacker. It shows an error page <em>instead of redirecting</em>.`,
  html`<a class="btn btn-danger" href="${badRedirect}">Try redirect_uri=evil.example</a>`)}
${card("scope", "Unknown scope", html`Asking for <code>admin:all</code>. The redirect_uri is valid, so the error comes back to the client as <code>?error=invalid_scope</code>.`,
  html`<a class="btn btn-danger" href="/client/start?variant=bad-scope">Start flow with admin:all</a>`)}
${card("pkce", "Wrong PKCE code_verifier", html`Simulates an attacker who intercepted the code but doesn't know the verifier. Go to step 5 of the main flow and use <em>"Send with a wrong code_verifier"</em>.`,
  html`<a class="btn btn-outline" href="/client/authcode#step-token">Go to step 5</a>`)}
${card("replay-code", "Replay an authorization code", html`Codes are single-use. Re-sending the code from the last successful exchange gives <code>invalid_grant</code>.`,
  s.usedCode ? postButton("/client/failures/replay-code", "Replay last code", { variant: "btn-danger" }) : html`<span class="small soft">Complete flow 1 first.</span>`)}
${card("bad-secret", "Wrong client secret", html`Token request with a bad <code>client_secret</code> → <code>401 invalid_client</code> with <code>WWW-Authenticate: Basic</code>.`,
  postButton("/client/failures/bad-secret", "Send bad secret", { variant: "btn-danger" }))}
${card("no-token", "API call without a token", html`No <code>Authorization</code> header → <code>401</code> with <code>WWW-Authenticate: Bearer realm="api"</code>.`,
  postButton("/client/failures/no-token", "GET /api/profile without token", { variant: "btn-danger" }))}
${card("forged-token", "Tampered access token", html`Takes a real token, adds <code>admin:all</code> to its payload and keeps the old signature. The API catches it: the signature no longer matches.`,
  s.tokens?.access_token || s.m2m?.access_token ? postButton("/client/failures/forged-token", "Send tampered token", { variant: "btn-danger" }) : html`<span class="small soft">Get a token first (flow 1 or 3).</span>`)}
${card("expired", "Expired token & refresh reuse", "Covered in flow 2: wait for the 60 s expiry, then replay a rotated refresh token.", html`<a class="btn btn-outline" href="/client/refresh">Go to flow 2</a>`)}
${card("insufficient", "Missing scope", "Covered in flow 3, step 3: a valid token without the needed scope gets 403 insufficient_scope.", html`<a class="btn btn-outline" href="/client/m2m#step-m2m-scope">Go to flow 3</a>`)}
</div>`;
  return clientPage("Failure lab", "failures", body);
}
