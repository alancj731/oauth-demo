// Shared HTML shell: House-Green header band naming the current party, cream canvas,
// House-Green footer. Styling lives in /theme.css (built from DESIGN.md tokens).

import { html, type Raw } from "./util.js";

/** Cache-busting suffix for static assets (new value per deploy / restart). */
const V = (process.env.VERCEL_GIT_COMMIT_SHA ?? Date.now().toString(36)).slice(0, 8);

export type PartyKey = "home" | "client" | "auth" | "api" | "inspector";

const PARTY_LABEL: Record<PartyKey, { name: string; path: string; blurb: string }> = {
  home: { name: "OAuth Flow Lab", path: "/", blurb: "Four parties, one origin. Every request is recorded." },
  client: { name: "Client App", path: "/client", blurb: "The app that wants access (the relying party)" },
  auth: { name: "Authorization Server", path: "/auth", blurb: "Logs the user in and issues tokens" },
  api: { name: "Resource API", path: "/api", blurb: "Holds the protected data" },
  inspector: { name: "Inspector", path: "/inspector", blurb: "Live record of every HTTP exchange" },
};

export function page(opts: {
  title: string;
  party: PartyKey;
  body: Raw;
  scripts?: string[];
  wide?: boolean;
  fab?: boolean;
}): string {
  const p = PARTY_LABEL[opts.party];
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title} · OAuth Flow Lab</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=JetBrains+Mono:wght@400;600&display=swap">
<link rel="stylesheet" href="/theme.css?v=${V}">
</head>
<body class="party-${opts.party}">
<header class="band band-top">
  <div class="band-inner">
    <a class="wordmark" href="/"><span class="wordmark-dot" aria-hidden="true"></span>OAuth Flow Lab</a>
    <div class="party-chip" title="${p.blurb}">
      <span class="party-chip-label">${opts.party === "home" ? "Start here" : "You are on"}</span>
      <span class="party-chip-name">${p.name}</span>
      <code class="party-chip-path">${p.path}</code>
    </div>
    <nav class="top-nav" aria-label="Main">
      <a href="/client" ${opts.party === "client" ? "aria-current=page" : ""}>Client</a>
      <a href="/inspector" target="oauth-inspector" ${opts.party === "inspector" ? "aria-current=page" : ""}>Inspector ↗</a>
    </nav>
  </div>
</header>
<main class="${opts.wide ? "container container-wide" : "container"}">
${opts.body}
</main>
<footer class="band band-bottom">
  <div class="band-inner">
    <p>Demo only. Users, clients and secrets are fake and shown on purpose so you can follow every value.</p>
    <p class="soft">OAuth 2.0 (RFC 6749) · PKCE (RFC 7636) · Bearer tokens (RFC 6750) · OpenID Connect Core 1.0</p>
  </div>
</footer>
${opts.fab ? html`<button class="fab" type="button" id="fab-next" aria-label="Do the next step" title="Next step"><svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M5 12h12m-5-6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` : ""}
${(opts.scripts ?? []).map((s) => html`<script src="${s}?v=${V}" defer></script>`)}
</body>
</html>`.value;
}
