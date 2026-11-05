// The Inspector: a live sequence diagram of every recorded exchange for this visitor.
// It polls GET /inspector/events?since=<seq> (short requests suit serverless).

import { Router } from "express";
import { clearEvents, readEvents, sidOf } from "../shared/inspector.js";
import { page } from "../shared/layout.js";
import { html } from "../shared/util.js";

export const inspector = Router();

inspector.get("/", (_req, res) => {
  res.set("Cache-Control", "no-store").send(
    page({
      title: "Inspector",
      party: "inspector",
      wide: true,
      scripts: ["/http-view.js", "/inspector.js"],
      body: html`
<div class="insp-toolbar">
  <div class="spread">
    <div>
      <h1 style="margin:0">Live traffic</h1>
      <p class="small soft" style="margin:0">Every HTTP exchange between the parties for <em>your</em> browser session. Click an arrow for the raw request and response.</p>
    </div>
    <div class="row">
      <span class="pill pill-muted" id="insp-status" aria-live="polite">connecting…</span>
      <button class="btn btn-outline" type="button" id="insp-expand">Expand all</button>
      <button class="btn btn-dark-outline" type="button" id="insp-clear">Clear</button>
    </div>
  </div>
  <div class="insp-legend" style="margin-top:var(--space-2)">
    <span><span class="legend-line legend-front"></span>front channel (through the browser)</span>
    <span><span class="legend-line legend-back"></span>back channel (server to server)</span>
    <span><span class="legend-line legend-err"></span>error response</span>
  </div>
</div>
<div class="seq" id="seq">
  <div class="seq-lanes" role="presentation">
    <div class="seq-lane-head lane-browser"><span class="party-tag">Browser</span><small>you</small></div>
    <div class="seq-lane-head lane-client"><span class="party-tag">Client App</span><small>/client</small></div>
    <div class="seq-lane-head lane-auth"><span class="party-tag">Auth Server</span><small>/auth</small></div>
    <div class="seq-lane-head lane-api"><span class="party-tag">Resource API</span><small>/api</small></div>
  </div>
  <div class="seq-rows" id="seq-rows">
    <div class="seq-lifelines" aria-hidden="true"><div></div><div></div><div></div><div></div></div>
    <div class="seq-empty" id="seq-empty">No traffic yet. Start a flow in the <a href="/client/authcode">Client App</a> and the requests will appear here.</div>
  </div>
</div>`,
    }),
  );
});

inspector.get("/events", async (req, res) => {
  const since = Math.max(0, Number(req.query.since) || 0);
  res.set("Cache-Control", "no-store").json(await readEvents(sidOf(res), since));
});

inspector.post("/clear", async (_req, res) => {
  await clearEvents(sidOf(res));
  res.status(204).end();
});
