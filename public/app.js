// Page helpers for the Client App and Authorization Server pages.
(function () {
  "use strict";

  // Draw embedded exchanges and JWTs.
  if (window.OFL) {
    document.querySelectorAll(".exchange-mount").forEach((m) => {
      const data = m.querySelector('script[type="application/json"]');
      if (!data) return;
      try {
        const ev = JSON.parse(data.textContent);
        m.replaceChildren(OFL.renderExchange(ev, { title: m.dataset.title || "", preview: m.dataset.preview === "1" }));
      } catch (e) {
        console.error("exchange render failed", e);
      }
    });
    document.querySelectorAll(".jwt-mount").forEach((m) => m.replaceChildren(OFL.renderJwt(m.dataset.token, m.dataset.label)));
  }

  // Demo-user quick fill on the login page.
  document.querySelectorAll("[data-fill-user]").forEach((b) =>
    b.addEventListener("click", () => {
      const u = document.getElementById("username");
      const p = document.getElementById("password");
      if (u && p) {
        u.value = b.dataset.fillUser;
        p.value = b.dataset.fillPass;
        p.focus();
      }
    }),
  );

  // Floating "next step" button: triggers the current step's primary action.
  const fab = document.getElementById("fab-next");
  if (fab) {
    const target = () => document.querySelector(".step.current [data-primary], .step.failed [data-primary]");
    if (!target()) fab.hidden = true;
    fab.addEventListener("click", () => {
      const t = target();
      if (!t) return;
      t.closest(".step")?.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => t.click(), 250);
    });
  }

  // Countdowns (access-token expiry).
  const counters = [...document.querySelectorAll(".countdown[data-expires]")];
  if (counters.length) {
    const tick = () =>
      counters.forEach((c) => {
        const left = Math.round((Number(c.dataset.expires) - Date.now()) / 1000);
        c.textContent = left > 0 ? `${left}s` : "expired";
        c.classList.toggle("expired", left <= 0);
      });
    tick();
    setInterval(tick, 1000);
  }
})();
