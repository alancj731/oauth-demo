// Traffic capture: the heart of the demo.
//
// - `traceIncoming(party)` records every request a party RECEIVES from the browser
//   (front channel), together with the response it sends back.
// - `tracedFetch(...)` is used for every server-to-server call (back channel). The
//   caller records request + response; the receiving side skips its own trace
//   (marked by the `x-lab-trace` header) so each hop is logged exactly once.
//
// Events are grouped per visitor by the `lab_sid` cookie (forwarded on back-channel
// calls as `x-lab-sid`), so on a public deployment every visitor sees only their
// own traffic.

import type { NextFunction, Request, Response } from "express";
import { APP_ORIGIN, IS_HTTPS, TTL } from "./config.js";
import { explain } from "./notes.js";
import { kv } from "./store.js";
import { randomId } from "./util.js";

export type Party = "browser" | "client" | "auth" | "api";
export const PARTY_NAMES: Record<Party, string> = {
  browser: "Browser",
  client: "Client App",
  auth: "Authorization Server",
  api: "Resource API",
};

export interface HttpRequestRecord {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  bodyType?: "form" | "json" | "text";
}

export interface HttpResponseRecord {
  status: number;
  headers: Record<string, string>;
  body?: string;
  bodyType?: "json" | "html" | "text";
  truncated?: boolean;
}

export interface TraceEvent {
  seq: number;
  id: string;
  from: Party;
  to: Party;
  channel: "front" | "back";
  tStart: number;
  tEnd: number;
  request: HttpRequestRecord;
  response: HttpResponseRecord;
  note?: string;
}

const MAX_EVENTS = 500;
const MAX_BODY = 20_000;
const HTML_PREVIEW = 1_200;
const SID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// Headers that are transport/browser/platform noise and hide the OAuth-relevant ones.
const DROP_HEADER = [
  /^x-vercel-/, /^x-forwarded-/, /^x-real-ip$/, /^x-matched-path$/, /^forwarded$/, /^x-lab-/,
  /^sec-/, /^upgrade-insecure-requests$/, /^priority$/, /^pragma$/, /^dnt$/, /^accept-language$/,
  /^accept-encoding$/, /^connection$/, /^keep-alive$/, /^traceparent$/, /^tracestate$/, /^baggage$/,
  /^date$/, /^etag$/, /^x-powered-by$/, /^transfer-encoding$/, /^if-none-match$/, /^cache-control$/,
  /^origin$/, /^referer$/, /^via$/, /^cdn-loop$/, /^cf-/, /^x-amz/, /^content-length$/,
];
const KEEP_CACHE_CONTROL = (dir: "req" | "res") => dir === "res"; // no-store on token responses matters

function cleanHeaders(input: Record<string, unknown>, dir: "req" | "res"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = rawName.toLowerCase();
    if (rawValue === undefined) continue;
    if (name === "cache-control" && KEEP_CACHE_CONTROL(dir)) {
      out[name] = String(rawValue);
      continue;
    }
    if (DROP_HEADER.some((re) => re.test(name))) continue;
    let value = Array.isArray(rawValue) ? rawValue.map(String) : [String(rawValue)];
    // Hide the demo's own bookkeeping cookie.
    if (name === "cookie") {
      value = [value.join("; ").split(/;\s*/).filter((c) => c && !c.startsWith("lab_sid=")).join("; ")];
    }
    if (name === "set-cookie") value = value.filter((c) => !c.startsWith("lab_sid="));
    value = value.filter(Boolean);
    if (value.length) out[name] = value.join(name === "set-cookie" ? "\n" : ", ");
  }
  return out;
}

function encodeRequestBody(req: Request): Pick<HttpRequestRecord, "body" | "bodyType"> {
  const body = req.body as unknown;
  if (!body || typeof body !== "object" || Object.keys(body).length === 0) return {};
  const ct = req.get("content-type") ?? "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    return { body: new URLSearchParams(body as Record<string, string>).toString(), bodyType: "form" };
  }
  return { body: JSON.stringify(body, null, 2), bodyType: "json" };
}

export function describeResponseBody(contentType: string, text: string): Pick<HttpResponseRecord, "body" | "bodyType" | "truncated"> {
  if (!text) return {};
  if (contentType.includes("json")) {
    try {
      return { body: JSON.stringify(JSON.parse(text), null, 2).slice(0, MAX_BODY), bodyType: "json" };
    } catch {
      /* fall through */
    }
  }
  if (contentType.includes("html")) {
    return { body: text.slice(0, HTML_PREVIEW), bodyType: "html", truncated: text.length > HTML_PREVIEW };
  }
  return { body: text.slice(0, MAX_BODY), bodyType: "text", truncated: text.length > MAX_BODY };
}

async function record(sid: string, ev: Omit<TraceEvent, "seq" | "note">): Promise<TraceEvent> {
  const full: TraceEvent = { ...ev, seq: 0 };
  full.note = explain(full);
  full.seq = await kv.incr(`eventseq:${sid}`, TTL.events);
  await kv.push(`events:${sid}`, full, MAX_EVENTS, TTL.events);
  return full;
}

export async function readEvents(sid: string, since: number) {
  const latest = (await kv.get<number>(`eventseq:${sid}`)) ?? 0;
  if (latest <= since) return { latest, events: [] as TraceEvent[] };
  const count = Math.min(latest - since, MAX_EVENTS) + 5;
  const events = (await kv.tail<TraceEvent>(`events:${sid}`, count)).filter((e) => e.seq > since);
  return { latest, events };
}

export const clearEvents = (sid: string) => kv.del(`events:${sid}`);

/** App-wide middleware: make sure each visitor has a `lab_sid` (or take it from a back-channel header). */
export function labSession(req: Request, res: Response, next: NextFunction) {
  const fromHeader = req.get("x-lab-sid");
  const fromCookie = req.cookies?.lab_sid as string | undefined;
  let sid = [fromHeader, fromCookie].find((s) => s && SID_RE.test(s));
  if (!sid) {
    sid = randomId(12);
    res.cookie("lab_sid", sid, { httpOnly: true, sameSite: "lax", secure: IS_HTTPS, path: "/", maxAge: TTL.events * 1000 });
  }
  res.locals.labSid = sid;
  next();
}

export const sidOf = (res: Response): string => res.locals.labSid as string;

const toBuffer = (chunk: unknown, encoding?: unknown) =>
  Buffer.isBuffer(chunk)
    ? chunk
    : typeof chunk === "string"
      ? Buffer.from(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8")
      : Buffer.from(chunk as Uint8Array);

/** Records browser → `to` requests and their responses (front channel). */
export function traceIncoming(to: Party) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.get("x-lab-trace")) return next(); // back-channel call: the caller records it
    const tStart = Date.now();
    const chunks: Buffer[] = [];
    const origWrite = res.write.bind(res) as (...a: unknown[]) => boolean;
    const origEnd = res.end.bind(res) as (...a: unknown[]) => Response;

    (res as unknown as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]) => {
      if (chunk) chunks.push(toBuffer(chunk, rest[0]));
      return origWrite(chunk, ...rest);
    };
    (res as unknown as { end: unknown }).end = (chunk?: unknown, encoding?: unknown, cb?: unknown) => {
      if (chunk && typeof chunk !== "function") chunks.push(toBuffer(chunk, encoding));
      const text = Buffer.concat(chunks).toString("utf8");
      const ev = {
        id: randomId(6),
        from: "browser" as Party,
        to,
        channel: "front" as const,
        tStart,
        tEnd: Date.now(),
        request: {
          method: req.method,
          url: APP_ORIGIN + req.originalUrl,
          headers: cleanHeaders(req.headers, "req"),
          ...encodeRequestBody(req),
        },
        response: {
          status: res.statusCode,
          headers: cleanHeaders(res.getHeaders(), "res"),
          ...describeResponseBody(String(res.getHeader("content-type") ?? ""), req.method === "HEAD" ? "" : text),
        },
      };
      // Write the event BEFORE finishing the response: on serverless platforms the
      // function may be frozen as soon as the response is sent.
      record(sidOf(res), ev)
        .catch((err) => console.error("[inspector] failed to record event", err))
        .finally(() => origEnd(chunk, encoding, cb));
      return res;
    };
    next();
  };
}

export interface TracedResponse {
  status: number;
  headers: Headers;
  text: string;
  json<T = Record<string, unknown>>(): T | null;
  event: TraceEvent;
}

/** fetch() for server-to-server calls; records the full exchange. */
export async function tracedFetch(opts: {
  sid: string;
  from: Party;
  to: Party;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  form?: Record<string, string>;
  json?: unknown;
}): Promise<TracedResponse> {
  const method = opts.method ?? (opts.form || opts.json ? "POST" : "GET");
  const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
  let body: string | undefined;
  let bodyType: HttpRequestRecord["bodyType"];
  if (opts.form) {
    body = new URLSearchParams(opts.form).toString();
    bodyType = "form";
    headers["content-type"] = "application/x-www-form-urlencoded";
  } else if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    bodyType = "json";
    headers["content-type"] = "application/json";
  }
  const tStart = Date.now();
  const res = await fetch(opts.url, {
    method,
    body,
    redirect: "manual",
    headers: { ...headers, "x-lab-trace": "1", "x-lab-sid": opts.sid },
  });
  const text = await res.text();
  const respHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => (respHeaders[k] = v));
  const setCookies = res.headers.getSetCookie?.() ?? [];
  if (setCookies.length) respHeaders["set-cookie"] = setCookies.join("\n");

  const event = await record(opts.sid, {
    id: randomId(6),
    from: opts.from,
    to: opts.to,
    channel: "back",
    tStart,
    tEnd: Date.now(),
    request: {
      method,
      url: opts.url,
      headers: { host: new URL(opts.url).host, ...cleanHeaders(headers, "req") },
      body: bodyType === "json" && body ? JSON.stringify(JSON.parse(body), null, 2) : body,
      bodyType,
    },
    response: {
      status: res.status,
      headers: cleanHeaders(respHeaders, "res"),
      ...describeResponseBody(res.headers.get("content-type") ?? "", text),
    },
  });

  return {
    status: res.status,
    headers: res.headers,
    text,
    json<T>() {
      try {
        return JSON.parse(text) as T;
      } catch {
        return null;
      }
    },
    event,
  };
}
