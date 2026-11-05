// Shared renderer for recorded HTTP exchanges and JWTs.
// Used by the Client App pages and the Inspector. Builds DOM nodes only (no innerHTML),
// so recorded bodies are always shown as text.
(function () {
  "use strict";

  const PARTY = { browser: "Browser", client: "Client App", auth: "Authorization Server", api: "Resource API" };
  const STATUS_TEXT = {
    200: "OK", 201: "Created", 204: "No Content", 302: "Found", 303: "See Other", 304: "Not Modified",
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 500: "Internal Server Error",
  };
  const JWT_RE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
  const TIME_CLAIMS = ["exp", "iat", "nbf", "auth_time"];

  function el(tag, attrs, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return n;
  }

  const statusClass = (s) => (s >= 400 ? "err" : s >= 300 ? "redirect" : "ok");
  const statusLine = (s) => `${s} ${STATUS_TEXT[s] || ""}`.trim();
  const titleCase = (h) => h.replace(/(^|-)([a-z])/g, (_, d, c) => d + c.toUpperCase()).replace(/^Www/, "WWW");

  function b64urlDecode(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  function decodeJwt(token) {
    try {
      const [h, p, sig] = token.split(".");
      return { header: JSON.parse(b64urlDecode(h)), payload: JSON.parse(b64urlDecode(p)), parts: [h, p, sig] };
    } catch {
      return null;
    }
  }

  function relTime(sec) {
    const d = Math.round(sec - Date.now() / 1000);
    const abs = Math.abs(d);
    const txt = abs < 90 ? `${abs}s` : abs < 5400 ? `${Math.round(abs / 60)}m` : `${Math.round(abs / 3600)}h`;
    return d >= 0 ? `in ${txt}` : `${txt} ago`;
  }

  /** Pretty JSON with human-readable times next to time claims. */
  function claimsPre(obj) {
    const pre = el("pre", { class: "code" });
    const lines = JSON.stringify(obj, null, 2).split("\n");
    for (const line of lines) {
      const m = line.match(/^\s*"(\w+)": (\d+),?$/);
      pre.append(line);
      if (m && TIME_CLAIMS.includes(m[1])) {
        const t = Number(m[2]);
        pre.append(el("span", { class: "claim-time", text: `  // ${new Date(t * 1000).toLocaleTimeString()} (${relTime(t)})` }));
      }
      pre.append("\n");
    }
    return pre;
  }

  function renderJwt(token, label) {
    const d = decodeJwt(token);
    const box = el("div", { class: "jwt" });
    if (label) box.append(el("p", { class: "jwt-part-title", text: label, style: "margin:0" }));
    if (!d) {
      box.append(el("div", { class: "jwt-raw", text: token }));
      return box;
    }
    box.append(
      el("div", { class: "jwt-raw" },
        el("span", { class: "jwt-h", text: d.parts[0] }), ".",
        el("span", { class: "jwt-p", text: d.parts[1] }), ".",
        el("span", { class: "jwt-s", text: d.parts[2] }),
      ),
      el("div", { class: "jwt-parts" },
        el("div", { class: "jwt-part" }, el("p", { class: "jwt-part-title jwt-h", text: "Header" }), claimsPre(d.header)),
        el("div", { class: "jwt-part" }, el("p", { class: "jwt-part-title jwt-p", text: "Payload (claims)" }), claimsPre(d.payload)),
      ),
      el("p", { class: "micro soft", style: "margin:0", text: "Signature: RS256 over base64url(header) + \".\" + base64url(payload). Anyone can decode a JWT; only the signature proves who made it." }),
    );
    return box;
  }

  function paramsTable(title, params) {
    const entries = [...params.entries()];
    if (!entries.length) return null;
    return el("div", {},
      el("p", { class: "http-decoded-title", text: title }),
      el("table", { class: "kv" }, el("tbody", {}, entries.map(([k, v]) => el("tr", {}, el("th", { text: k }), el("td", { class: "mono", text: v }))))),
    );
  }

  function jwtsIn(text) {
    const found = [];
    try {
      const obj = JSON.parse(text);
      for (const [k, v] of Object.entries(obj)) if (typeof v === "string" && JWT_RE.test(v)) found.push([k, v]);
    } catch { /* not JSON */ }
    return found;
  }

  function renderMessage(kind, ev, opts) {
    const isReq = kind === "request";
    const msg = isReq ? ev.request : ev.response;
    const raw = el("pre", { class: "http-raw" });
    let url;
    try { url = new URL(ev.request.url); } catch { url = null; }

    if (isReq) {
      raw.append(el("span", { class: "h-start", text: `${msg.method} ${url ? url.pathname + url.search : msg.url} HTTP/1.1` }), "\n");
      const host = msg.headers.host || (url && url.host);
      if (host) raw.append(el("span", { class: "h-name", text: "Host" }), `: ${host}\n`);
    } else {
      raw.append(el("span", { class: `h-start h-status-${statusClass(msg.status)}`, text: `HTTP/1.1 ${statusLine(msg.status)}` }), "\n");
    }
    for (const [k, v] of Object.entries(msg.headers || {})) {
      if (k === "host") continue;
      for (const line of String(v).split("\n")) raw.append(el("span", { class: "h-name", text: titleCase(k) }), `: ${line}\n`);
    }
    if (msg.body) {
      raw.append("\n", el("span", { class: "h-body", text: msg.body }));
      if (msg.truncated) raw.append(el("span", { class: "h-trunc", text: msg.bodyType === "html" ? "\n… (HTML page, truncated)" : "\n… (truncated)" }));
    }

    const decoded = el("div", { class: "http-decoded" });
    if (isReq && url && url.search) decoded.append(paramsTable("Query parameters", url.searchParams) || "");
    if (isReq && msg.bodyType === "form" && msg.body) decoded.append(paramsTable("Form body", new URLSearchParams(msg.body)) || "");
    const auth = msg.headers && msg.headers.authorization;
    if (isReq && auth && auth.startsWith("Basic ")) {
      try { decoded.append(el("p", { class: "micro soft", text: `Authorization: Basic decodes to "${atob(auth.slice(6))}" (client_id:client_secret)` })); } catch { /* ignore */ }
    }
    if (isReq && auth && auth.startsWith("Bearer ") && JWT_RE.test(auth.slice(7)) && opts.jwts) {
      decoded.append(el("p", { class: "http-decoded-title", text: "Bearer token" }), renderJwt(auth.slice(7)));
    }
    if (!isReq && msg.headers && msg.headers.location) {
      try {
        const loc = new URL(msg.headers.location, ev.request.url);
        decoded.append(paramsTable(`Redirect to ${loc.origin === location.origin ? loc.pathname : loc.origin + loc.pathname}`, loc.searchParams) || el("p", { class: "micro soft", text: `Redirects the browser to ${loc.pathname}` }));
      } catch { /* ignore */ }
    }
    if (!isReq && msg.bodyType === "json" && opts.jwts) {
      for (const [k, v] of jwtsIn(msg.body)) decoded.append(el("p", { class: "http-decoded-title", text: `${k} (decoded)` }), renderJwt(v));
    }

    const from = isReq ? ev.from : ev.to;
    const to = isReq ? ev.to : ev.from;
    return el("div", { class: "http-msg" },
      el("div", { class: "http-msg-head" },
        ev.channel ? el("span", { class: `pill pill-${ev.channel}`, text: ev.channel === "front" ? "front channel" : "back channel" }) : null,
        el("span", { text: `${PARTY[from] || from} → ${PARTY[to] || to}` }),
        el("span", { class: "dir", text: isReq ? (opts.preview ? "request (not sent yet)" : "request") : `response · ${ev.tEnd - ev.tStart} ms` }),
      ),
      raw,
      decoded.childNodes.length ? decoded : null,
    );
  }

  /** Full exchange: optional note, request, response. */
  function renderExchange(ev, opts) {
    opts = Object.assign({ jwts: true }, opts || {});
    if (opts.preview) ev = Object.assign({ from: "client", to: "auth", channel: "back" }, ev);
    const wrap = el("div", { class: "exchange" });
    if (opts.title) wrap.append(el("p", { class: "jwt-part-title", text: opts.title, style: "margin:0 0 6px" }));
    if (ev.note && opts.note !== false) wrap.append(el("div", { class: "note", text: ev.note, style: "margin-bottom:8px" }));
    const http = el("div", { class: "http" }, renderMessage("request", ev, opts));
    if (ev.response) http.append(renderMessage("response", ev, opts));
    wrap.append(http);
    return wrap;
  }

  window.OFL = { el, renderExchange, renderJwt, decodeJwt, statusClass, statusLine, PARTY };
})();
