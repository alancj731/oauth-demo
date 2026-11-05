import { SCOPE_DESCRIPTIONS, USERS, type OAuthClient } from "../shared/config.js";
import { page } from "../shared/layout.js";
import { html } from "../shared/util.js";

export function loginView(opts: { reqId: string; client: OAuthClient; error?: string; username?: string }) {
  return page({
    title: "Sign in",
    party: "auth",
    scripts: ["/app.js"],
    body: html`
<div class="card card-center">
  <p class="eyebrow">Authorization Server · Sign in</p>
  <h1>Sign in to continue</h1>
  <p class="soft small"><strong>${opts.client.name}</strong> wants to access your account. You're typing your password into the <strong>Authorization Server</strong>, not into the client app. That's the whole point of OAuth.</p>
  ${opts.error ? html`<p class="form-error" role="alert">${opts.error}</p>` : ""}
  <div class="demo-users">
    Demo users:
    ${USERS.map((u, i) => html`${i ? " · " : " "}<button type="button" class="link-btn" data-fill-user="${u.username}" data-fill-pass="${u.password}">${u.username} / ${u.password}</button>`)}
  </div>
  <form method="post" action="/auth/login" autocomplete="off">
    <input type="hidden" name="req" value="${opts.reqId}">
    <div class="field ${opts.error ? "invalid" : ""}">
      <input id="username" name="username" placeholder=" " required value="${opts.username ?? ""}" autocapitalize="none">
      <label for="username">Username</label>
    </div>
    <div class="field ${opts.error ? "invalid" : ""}">
      <input id="password" name="password" type="password" placeholder=" " required>
      <label for="password">Password</label>
    </div>
    <button class="btn btn-lg" style="width:100%" type="submit" data-primary>Sign in</button>
  </form>
</div>`,
  });
}

export function consentView(opts: { reqId: string; client: OAuthClient; userName: string; scopes: string[] }) {
  return page({
    title: "Allow access?",
    party: "auth",
    scripts: ["/app.js"],
    body: html`
<div class="card card-center">
  <p class="eyebrow">Authorization Server · Consent</p>
  <h1>Allow ${opts.client.name}?</h1>
  <p class="soft small">Signed in as <strong>${opts.userName}</strong> · <a href="/auth/logout?return=${encodeURIComponent(`/auth/consent?req=${opts.reqId}`)}">not you?</a></p>
  <p class="small">The app is asking for these scopes:</p>
  <ul class="scope-list">
    ${opts.scopes.map((s) => html`<li><code>${s}</code><span class="small">${SCOPE_DESCRIPTIONS[s] ?? s}</span></li>`)}
  </ul>
  <form method="post" action="/auth/consent" class="row">
    <input type="hidden" name="req" value="${opts.reqId}">
    <button class="btn btn-lg" name="decision" value="allow" type="submit" data-primary>Allow</button>
    <button class="btn btn-lg btn-dark-outline" name="decision" value="deny" type="submit">Deny</button>
  </form>
</div>`,
  });
}

export function errorView(opts: { error: string; description: string }) {
  return page({
    title: "Authorization error",
    party: "auth",
    body: html`
<div class="card card-center">
  <p class="eyebrow">Authorization Server · Error</p>
  <h1 style="color:var(--red)">${opts.error}</h1>
  <p>${opts.description}</p>
  <p class="soft small">The server shows this page itself instead of redirecting. With an unknown client or an unregistered redirect_uri it can't safely send the user anywhere.</p>
  <a class="btn btn-outline" href="/client">Back to the Client App</a>
</div>`,
  });
}
