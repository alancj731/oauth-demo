// End-to-end smoke test. Plays the browser with plain fetch (manual redirects +
// cookie jar), runs every flow and failure case, and checks the Inspector recorded it.
//
//   npm run smoke                      # against http://localhost:3000
//   npm run smoke -- https://x.vercel.app

const BASE = (process.argv[2] ?? process.env.APP_ORIGIN ?? "http://localhost:3000").replace(/\/+$/, "");
const jar = new Map<string, string>();
let failures = 0;

function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${!ok && detail ? `  →  ${detail}` : ""}`);
}

async function http(method: string, path: string, opts: { form?: Record<string, string>; headers?: Record<string, string> } = {}) {
  const url = path.startsWith("http") ? path : BASE + path;
  const headers: Record<string, string> = { ...opts.headers };
  if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  let body: string | undefined;
  if (opts.form) {
    body = new URLSearchParams(opts.form).toString();
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  const res = await fetch(url, { method, headers, body, redirect: "manual" });
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    const k = pair.slice(0, i), v = pair.slice(i + 1);
    if (!v || /expires=thu, 01 jan 1970/i.test(c)) jar.delete(k);
    else jar.set(k, v);
  }
  const text = await res.text();
  return { status: res.status, location: res.headers.get("location") ?? "", headers: res.headers, text, json: () => JSON.parse(text) };
}

interface Ev { seq: number; request: { method: string; url: string; body?: string }; response: { status: number; body?: string }; channel: string; from: string; to: string }
async function events(): Promise<Ev[]> {
  return (await http("GET", "/inspector/events?since=0")).json().events;
}
const session = async () => (await http("GET", "/client/session.json")).json();

async function main() {
  console.log(`Smoke test against ${BASE}\n`);

  console.log("Discovery & keys");
  const disc = (await http("GET", "/auth/.well-known/openid-configuration")).json();
  check("discovery has token_endpoint", typeof disc.token_endpoint === "string", JSON.stringify(disc));
  const jwks = (await http("GET", "/auth/jwks")).json();
  check("jwks has an RSA key", jwks.keys?.[0]?.kty === "RSA" && !("d" in jwks.keys[0]));

  console.log("\nFlow 1: Authorization Code + PKCE + OIDC");
  check("client page loads", (await http("GET", "/client/authcode")).status === 200);
  await http("POST", "/inspector/clear");
  check("prepare → 303", (await http("POST", "/client/authcode/prepare")).status === 303);
  const start = await http("GET", "/client/start");
  check("start → 302 to /auth/authorize", start.status === 302 && start.location.includes("/auth/authorize?"), start.location);
  const authz = await http("GET", start.location);
  check("authorize → 302 to login", authz.status === 302 && authz.location.startsWith("/auth/login?req="), authz.location);
  const reqId = new URL(authz.location, BASE).searchParams.get("req")!;
  check("wrong password → 401", (await http("POST", "/auth/login", { form: { req: reqId, username: "alice", password: "nope" } })).status === 401);
  const login = await http("POST", "/auth/login", { form: { req: reqId, username: "alice", password: "alice123" } });
  check("login → 302 consent + as_session cookie", login.status === 302 && login.location.startsWith("/auth/consent") && jar.has("as_session"), login.location);
  check("consent page shows scopes", (await http("GET", login.location)).text.includes("offline_access"));
  const consent = await http("POST", "/auth/consent", { form: { req: reqId, decision: "allow" } });
  const cbUrl = new URL(consent.location);
  check("consent → 302 callback with code, state, iss", consent.status === 302 && !!cbUrl.searchParams.get("code") && !!cbUrl.searchParams.get("state") && !!cbUrl.searchParams.get("iss"), consent.location);
  check("callback → 302", (await http("GET", consent.location)).status === 302);
  let s = await session();
  check("state verified", s.callback?.stateOk === true && !s.callback.error, JSON.stringify(s.callback));
  await http("POST", "/client/authcode/exchange", { form: { wrong: "1" } });
  await http("POST", "/client/authcode/exchange");
  s = await session();
  check("tokens received (access, id, refresh)", !!s.tokens?.access_token && !!s.tokens?.id_token && !!s.tokens?.refresh_token, JSON.stringify(s.tokens));
  await http("POST", "/client/authcode/verify");
  await http("POST", "/client/authcode/userinfo");
  await http("POST", "/client/authcode/api");
  const page = (await http("GET", "/client/authcode")).text;
  check("ID token checks all pass", page.includes("check-ok") && !page.includes('class="check-err"'));

  let ev = await events();
  const tokenEvents = ev.filter((e) => e.request.url.endsWith("/auth/token"));
  check("wrong verifier → 400 invalid_grant (PKCE)", tokenEvents.some((e) => e.response.status === 400 && e.response.body?.includes("PKCE")));
  check("code exchange → 200 (back channel)", tokenEvents.some((e) => e.response.status === 200 && e.channel === "back" && e.from === "client"));
  check("userinfo → 200 with email", ev.some((e) => e.request.url.endsWith("/auth/userinfo") && e.response.status === 200 && e.response.body?.includes("alice@example.com")));
  check("API → 200", ev.some((e) => e.request.url.endsWith("/api/profile") && e.response.status === 200));
  if (ev.some((e) => e.from === "api" && e.request.url.endsWith("/auth/jwks"))) check("API fetched JWKS itself (api → auth)", true);
  else console.log("  · API used its cached JWKS (fetched < 60 s ago), so no new JWKS request this run");
  check("front-channel redirects recorded", ["/client/start", "/auth/authorize", "/auth/login", "/auth/consent", "/client/callback"].every((p) => ev.some((e) => e.channel === "front" && new URL(e.request.url).pathname === p)));
  check("recorded cookies hide the demo's lab_sid", ev.every((e) => !JSON.stringify(e.request).includes("lab_sid=")));

  console.log("\nFlow 2: Refresh token rotation");
  await http("POST", "/client/refresh/refresh");
  const s2 = await session();
  check("refresh → new refresh token", !!s2.tokens.refresh_token && s2.tokens.refresh_token !== s.tokens.refresh_token);
  await http("POST", "/client/refresh/call-api");
  await http("POST", "/client/refresh/replay");
  await http("POST", "/client/refresh/after-replay");
  ev = await events();
  const rt = ev.filter((e) => e.request.body?.includes("grant_type=refresh_token"));
  check("first refresh → 200", rt[0]?.response.status === 200);
  check("replayed old token → 400 reuse detected", rt[1]?.response.status === 400 && !!rt[1]?.response.body?.includes("reuse"));
  check("newest token after reuse → 400 family revoked", rt[2]?.response.status === 400 && !!rt[2]?.response.body?.includes("revoked"));

  console.log("\nFlow 3: Client Credentials");
  await http("POST", "/client/m2m/token");
  await http("POST", "/client/m2m/reports");
  await http("POST", "/client/m2m/profile");
  ev = await events();
  check("client_credentials → 200", ev.some((e) => e.request.body?.includes("grant_type=client_credentials") && e.response.status === 200));
  check("/api/reports → 200", ev.some((e) => e.request.url.endsWith("/api/reports") && e.response.status === 200));
  check("/api/profile with service token → 403", ev.some((e) => e.request.url.endsWith("/api/profile") && e.response.status === 403));
  const direct = await http("POST", "/auth/token", {
    headers: { authorization: "Basic " + Buffer.from("reports-service:svc-secret-456").toString("base64") },
    form: { grant_type: "client_credentials", scope: "reports:read" },
  });
  check("direct curl-style token request → 200, no-store", direct.status === 200 && !!direct.json().access_token && direct.headers.get("cache-control") === "no-store");

  console.log("\nFailure lab");
  for (const f of ["replay-code", "bad-secret", "no-token", "forged-token"]) await http("POST", `/client/failures/${f}`);
  ev = await events();
  const last = (pred: (e: Ev) => boolean) => [...ev].reverse().find(pred);
  check("replayed code → 400 invalid_grant", last((e) => !!e.request.body?.includes("grant_type=authorization_code"))?.response.status === 400);
  check("bad secret → 401 invalid_client", ev.some((e) => e.response.status === 401 && !!e.response.body?.includes("invalid_client")));
  check("no token → 401", ev.some((e) => e.request.url.endsWith("/api/profile") && e.response.status === 401 && !e.response.body?.includes("invalid_token")));
  check("tampered token → 401 invalid_token", ev.some((e) => e.response.status === 401 && !!e.response.body?.includes("signature")));
  const evil = await http("GET", `/auth/authorize?response_type=code&client_id=demo-web-app&redirect_uri=${encodeURIComponent("https://evil.example/steal")}&scope=openid&code_challenge=x&code_challenge_method=S256`);
  check("unregistered redirect_uri → 400 page, no redirect", evil.status === 400 && !evil.location);
  await http("GET", "/client/callback?code=attacker-code-123&state=forged-state");
  s = await session();
  check("forged callback rejected (state mismatch)", s.callback?.stateOk === false && !s.callback.params.code);
  const bad = await http("GET", "/client/start?variant=bad-scope");
  const badAuthz = await http("GET", bad.location);
  check("unknown scope → redirect with error=invalid_scope", badAuthz.status === 302 && badAuthz.location.includes("error=invalid_scope"), badAuthz.location);

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
