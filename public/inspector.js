// Inspector: polls /inspector/events and draws a sequence diagram.
// Each recorded exchange becomes two arrows: the request (at its start time)
// and the response (at its end time), so nested calls line up naturally.
(function () {
  "use strict";
  const { el, renderExchange, statusClass, statusLine } = window.OFL;

  const LANE = { browser: 0, client: 1, auth: 2, api: 3 };
  const POLL_MS = 1000;
  const rowsEl = document.getElementById("seq-rows");
  const emptyEl = document.getElementById("seq-empty");
  const statusEl = document.getElementById("insp-status");
  const expandBtn = document.getElementById("insp-expand");

  const events = new Map(); // seq -> event
  const open = new Set(); // event ids with details shown
  let since = 0;
  let expandAll = false;
  let timer;

  function shortPath(u) {
    try {
      const url = new URL(u, location.href);
      const q = url.search.length > 40 ? url.search.slice(0, 38) + "…" : url.search;
      return (url.origin === location.origin ? url.pathname : url.host + url.pathname) + q;
    } catch {
      return u;
    }
  }

  function responseLabel(ev) {
    const r = ev.response;
    const st = el("span", { class: `st-${statusClass(r.status)}`, text: statusLine(r.status) });
    let extra = "";
    if (r.headers.location) extra = ` → ${shortPath(r.headers.location)}`;
    else if (r.bodyType === "json") {
      try {
        const keys = Object.keys(JSON.parse(r.body));
        extra = ` {${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", …" : ""}}`;
      } catch { /* ignore */ }
    } else if (r.bodyType === "html") extra = " · HTML page";
    return [st, extra];
  }

  function arrowRow(ev, kind, n) {
    const isReq = kind === "req";
    const a = LANE[isReq ? ev.from : ev.to];
    const b = LANE[isReq ? ev.to : ev.from];
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const err = !isReq && ev.response.status >= 400;
    const label = isReq
      ? [el("span", { class: "method", text: ev.request.method }), " ", shortPath(ev.request.url)]
      : responseLabel(ev);
    const fullTitle = isReq ? `${ev.request.method} ${ev.request.url}` : `${statusLine(ev.response.status)}${ev.response.headers.location ? " → " + ev.response.headers.location : ""}`;
    const row = el("div", {
      class: `seq-row${open.has(ev.id) || expandAll ? " active" : ""}`,
      role: "button",
      tabindex: "0",
      "aria-expanded": String(open.has(ev.id) || expandAll),
      title: fullTitle,
      onclick: () => toggle(ev.id),
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle(ev.id);
        }
      },
    },
      isReq ? el("span", { class: "seq-num", text: `#${n}` }) : null,
      el("span", { class: "seq-label", style: `left:${((lo + hi) / 2 + 0.5) * 25}%;max-width:${Math.max(hi - lo, 1) * 25 + 10}%` }, label),
      el("span", {
        class: `seq-arrow ${ev.channel}${err ? " err" : ""} ${b > a ? "ltr" : "rtl"}`,
        style: `left:${(lo + 0.5) * 25}%;width:${(hi - lo) * 25}%`,
      }),
    );
    return row;
  }

  function render() {
    const list = [...events.values()];
    rowsEl.querySelectorAll(".seq-row, .seq-detail").forEach((n) => n.remove());
    emptyEl.hidden = list.length > 0;
    const numbers = new Map(list.sort((x, y) => x.seq - y.seq).map((e, i) => [e.id, i + 1]));
    const arrows = [];
    for (const ev of list) {
      arrows.push({ t: ev.tStart, seq: ev.seq, k: 0, ev, kind: "req" });
      arrows.push({ t: ev.tEnd, seq: ev.seq, k: 1, ev, kind: "res" });
    }
    arrows.sort((x, y) => x.t - y.t || x.k - y.k || x.seq - y.seq);
    const frag = document.createDocumentFragment();
    for (const a of arrows) {
      frag.append(arrowRow(a.ev, a.kind, numbers.get(a.ev.id)));
      if (a.kind === "res" && (open.has(a.ev.id) || expandAll)) {
        frag.append(el("div", { class: "seq-detail" }, renderExchange(a.ev, { title: `#${numbers.get(a.ev.id)} · ${a.ev.request.method} ${shortPath(a.ev.request.url)}` })));
      }
    }
    rowsEl.append(frag);
  }

  function toggle(id) {
    open.has(id) ? open.delete(id) : open.add(id);
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  }

  const nearBottom = () => window.innerHeight + window.scrollY > document.body.scrollHeight - 200;

  async function poll() {
    clearTimeout(timer);
    try {
      const res = await fetch(`/inspector/events?since=${since}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      if (data.latest < since) since = 0; // store was reset
      if (data.events.length) {
        const stick = nearBottom();
        for (const ev of data.events) events.set(ev.seq, ev);
        since = Math.max(since, ...data.events.map((e) => e.seq));
        render();
        if (stick) window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
      }
      statusEl.textContent = `live · ${events.size} exchange${events.size === 1 ? "" : "s"}`;
      statusEl.className = "pill pill-ok";
    } catch (e) {
      statusEl.textContent = "offline, retrying…";
      statusEl.className = "pill pill-err";
    }
    if (!document.hidden) timer = setTimeout(poll, POLL_MS);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearTimeout(timer);
      statusEl.textContent = "paused (tab hidden)";
      statusEl.className = "pill pill-muted";
    } else poll();
  });

  document.getElementById("insp-clear").addEventListener("click", async () => {
    await fetch("/inspector/clear", { method: "POST" });
    events.clear();
    open.clear();
    render();
  });

  expandBtn.addEventListener("click", () => {
    expandAll = !expandAll;
    if (!expandAll) open.clear();
    expandBtn.textContent = expandAll ? "Collapse all" : "Expand all";
    render();
  });

  poll();
})();
